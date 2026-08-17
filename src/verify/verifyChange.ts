import * as path from "path";
import * as fs from "fs";
import { extractPrismaSchemaFromSource } from "../extract/prismaExtractor";
import { extractTypeScriptFromSource } from "../extract/tsExtractor";
import { findPrismaSchemas, extractPrismaSchema } from "../extract/prismaExtractor";
import type { BlastRadiusResult, AffectedNode } from "../graph/blastRadius";
import type { PrismaModel } from "../extract/types";

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
// Per-node verification logic
// ---------------------------------------------------------------------------

/**
 * For an ApiRoute node affected by a breaking change, verify that the generated
 * content no longer references the old field and (if provided) now references
 * the new field.
 *
 * Strategy: run extractTypeScriptFromSource on the generated content and check
 * the routeModelUsages field names.  If the old field is still present in any
 * usage → missed.  If the content wasn't regenerated at all → missed.
 */
function verifyRoute(
  node: AffectedNode,
  oldFields: string[],
  newFields: string[],
  genMap: Map<string, string>,
  models: PrismaModel[],
  projectRoot: string
): "addressed" | "missed" | "not-generated" {
  const content = genMap.get(node.filePath);
  if (content === undefined) {
    // File wasn't regenerated — check on-disk content to see if it actually
    // references the removed field. If not, no changes are needed.
    const absPath = path.resolve(projectRoot, node.filePath);
    if (!fs.existsSync(absPath)) return "not-generated";
    const diskContent = fs.readFileSync(absPath, "utf-8");
    for (const oldField of oldFields) {
      const re = new RegExp(`\\b${escapeRegex(oldField)}\\b`);
      if (re.test(diskContent)) return "not-generated";  // References removed field but wasn't updated
    }
    return "addressed";  // Doesn't reference removed field — no changes needed
  }

  const absPath = path.resolve(projectRoot, node.filePath);
  const result = extractTypeScriptFromSource(projectRoot, absPath, content, models);

  // Collect all field names referenced by any routeModelUsage in this file
  const referencedFields = new Set<string>(
    result.routeModelUsages.flatMap((u) => u.fieldNames)
  );

  // Old (removed/renamed) fields must no longer appear
  for (const oldField of oldFields) {
    if (referencedFields.has(oldField)) return "missed";
  }

  return "addressed";
}

/**
 * For a Component node, verify via extractTypeScriptFromSource's componentFetches
 * that the old field is no longer rendered.
 */
function verifyComponent(
  node: AffectedNode,
  oldFields: string[],
  genMap: Map<string, string>,
  models: PrismaModel[],
  projectRoot: string
): "addressed" | "missed" | "not-generated" {
  const content = genMap.get(node.filePath);
  if (content === undefined) {
    // File wasn't regenerated — check on-disk content
    const absPath = path.resolve(projectRoot, node.filePath);
    if (!fs.existsSync(absPath)) return "not-generated";
    const diskContent = fs.readFileSync(absPath, "utf-8");
    for (const oldField of oldFields) {
      const re = new RegExp(`\\b${escapeRegex(oldField)}\\b`);
      if (re.test(diskContent)) return "not-generated";
    }
    return "addressed";
  }

  const absPath = path.resolve(projectRoot, node.filePath);
  const result = extractTypeScriptFromSource(projectRoot, absPath, content, models);

  const referencedFields = new Set<string>(
    result.componentFetches.flatMap((f) => f.fieldNames)
  );

  for (const oldField of oldFields) {
    if (referencedFields.has(oldField)) return "missed";
  }

  return "addressed";
}

/**
 * For a plain File node, a lighter check: verify the old field name doesn't
 * appear as a bare identifier in the generated content.  This is intentionally
 * conservative (no AST for arbitrary .ts files) — a text search is good enough
 * for utility/lib files and avoids false negatives on imports/comments.
 */
