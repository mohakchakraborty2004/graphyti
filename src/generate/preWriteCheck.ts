import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { extractPrismaSchemaFromSource, type PrismaExtractResult } from "../extract/prismaExtractor";
import type { ModelField } from "../extract/types";
import {
  computeBlastRadius,
  formatBlastRadius,
  blastRadiusPromptSection,
  type BlastRadiusResult,
} from "../graph/blastRadius";
import { success, error, warn, info, sym, bold } from "../cli/theme";
import { createLogger } from "../utils/logger";

const log = createLogger("prewrite");

// ---------------------------------------------------------------------------
// Public-facing types
// ---------------------------------------------------------------------------

export interface CodeGenItem {
  type: string;
  directory: string;
  fileName: string;
  content: string;
  command: string;
  description: string;
}

export interface PreWriteCheckResult {
  blastResults: BlastRadiusResult[];
  promptInjection: string;
  confirmed: boolean;
  /**
   * Breaking field names per blast result, index-aligned with blastResults[].
   * Each entry contains only the field names that changed for that specific model,
   * so the verifier can check each model's blast radius independently without
   * false-positives from other models' unchanged fields.
   */
  breakingFieldNamesPerModel: string[][];
}

// ---------------------------------------------------------------------------
// Schema diff types
// ---------------------------------------------------------------------------

type ChangeKind = "ADDITIVE" | "BREAKING";

interface FieldChange {
  modelName: string;
  fieldName: string;
  kind: ChangeKind;
  detail: string;
}

interface SchemaDiff {
  breaking: FieldChange[];
  additive: FieldChange[];
  /** Model ids for every model that has at least one BREAKING change */
  affectedModelIds: string[];
}

// ---------------------------------------------------------------------------
// Sanity check — catch malformed/truncated LLM output before diffing
// ---------------------------------------------------------------------------

/**
 * A generated schema is plausible only if it has at least as many models as
 * the one on disk. Fewer models means the LLM produced a truncated or
 * malformed schema — treat this as a parse failure.
 *
 * Relaxed: we still run the diff even when models are equal count (the common
 * rename case). Only bail on gross truncation (< old count).
 */
function isPlausibleNewSchema(
  oldParsed: PrismaExtractResult,
  newParsed: PrismaExtractResult
): boolean {
  return newParsed.models.length >= oldParsed.models.length;
}

// ---------------------------------------------------------------------------
// Bidirectional field-level diff
//
// For each model we compute three sets:
//   addedFields   — present in new, absent from old  (ADDITIVE)
//   removedFields — present in old, absent from new  (BREAKING)
//   typeChanges   — present in both, type differs    (BREAKING)
//
// When removedFields is non-empty we treat the entire model as BREAKING
// regardless of what was added at the same time, because removals are
// what consumers break on. This catches renames (old gone + new present).
// ---------------------------------------------------------------------------

interface FieldDiffResult {
  breaking: FieldChange[];
  additive: FieldChange[];
}

function diffPrismaFields(
  modelName: string,
  before: ModelField[],
  after: ModelField[]
): FieldDiffResult {
  const breaking: FieldChange[] = [];
  const additive: FieldChange[] = [];

  const beforeMap = new Map(before.map((f) => [f.fieldName, f]));
  const afterMap  = new Map(after.map((f)  => [f.fieldName, f]));

  // ── 1. Removed fields (BREAKING) ──────────────────────────────────────
  // Fields in old but not in new. This is the primary breaking signal —
  // any consumer referencing the old field name will break.
  for (const [name, bf] of beforeMap) {
    if (!afterMap.has(name)) {
      breaking.push({
        modelName,
        fieldName: name,
        kind: "BREAKING",
        detail: "removed",
      });
    }
  }

  // ── 2. Added fields (ADDITIVE) ────────────────────────────────────────
  // Fields in new but not in old. Additive by themselves, but when
  // combined with removals in the same model it signals a rename.
  for (const [name, af] of afterMap) {
    if (!beforeMap.has(name)) {
      additive.push({
        modelName,
        fieldName: name,
        kind: "ADDITIVE",
        detail: "added",
      });
    }
  }

  // ── 3. Type changes on existing fields (BREAKING) ─────────────────────
  for (const [name, bf] of beforeMap) {
    const af = afterMap.get(name);
    if (!af) continue; // already recorded as removed above
    if (bf.type !== af.type) {
      breaking.push({
        modelName,
        fieldName: name,
        kind: "BREAKING",
        detail: `type ${bf.type} → ${af.type}`,
      });
    }
  }

  return { breaking, additive };
}

// ---------------------------------------------------------------------------
// Schema-level diff: read old from disk, parse new from the pending content
// ---------------------------------------------------------------------------

