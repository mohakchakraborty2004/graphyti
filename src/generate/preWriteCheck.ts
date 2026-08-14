import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { loadGraphMap } from "../graph/ingest";
import { extractPrismaSchemaFromSource } from "../extract/prismaExtractor";
import type { ModelField } from "../extract/types";
import {
  computeBlastRadius,
  formatBlastRadius,
  blastRadiusPromptSection,
  type BlastRadiusResult,
} from "../graph/blastRadius";

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
}

// ---------------------------------------------------------------------------
// Schema diff types
// ---------------------------------------------------------------------------

type ChangeKind = "ADDITIVE" | "BREAKING";

interface FieldChange {
  modelName: string;
  fieldName: string;
  kind: ChangeKind;
  detail: string; // e.g. "added", "removed", "type String→Int", "renamed title→heading"
}

interface SchemaDiff {
  breaking: FieldChange[];
  additive: FieldChange[];
  /** model:X ids for every model that has at least one BREAKING change */
  affectedModelIds: string[];
}

// ---------------------------------------------------------------------------
// Field-level diff
// ---------------------------------------------------------------------------

/**
 * Diff two field lists for a single model.
 * Key by fieldName — a missing key is a removal/addition, a changed type is breaking.
 * We intentionally do NOT diff optionality or @default changes because those are
 * non-breaking from the perspective of existing code that reads the field.
 */
function diffPrismaFields(
  modelName: string,
  before: ModelField[],
  after: ModelField[]
): { breaking: FieldChange[]; additive: FieldChange[] } {
  const breaking: FieldChange[] = [];
  const additive: FieldChange[] = [];

  const beforeMap = new Map(before.map((f) => [f.fieldName, f]));
  const afterMap  = new Map(after.map((f)  => [f.fieldName, f]));

  // Fields present in after but not before → ADDITIVE
  for (const [name, af] of afterMap) {
    if (!beforeMap.has(name)) {
      additive.push({ modelName, fieldName: name, kind: "ADDITIVE", detail: "added" });
    }
  }

  // Fields present in before but not after → BREAKING (removed)
  for (const [name, bf] of beforeMap) {
    if (!afterMap.has(name)) {
      breaking.push({ modelName, fieldName: name, kind: "BREAKING", detail: "removed" });
    }
  }

  // Fields present in both — check type change (breaking), ignore optionality/list changes
  for (const [name, bf] of beforeMap) {
    const af = afterMap.get(name);
    if (!af) continue; // already recorded as removed above
    if (bf.type !== af.type) {
      breaking.push({
        modelName,
        fieldName: name,
        kind: "BREAKING",
        detail: `type ${bf.type}→${af.type}`,
      });
    }
  }

  return { breaking, additive };
}

// ---------------------------------------------------------------------------
// Schema-level diff: read old from disk, parse new from the pending content
// ---------------------------------------------------------------------------

/**
 * For a pending file write item that touches a Prisma schema:
 *   - Read the existing file from disk (if it exists)
 *   - Parse both old and new with extractPrismaSchemaFromSource
 *   - Diff every model's fields
 *   - Return a SchemaDiff with breaking/additive changes and affected model ids
 *
 * Returns null if the file doesn't exist yet (net-new schema → no blast radius).
 */
function diffSchema(item: CodeGenItem, projectRoot: string): SchemaDiff | null {
  const fullPath = path.join(item.directory, item.fileName);
  const absPath = path.isAbsolute(fullPath)
    ? fullPath
    : path.resolve(projectRoot, fullPath);

  // Net-new file — nothing to compare against
  if (!fs.existsSync(absPath)) return null;

  const oldSource = fs.readFileSync(absPath, "utf-8");
  // CodeGenItem.content may use literal \n sequences from the JSON schema response
  const newSource = item.content.replace(/\\n/g, "\n");

  const relPath = path.relative(projectRoot, absPath).replace(/\\/g, "/");
  const oldParsed = extractPrismaSchemaFromSource(oldSource, relPath);
  const newParsed = extractPrismaSchemaFromSource(newSource, relPath);

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

  return { breaking: allBreaking, additive: allAdditive, affectedModelIds };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve which pending items are Prisma schema writes and return their diffs. */
function collectSchemaDiffs(
  items: CodeGenItem[],
  projectRoot: string
): SchemaDiff[] {
  const diffs: SchemaDiff[] = [];

  for (const item of items) {
    if (item.type !== "file") continue;
    if (item.fileName !== "schema.prisma") continue;

    const diff = diffSchema(item, projectRoot);
    if (diff !== null) diffs.push(diff);
    // null means net-new file — no diff to record
  }

  return diffs;
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
  projectRoot: string = process.cwd()
): Promise<PreWriteCheckResult> {

  // -------------------------------------------------------------------------
  // 1. Diff every schema.prisma write against what's on disk
  // -------------------------------------------------------------------------
  const diffs = collectSchemaDiffs(items, projectRoot);

  if (diffs.length === 0) {
    // No schema writes, or all schema writes are net-new files
    return { blastResults: [], promptInjection: "", confirmed: true };
  }

  // Flatten across all schema files (usually just one)
  const allBreaking: FieldChange[] = diffs.flatMap((d) => d.breaking);
  const allAdditive: FieldChange[] = diffs.flatMap((d) => d.additive);
  const breakingModelIds = [...new Set(diffs.flatMap((d) => d.affectedModelIds))];

  // -------------------------------------------------------------------------
  // 2. Print additive changes — informational only, never blocks
  // -------------------------------------------------------------------------
  for (const c of allAdditive) {
    console.log(`  ℹ️  Added ${c.modelName}.${c.fieldName} (additive — no confirmation needed)`);
  }

  // -------------------------------------------------------------------------
  // 3. If there are no breaking changes, proceed immediately
  // -------------------------------------------------------------------------
  if (allBreaking.length === 0) {
    return { blastResults: [], promptInjection: "", confirmed: true };
  }

  // -------------------------------------------------------------------------
  // 4. Print breaking changes
  // -------------------------------------------------------------------------
  console.log("\n⚠️  Breaking schema changes detected:");
  for (const c of allBreaking) {
    console.log(`     • ${c.modelName}.${c.fieldName} — ${c.detail}`);
  }

  // -------------------------------------------------------------------------
  // 5. Compute blast radius for each breaking model (in parallel)
  // -------------------------------------------------------------------------
  const blastResults = await Promise.all(
    breakingModelIds.map((id) => computeBlastRadius(id, projectRoot))
  );

  for (const result of blastResults) {
    console.log(formatBlastRadius(result));
  }

  // -------------------------------------------------------------------------
  // 6. Build prompt injection
  // -------------------------------------------------------------------------
  const promptInjection = blastResults
    .map(blastRadiusPromptSection)
    .filter(Boolean)
    .join("\n");

  // -------------------------------------------------------------------------
  // 7. Confirm (or skip under --yes / --dry-run)
  // -------------------------------------------------------------------------
  if (dryRun || yes) {
    console.log(`\n  ℹ️  Skipping confirmation (${dryRun ? "--dry-run" : "--yes"} flag set)`);
    return { blastResults, promptInjection, confirmed: true };
  }

  const confirmed = await askConfirm(
    `\n⚠️  The above files will be affected. Proceed with write? [y/N] `
  );

  if (!confirmed) console.log("  ✋ Write aborted by user.");

  return { blastResults, promptInjection, confirmed };
}