function verifyFile(
  node: AffectedNode,
  oldFields: string[],
  genMap: Map<string, string>
): "addressed" | "missed" | "not-generated" {
  const content = genMap.get(node.filePath);
  if (content === undefined) {
    // File wasn't regenerated — check on-disk content
    if (!fs.existsSync(node.filePath)) return "not-generated";
    const diskContent = fs.readFileSync(node.filePath, "utf-8");
    for (const oldField of oldFields) {
      const re = new RegExp(`\\b${escapeRegex(oldField)}\\b`);
      if (re.test(diskContent)) return "not-generated";
    }
    return "addressed";
  }

  // Word-boundary search: look for field name used as an identifier
  for (const oldField of oldFields) {
    const re = new RegExp(`\\b${escapeRegex(oldField)}\\b`);
    if (re.test(content)) return "missed";
  }
  return "addressed";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Extract old field names from blast-radius reasons
// ---------------------------------------------------------------------------

/**
 * Given a blast-radius node, derive which old field names (the ones being
 * renamed/removed) are the ones to check for lingering references.
 *
 * The reason strings produced by blastRadius.ts encode the field info in
 * node.name for ModelField nodes.  For model-level blast radius we fall back
 * to the breaking changes list passed in.
 */
function oldFieldsForNode(
  node: AffectedNode,
  breakingFieldNames: string[]
): string[] {
  // breakingFieldNames is the authoritative list — always use it
  return breakingFieldNames;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Mechanically verify that every file listed in `blastRadius` was regenerated
 * and no longer references the old/removed/renamed fields described by
 * `breakingFieldNames`.
 *
 * This is deterministic AST + text parsing — not an LLM call.
 *
 * @param blastRadius       - Result from computeBlastRadius.
 * @param breakingFieldNames - The specific field names that were removed/renamed
 *                            (from the schema diff's breaking changes).
 * @param generatedFiles    - In-memory content from the current codeGen pass.
 * @param projectRoot       - Repo root (defaults to cwd).
 */
export function verifyBlastRadiusAddressed(
  blastRadius: BlastRadiusResult,
  breakingFieldNames: string[],
  generatedFiles: GeneratedFile[],
  projectRoot: string = process.cwd()
): VerifyReport {
  if (breakingFieldNames.length === 0) {
    // Nothing to verify — additive-only change
    return { addressed: [], missed: [], retryPrompt: "" };
  }

  const genMap = buildGenMap(generatedFiles, projectRoot);
  const models = loadModels(projectRoot, genMap);

  const addressed: VerifyEntry[] = [];
  const missed: VerifyEntry[] = [];

  const allAffected: AffectedNode[] = [
    ...blastRadius.affectedRoutes,
    ...blastRadius.affectedComponents,
    ...blastRadius.affectedFiles,
  ];

  for (const node of allAffected) {
    const oldFields = oldFieldsForNode(node, breakingFieldNames);
    let outcome: "addressed" | "missed" | "not-generated";

    // Classify by node kind (encoded in the id prefix)
    if (node.id.startsWith("route:")) {
      outcome = verifyRoute(node, oldFields, [], genMap, models, projectRoot);
    } else if (node.id.startsWith("component:")) {
      outcome = verifyComponent(node, oldFields, genMap, models, projectRoot);
    } else {
      // file: or anything else — text search
      outcome = verifyFile(node, oldFields, genMap);
    }

    const entry: VerifyEntry = { filePath: node.filePath, reason: node.reason };

    if (outcome === "addressed") {
      addressed.push(entry);
    } else {
      // "missed" and "not-generated" are both failures
      missed.push({
        ...entry,
        reason:
          outcome === "not-generated"
            ? `${node.reason} — file was NOT regenerated`
            : `${node.reason} — still references old field(s): ${oldFields.join(", ")}`,
      });
    }
  }

  // Build retry prompt if there are misses
  const retryPrompt =
    missed.length === 0
      ? ""
      : [
          "\n== VERIFICATION FAILED — you missed updating these files ==",
          "The following files in the blast radius were not correctly updated.",
          "You MUST fix all of them in your next response:\n",
          ...missed.map((m) => `  - ${m.filePath}\n    reason: ${m.reason}`),
          "\nDo not skip any of these. Every file listed must be updated.",
        ].join("\n");

  return { addressed, missed, retryPrompt };
}