function diffSchema(item: CodeGenItem, projectRoot: string): SchemaDiff | null {
  const fullPath = path.join(item.directory, item.fileName);
  const absPath = path.isAbsolute(fullPath)
    ? fullPath
    : path.resolve(projectRoot, fullPath);

  const relPath = path.relative(projectRoot, absPath).replace(/\\/g, "/");

  // Net-new file — nothing to compare against
  if (!fs.existsSync(absPath)) {
    log.debug(`${relPath}: net-new schema.prisma — nothing to diff against`);
    return null;
  }

  const oldSource = fs.readFileSync(absPath, "utf-8");
  // CodeGenItem.content may use literal \n sequences from the JSON schema response
  const newSource = item.content.replace(/\\n/g, "\n");

  const oldParsed = extractPrismaSchemaFromSource(oldSource, relPath);
  const newParsed = extractPrismaSchemaFromSource(newSource, relPath);

  // If the generated schema has fewer models than what's on disk, the LLM
  // almost certainly produced a truncated or malformed file. Bail out early
  // so we don't misinterpret every missing model's fields as "removed".
  if (!isPlausibleNewSchema(oldParsed, newParsed)) {
    log.warn(
      `${relPath}: ${newParsed.models.length} generated model(s) vs ${oldParsed.models.length} on disk — ` +
        `skipping diff to avoid a false blast radius`
    );
    console.warn(
      `  ${warn("!")} Generated schema has fewer models than current ` +
      `(${newParsed.models.length} vs ${oldParsed.models.length}) — ` +
      `looks malformed or truncated, skipping diff to avoid false blast-radius`
    );
    return null;
  }

  // Index fields by model name
  const oldFieldsByModel = new Map<string, ModelField[]>();
  for (const f of oldParsed.fields) {
    const list = oldFieldsByModel.get(f.modelName) ?? [];
    list.push(f);
    oldFieldsByModel.set(f.modelName, list);
  }
  const newFieldsByModel = new Map<string, ModelField[]>();
  for (const f of newParsed.fields) {
    const list = newFieldsByModel.get(f.modelName) ?? [];
    list.push(f);
    newFieldsByModel.set(f.modelName, list);
  }

  // All model names appearing in either version
  const allModels = new Set([
    ...oldParsed.models.map((m) => m.name),
    ...newParsed.models.map((m) => m.name),
  ]);

  const allBreaking: FieldChange[] = [];
  const allAdditive: FieldChange[] = [];

  for (const modelName of allModels) {
    const before = oldFieldsByModel.get(modelName) ?? [];
    const after  = newFieldsByModel.get(modelName) ?? [];
    const { breaking, additive } = diffPrismaFields(modelName, before, after);
    allBreaking.push(...breaking);
    allAdditive.push(...additive);
  }

  // Collect model ids for models that have at least one breaking change
  const breakingModels = new Set(allBreaking.map((c) => c.modelName));
  const affectedModelIds = [...breakingModels].map((name) => `model:${name}`);

  log.debug(
    `${relPath}: ${allBreaking.length} breaking, ${allAdditive.length} additive ` +
      `across ${allModels.size} model(s); ${affectedModelIds.length} model(s) gated`
  );

  return { breaking: allBreaking, additive: allAdditive, affectedModelIds };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectSchemaDiffs(
  items: CodeGenItem[],
  projectRoot: string
): { diffs: SchemaDiff[]; truncated: boolean } {
  const diffs: SchemaDiff[] = [];
  let truncated = false;

  for (const item of items) {
    if (item.type !== "file") continue;
    if (item.fileName !== "schema.prisma") continue;

    const diff = diffSchema(item, projectRoot);
    if (diff !== null) {
      diffs.push(diff);
    } else {
      // Check if this was a truncation (existing file with fewer models)
      const fullPath = path.join(item.directory, item.fileName);
      const absPath = path.isAbsolute(fullPath)
        ? fullPath
        : path.resolve(projectRoot, fullPath);
      if (fs.existsSync(absPath)) {
        const oldSource = fs.readFileSync(absPath, "utf-8");
        const newSource = item.content.replace(/\\n/g, "\n");
        const relPath = path.relative(projectRoot, absPath).replace(/\\/g, "/");
        const oldParsed = extractPrismaSchemaFromSource(oldSource, relPath);
        const newParsed = extractPrismaSchemaFromSource(newSource, relPath);
        if (!isPlausibleNewSchema(oldParsed, newParsed)) {
          truncated = true;
        }
      }
      // null also means net-new file — no diff to record
    }
  }

  log.debug(`collected ${diffs.length} schema diff(s)${truncated ? "; truncation detected" : ""}`);

  return { diffs, truncated };
}

function askConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith("y"));
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function preWriteCheck(
  items: CodeGenItem[],
  yes: boolean,
  dryRun: boolean,
  projectRoot: string = process.cwd(),
  onBeforeConfirm?: () => void
): Promise<PreWriteCheckResult> {

  // -------------------------------------------------------------------------
  // 1. Diff every schema.prisma write against what's on disk
  // -------------------------------------------------------------------------
  const { diffs, truncated } = collectSchemaDiffs(items, projectRoot);

  if (truncated) {
    log.error("generated schema looks truncated — aborting before any write");
    console.error(
      `\n  ${error("✗")} Generated schema has fewer models than current — ` +
      `looks truncated or malformed. Aborting to prevent data loss.\n` +
      `  Re-run with a more specific prompt or fix the schema manually.`
    );
    return { blastResults: [], promptInjection: "", confirmed: false, breakingFieldNamesPerModel: [] };
  }

  if (diffs.length === 0) {
    // No schema writes, or all schema writes are net-new files
    log.debug("no schema.prisma diff to check — write approved without gating");
    return { blastResults: [], promptInjection: "", confirmed: true, breakingFieldNamesPerModel: [] };
  }

  // Flatten across all schema files (usually just one)
  const allBreaking: FieldChange[] = diffs.flatMap((d) => d.breaking);
  const allAdditive: FieldChange[] = diffs.flatMap((d) => d.additive);
  const breakingModelIds = [...new Set(diffs.flatMap((d) => d.affectedModelIds))];

  log.debug(
    `${allBreaking.length} breaking field(s) in ${breakingModelIds.length} model(s), ` +
      `${allAdditive.length} additive field(s)`
  );

  // -------------------------------------------------------------------------
  // 2. Print additive changes — informational only, never blocks
  // -------------------------------------------------------------------------
  for (const c of allAdditive) {
    console.log(`    ${info("+")} ${c.modelName}.${c.fieldName} ${info("(additive)")}`);
  }

  // -------------------------------------------------------------------------
  // 3. If there are no breaking changes, proceed immediately
  // -------------------------------------------------------------------------
  if (allBreaking.length === 0) {
    log.debug("schema change is additive only — no blast radius, approved without prompting");
    return { blastResults: [], promptInjection: "", confirmed: true, breakingFieldNamesPerModel: [] };
  }

  // -------------------------------------------------------------------------
  // 4. Print breaking changes with +/- diff style
  // -------------------------------------------------------------------------
  console.log(`\n  ${warn("!")} ${bold("Breaking changes:")}`);
  for (const c of allBreaking) {
    if (c.detail === "removed") {
      console.log(`    ${error("−")} ${c.modelName}.${c.fieldName} ${error("removed")}`);
    } else {
      console.log(`    ${error("−")} ${c.modelName}.${c.fieldName} ${info(c.detail)}`);
    }
  }

  // -------------------------------------------------------------------------
  // 5. Compute blast radius for each breaking model (in parallel)
  // -------------------------------------------------------------------------
  const blastResults = await Promise.all(
    breakingModelIds.map((id) => computeBlastRadius(id, projectRoot))
  );

  for (const result of blastResults) {
    console.log();
    console.log(formatBlastRadius(result));
  }

  // -------------------------------------------------------------------------
  // 6. Build prompt injection
  // -------------------------------------------------------------------------
  const promptInjection = blastResults
    .map(blastRadiusPromptSection)
    .filter(Boolean)
    .join("\n");

  // Build per-model breaking field names, index-aligned with blastResults[].
  // Each entry contains only fields that changed for that specific model so
  // the verifier can check each blast radius independently — no cross-model
  // false positives.
  const breakingFieldNamesPerModel = blastResults.map((br) => {
    const modelName = br.changedNode.id.replace(/^model:/, "");
    return allBreaking
      .filter((c) => c.modelName === modelName)
      .map((c) => c.fieldName);
  });

  // -------------------------------------------------------------------------
  // 7. Confirm (or skip under --yes / --dry-run)
  // -------------------------------------------------------------------------
  if (dryRun || yes) {
    console.log(`\n  ${info("ℹ")} Skipping confirmation (${dryRun ? "--dry-run" : "--yes"} flag set)`);
    return { blastResults, promptInjection, confirmed: true, breakingFieldNamesPerModel };
  }

  if (onBeforeConfirm) onBeforeConfirm();
  const confirmed = await askConfirm(
    `\n${warn("!")} Proceed with write? [y/N] `
  );

  if (!confirmed) console.log(`  ${warn("!")} Write aborted by user.`);

  return { blastResults, promptInjection, confirmed, breakingFieldNamesPerModel };
}
