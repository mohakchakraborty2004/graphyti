import * as path from "path";
import * as fs from "fs";
import { referencesIdentifier } from "../utils/paths";
import { extractPrismaSchemaFromSource } from "../extract/prismaExtractor";
import { extractTypeScriptFromSource } from "../extract/tsExtractor";
import { findPrismaSchemas, extractPrismaSchema } from "../extract/prismaExtractor";
import type { BlastRadiusResult, AffectedNode } from "../graph/blastRadius";
import type { PrismaModel } from "../extract/types";
import { findFieldReferences } from "./symbolRefs";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GeneratedFile {
  /** Absolute or project-relative path where this content will be written. */
  path: string;
  /** In-memory content — not yet on disk. */
  content: string;
}

export interface VerifyEntry {
  /** Relative file path (from project root) */
  filePath: string;
  /** Human-readable reason from the blast radius */
  reason: string;
}

export interface VerifyReport {
  addressed: VerifyEntry[];
  missed: VerifyEntry[];
  /** Ready-to-append prompt text listing missed files for the retry pass */
  retryPrompt: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a path to a posix-relative form from projectRoot so we can
 * compare against blast-radius filePath values (which are already relative posix).
 */
function toRelPosix(filePath: string, projectRoot: string): string {
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(projectRoot, filePath);
  return path.relative(projectRoot, abs).replace(/\\/g, "/");
}

/**
 * Build a lookup from relative-posix path → GeneratedFile content.
 */
function buildGenMap(
  generatedFiles: GeneratedFile[],
  projectRoot: string
): Map<string, string> {
  const map = new Map<string, string>();
  for (const gf of generatedFiles) {
    const rel = toRelPosix(gf.path, projectRoot);
    map.set(rel, gf.content.replace(/\\n/g, "\n"));
  }
  return map;
}

/**
 * Load all Prisma models currently on disk (needed for TS extraction context).
 * If a schema was regenerated, also accept the in-memory version.
 */
function loadModels(
  projectRoot: string,
  genMap: Map<string, string>
): PrismaModel[] {
  const models: PrismaModel[] = [];
  const absRoot = path.resolve(projectRoot);

  for (const schemaAbs of findPrismaSchemas(absRoot)) {
    const relPath = path.relative(absRoot, schemaAbs).replace(/\\/g, "/");
    // Prefer in-memory generated version if this schema was regenerated
    const inMemory = genMap.get(relPath);
    if (inMemory) {
      models.push(...extractPrismaSchemaFromSource(inMemory, relPath).models);
    } else {
      models.push(...extractPrismaSchema(schemaAbs, absRoot).models);
    }
  }
  return models;
}

// ---------------------------------------------------------------------------
// Per-node verification
// ---------------------------------------------------------------------------

interface NodeVerdict {
  outcome: "addressed" | "missed";
  detail: string;
}

/**
 * Verify one blast-radius node against the content that is about to be written.
 *
 * The gate is `findFieldReferences` — a syntactic search for the old name in
 * positions where a field name can appear. It is the same predicate the blast
 * radius used to put this file in the radius, which is what keeps the two
 * halves honest: a verifier judging by a different rule would either demand
 * changes the radius never asked for, or clear files it flagged.
 *
 * It is also strictly stronger than what came before. The previous version
 * asked the extractor which fields a route "used", so a file the extractor
 * failed to parse produced an empty set and passed silently.
 *
 * The extractor pass is kept as a second opinion for routes and components. It
 * can only reject a file the syntactic gate cleared, never clear one it
 * rejected, so an extractor regression cannot weaken the guarantee.
 */
function verifyNode(
  node: AffectedNode,
  oldFields: string[],
  removedModel: string | undefined,
  genMap: Map<string, string>,
  models: PrismaModel[],
  projectRoot: string
): NodeVerdict {
  const absPath = path.resolve(projectRoot, node.filePath);
  const generated = genMap.get(node.filePath);
  const regenerated = generated !== undefined;

  let content: string;
  if (generated !== undefined) {
    content = generated;
  } else {
    if (!fs.existsSync(absPath)) {
      return {
        outcome: "missed",
        detail: "in the blast radius but missing from disk (stale graph — run 'graphyti init-graph')",
      };
    }
    content = fs.readFileSync(absPath, "utf-8");
  }

  // The same predicate the blast radius used to decide this file belongs here.
  // If the two ever diverge, verification demands changes the radius never
  // asked for, or clears files the radius flagged.
  //
  // Positions are reported, not just field names: a minified file can hold
  // several references on one line, and "still references title" gives neither
  // the model nor the user anything to act on.
  const lingering = oldFields.flatMap((f) =>
    findFieldReferences(content, node.filePath, f).map((r) => `${f} at line ${r.line} (${r.kind})`)
  );
  if (lingering.length > 0) {
    return {
      outcome: "missed",
      detail: regenerated
        ? `still references ${lingering.join(", ")} after the edit`
        : `references ${lingering.join(", ")} and was not updated`,
    };
  }

  if (removedModel && referencesIdentifier(content, removedModel)) {
    return {
      outcome: "missed",
      detail: regenerated
        ? `still references removed model ${removedModel} after the edit`
        : `references removed model ${removedModel} and was not updated`,
    };
  }

  if (node.id.startsWith("route:") || node.id.startsWith("component:")) {
    try {
      const result = extractTypeScriptFromSource(projectRoot, absPath, content, models);
      const referenced = new Set<string>([
        ...result.routeModelUsages.flatMap((u) => u.fieldNames),
        ...result.componentFetches.flatMap((f) => f.fieldNames),
      ]);
      const stillBound = oldFields.filter((f) => referenced.has(f));
      if (stillBound.length > 0) {
        return {
          outcome: "missed",
          detail: `AST still binds ${stillBound.join(", ")} to the changed model`,
        };
      }
    } catch {
      // A parse failure is not evidence of a miss. The text gate above has
      // already decided, and it does not depend on parsing.
    }
  }

  return {
    outcome: "addressed",
    detail: regenerated ? "updated" : "does not reference the changed field",
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** One breaking change, and the field names it is allowed to be checked for. */
export interface VerifyTarget {
  blastRadius: BlastRadiusResult;
  /** The field names *this* change breaks — never another change's. */
  oldFields: string[];
  /** A removed model is verified as an identifier rather than a field. */
  removedModel?: string;
}

/**
 * Mechanically verify that every file in every blast radius was brought back
 * into agreement with the schema.
 *
 * Deterministic AST + text parsing — no LLM, no network.
 *
 * Each target is checked against its own field names. Flattening the names
 * across targets, as the caller used to do, checks model A's files for model
 * B's renamed field and reports a miss that no edit could ever fix.
 */
export function verifyStructuralChange(
  targets: VerifyTarget[],
  generatedFiles: GeneratedFile[],
  projectRoot: string = process.cwd()
): VerifyReport {
  const genMap = buildGenMap(generatedFiles, projectRoot);
  const models = loadModels(projectRoot, genMap);

  // A file can sit in more than one blast radius. Keep one verdict per path,
  // and let a miss win over an addressed so a real failure is never masked.
  const verdicts = new Map<string, { entry: VerifyEntry; missed: boolean }>();

  for (const { blastRadius, oldFields, removedModel } of targets) {
    if (oldFields.length === 0 && !removedModel) continue;

    const nodes: AffectedNode[] = [
      ...blastRadius.affectedRoutes,
      ...blastRadius.affectedComponents,
      ...blastRadius.affectedFiles,
    ];

    for (const node of nodes) {
      const verdict = verifyNode(node, oldFields, removedModel, genMap, models, projectRoot);
      const missed = verdict.outcome === "missed";
      const existing = verdicts.get(node.filePath);
      if (existing && (existing.missed || !missed)) continue;
      verdicts.set(node.filePath, {
        missed,
        entry: {
          filePath: node.filePath,
          reason: missed ? `${node.reason} — ${verdict.detail}` : node.reason,
        },
      });
    }
  }

  const addressed: VerifyEntry[] = [];
  const missed: VerifyEntry[] = [];
  for (const { entry, missed: isMissed } of verdicts.values()) {
    (isMissed ? missed : addressed).push(entry);
  }
  addressed.sort((a, b) => a.filePath.localeCompare(b.filePath));
  missed.sort((a, b) => a.filePath.localeCompare(b.filePath));

  const retryPrompt =
    missed.length === 0
      ? ""
      : [
          "\n== VERIFICATION FAILED — these files were not brought in line ==",
          "Every file below still contradicts the schema change. Fix all of them.",
          "Produce minimal oldText/newText edits; do not touch anything else.\n",
          ...missed.map((m) => `  - ${m.filePath}\n    ${m.reason}`),
          "\nDo not skip any of these. Every file listed must be updated.",
        ].join("\n");

  return { addressed, missed, retryPrompt };
}

/**
 * Single-target convenience wrapper.
 *
 * @param blastRadius        - Result from computeBlastRadius.
 * @param breakingFieldNames - Field names removed/renamed by this one change.
 * @param generatedFiles     - In-memory content from the current codeGen pass.
 * @param projectRoot        - Repo root (defaults to cwd).
 */
export function verifyBlastRadiusAddressed(
  blastRadius: BlastRadiusResult,
  breakingFieldNames: string[],
  generatedFiles: GeneratedFile[],
  projectRoot: string = process.cwd()
): VerifyReport {
  return verifyStructuralChange(
    [{ blastRadius, oldFields: breakingFieldNames }],
    generatedFiles,
    projectRoot
  );
}
