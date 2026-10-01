import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { extractPrismaSchemaFromSource, type PrismaExtractResult } from "../extract/prismaExtractor";
import type { ModelField } from "../extract/types";
import { createLogger } from "../utils/logger";

const log = createLogger("schema-merge");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SchemaMutation {
  modelName: string;
  /** Fields to add (name + full field line, e.g. "username  String") */
  added: Array<{ fieldName: string; fieldLine: string }>;
  /** Fields to remove by name */
  removed: string[];
  /** Fields whose type changed: { fieldName, oldType, newType } */
  typeChanged: Array<{ fieldName: string; oldType: string; newType: string }>;
}

// ---------------------------------------------------------------------------
// Diff two parsed schemas to produce a list of mutations
// ---------------------------------------------------------------------------

export function computeSchemaMutations(
  oldParsed: PrismaExtractResult,
  newParsed: PrismaExtractResult
): SchemaMutation[] {
  const mutations: SchemaMutation[] = [];

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

  const allModels = new Set([
    ...oldParsed.models.map((m) => m.name),
    ...newParsed.models.map((m) => m.name),
  ]);

  for (const modelName of allModels) {
    const oldFields = oldFieldsByModel.get(modelName) ?? [];
    const newFields = newFieldsByModel.get(modelName) ?? [];
    const oldMap = new Map(oldFields.map((f) => [f.fieldName, f]));
    const newMap = new Map(newFields.map((f) => [f.fieldName, f]));

    const added: SchemaMutation["added"] = [];
    const removed: string[] = [];
    const typeChanged: SchemaMutation["typeChanged"] = [];

    // Fields in new but not old → added
    for (const [name, af] of newMap) {
      if (!oldMap.has(name)) {
        // Build a Prisma field line from the parsed metadata
        const parts = [name, af.type];
        if (af.isList) parts[1] += "[]";
        if (af.isOptional) parts[1] += "?";
        // Preserve @relation, @id, @default etc from the new schema's raw source
        // We store the reconstructed line; the caller can refine with raw text matching
        added.push({ fieldName: name, fieldLine: parts.join("  ") });
      }
    }

    // Fields in old but not new → removed
    for (const [name] of oldMap) {
      if (!newMap.has(name)) {
        removed.push(name);
      }
    }

    // Fields present in both but type changed
    for (const [name, of_] of oldMap) {
      const nf = newMap.get(name);
      if (nf && of_.type !== nf.type) {
        typeChanged.push({ fieldName: name, oldType: of_.type, newType: nf.type });
      }
    }

    if (added.length > 0 || removed.length > 0 || typeChanged.length > 0) {
      mutations.push({ modelName, added, removed, typeChanged });
    }
  }

  return mutations;
}

// ---------------------------------------------------------------------------
// Apply mutations to the existing schema text (line-level surgery)
// ---------------------------------------------------------------------------

/**
 * Apply structural mutations to the existing Prisma schema text.
 *
 * Strategy:
 *   - For each model block, find the `model Foo {` ... `}` range
 *   - Remove lines matching removed field names
 *   - Update lines matching type-changed field names
 *   - Insert added fields before the closing `}`
 *
 * This is intentionally conservative: we only touch field lines within model
 * blocks. Comments, generators, datasources, and @@attributes are preserved.
 */
export function applySchemaMutations(
  existingSource: string,
  mutations: SchemaMutation[]
): string {
  if (mutations.length === 0) return existingSource;

  const lines = existingSource.split("\n");
  const result: string[] = [];

  // Build lookup: model name → mutation
  const mutByModel = new Map(mutations.map((m) => [m.modelName, m]));

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const modelMatch = line.match(/^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/);

    if (modelMatch) {
      const modelName = modelMatch[1];
      const mut = mutByModel.get(modelName);

      // Collect the entire model block
      const blockStart = i;
      const blockLines: string[] = [line];
      let depth = 1;
      i++;
      while (i < lines.length && depth > 0) {
        if (lines[i].includes("{")) depth++;
        if (lines[i].includes("}")) depth--;
        if (depth > 0) blockLines.push(lines[i]);
        i++;
      }
      // i now points past the closing }

      if (!mut) {
        // No mutations for this model — keep as-is
        result.push(...blockLines, lines[i - 1] ?? "}");
        continue;
      }

      // Apply mutations to the block lines (excluding the model header and closing brace)
      const bodyLines = blockLines.slice(1); // skip `model Foo {`
      const kept: string[] = [];

      for (const bl of bodyLines) {
        const trimmed = bl.trim();
        const fieldMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+/);

        if (fieldMatch) {
          const fieldName = fieldMatch[1];

          // Skip if this field was removed
          if (mut.removed.includes(fieldName)) continue;

          // Check if type needs updating
          const typeChange = mut.typeChanged.find((tc) => tc.fieldName === fieldName);
          if (typeChange) {
            // Replace the type in the line: "name  String" → "name  String?"
            // Find and replace the old type with the new type
            const oldTypePattern = new RegExp(`\\b${typeChange.oldType}\\b`);
            const updatedLine = bl.replace(oldTypePattern, typeChange.newType);
            kept.push(updatedLine);
            continue;
          }
        }

        kept.push(bl);
      }

      // Insert added fields before the closing `}`
      // Find the last non-empty line in the body to insert before it
      const addedLines: string[] = [];
      for (const added of mut.added) {
        addedLines.push(`  ${added.fieldLine}`);
      }

      // Reassemble: header + kept body + added fields + closing
      result.push(line); // `model Foo {`
      result.push(...kept);
      if (addedLines.length > 0) {
        result.push(...addedLines);
      }
      result.push("}");
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join("\n");
}

// ---------------------------------------------------------------------------
// Format with npx prisma format (best-effort, non-blocking)
// ---------------------------------------------------------------------------

/**
 * Run `npx prisma format` on the schema file to fix formatting.
 * Returns the formatted content, or the original if formatting fails.
 *
 * This is a best-effort pass — if prisma CLI is not available or
 * formatting fails, we return the unformatted content (it's still
 * syntactically valid, just not pretty).
 */
export function formatPrismaSchema(
  schemaPath: string,
  projectRoot: string
): string {
  const result = spawnSync("npx", ["prisma", "format", schemaPath], {
    cwd: projectRoot,
    stdio: "pipe",
    timeout: 15_000,
  });

  if (result.status === 0 && fs.existsSync(schemaPath)) {
    log.debug(`${schemaPath}: prisma format succeeded`);
    return fs.readFileSync(schemaPath, "utf-8");
  }

  // If prisma format fails, return the file as-is (still valid, just unformatted)
  log.warn(
    `${schemaPath}: prisma format unavailable (exit=${result.status ?? "signal"}); keeping unformatted output`
  );
  return fs.readFileSync(schemaPath, "utf-8");
}

// ---------------------------------------------------------------------------
// High-level: merge schema with structural edits
// ---------------------------------------------------------------------------

/**
 * Structurally merge a generated schema.prisma with the existing one on disk.
 *
 * Instead of asking the LLM to reproduce the entire file (which loses
 * formatting and accumulates duplicates), we:
 *   1. Parse both old and new with extractPrismaSchemaFromSource
 *   2. Compute the field-level diff (add/remove/rename/type-change)
 *   3. Apply targeted line-level mutations to the existing source
 *   4. Run `npx prisma format` to fix any formatting issues
 *
 * @returns The merged, formatted schema content.
 */
export function structuralSchemaMerge(
  existingSource: string,
  generatedContent: string,
  schemaPath: string,
  projectRoot: string
): string {
  const oldParsed = extractPrismaSchemaFromSource(existingSource, schemaPath);
  const newParsed = extractPrismaSchemaFromSource(generatedContent, schemaPath);

  const mutations = computeSchemaMutations(oldParsed, newParsed);

  if (mutations.length > 0) {
    log.debug(
      `${schemaPath}: ${mutations.length} model(s) mutated — ` +
        mutations
          .map(
            (m) =>
              `${m.modelName} (+${m.added.length}/-${m.removed.length}/~${m.typeChanged.length})`
          )
          .join(", ")
    );
  }

  if (mutations.length === 0) {
    // No field-level changes detected — fall back to the generated content
    // (the model might have changed comments, formatting, or @@attributes)
    log.debug(`${schemaPath}: no field-level mutations; keeping generated content as-is`);
    return generatedContent;
  }

  const merged = applySchemaMutations(existingSource, mutations);

  // Write temporarily, format, then read back
  fs.writeFileSync(schemaPath, merged, "utf-8");
  const formatted = formatPrismaSchema(schemaPath, projectRoot);

  return formatted;
}
