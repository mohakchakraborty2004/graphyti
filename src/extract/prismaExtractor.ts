import * as fs from "fs";
import * as path from "path";
import { extractWarn, toPosix, type ModelField, type PrismaModel } from "./types";

export interface PrismaExtractResult {
  models: PrismaModel[];
  fields: ModelField[];
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function extractBalancedBlock(source: string, openIndex: number): { body: string; end: number } | null {
  if (source[openIndex] !== "{") return null;
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return { body: source.slice(openIndex + 1, i), end: i };
      }
    }
  }
  return null;
}

function parseFieldLine(line: string): Omit<ModelField, "modelName" | "isRelation" | "relatedModelName"> | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("@@") || !/^[A-Za-z_]/.test(trimmed)) return null;

  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\])?(\?)?/);
  if (!match) {
    extractWarn(`Skipping unparseable Prisma field line: ${trimmed}`);
    return null;
  }

  return {
    fieldName: match[1],
    type: match[2],
    isList: match[3] === "[]",
    isOptional: match[4] === "?",
  };
}

/**
 * Parse a Prisma schema from an in-memory string instead of a file path.
 * `relativeFilePath` is used only to populate model.filePath and warning messages.
 * Identical logic to extractPrismaSchema — kept separate so the file-reading
 * variant is unchanged and callers that diff old-vs-new content can pass strings directly.
 */
export function extractPrismaSchemaFromSource(
  source: string,
  relativeFilePath: string
): PrismaExtractResult {
  const stripped = stripComments(source);
  const models: PrismaModel[] = [];
  const rawFields: Array<ModelField & { hasRelationAttr: boolean }> = [];

  const modelRe = /\bmodel\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = modelRe.exec(stripped))) {
    const name = match[1];
    const braceIndex = match.index + match[0].length - 1;
    const block = extractBalancedBlock(stripped, braceIndex);
    if (!block) {
      extractWarn(`Unclosed model block for ${name} in ${relativeFilePath}`);
      continue;
    }
    modelRe.lastIndex = block.end + 1;
    models.push({ name, filePath: relativeFilePath });

    for (const line of block.body.split(/\r?\n/)) {
      const parsed = parseFieldLine(line);
      if (!parsed) continue;
      const hasRelationAttr = /@relation\b/.test(line);
      rawFields.push({ modelName: name, ...parsed, isRelation: false, hasRelationAttr });
    }
  }

  const modelNames = new Set(models.map((m) => m.name));
  const fields: ModelField[] = rawFields.map(({ hasRelationAttr, ...field }) => {
    const isRelation = modelNames.has(field.type) || hasRelationAttr;
    const relatedModelName = modelNames.has(field.type) ? field.type : undefined;
    if (hasRelationAttr && !relatedModelName) {
      extractWarn(
        `@relation on ${field.modelName}.${field.fieldName} but type "${field.type}" is not a known model — skipping related model`
      );
    }
    return { ...field, isRelation, ...(relatedModelName ? { relatedModelName } : {}) };
  });

  return { models, fields };
}

export function extractPrismaSchema(schemaPath: string, projectRoot: string): PrismaExtractResult {
  const source = stripComments(fs.readFileSync(schemaPath, "utf8"));
  const relativePath = toPosix(path.relative(projectRoot, schemaPath));
  const models: PrismaModel[] = [];
  const rawFields: Array<ModelField & { hasRelationAttr: boolean }> = [];

  const modelRe = /\bmodel\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = modelRe.exec(source))) {
    const name = match[1];
    const braceIndex = match.index + match[0].length - 1;
    const block = extractBalancedBlock(source, braceIndex);
    if (!block) {
      extractWarn(`Unclosed model block for ${name} in ${relativePath}`);
      continue;
    }
    modelRe.lastIndex = block.end + 1;
    models.push({ name, filePath: relativePath });

    for (const line of block.body.split(/\r?\n/)) {
      const parsed = parseFieldLine(line);
      if (!parsed) continue;
      const hasRelationAttr = /@relation\b/.test(line);
      rawFields.push({
        modelName: name,
        ...parsed,
        isRelation: false,
        hasRelationAttr,
      });
    }
  }

  const modelNames = new Set(models.map((m) => m.name));
  const fields: ModelField[] = rawFields.map(({ hasRelationAttr, ...field }) => {
    const isRelation = modelNames.has(field.type) || hasRelationAttr;
    const relatedModelName = modelNames.has(field.type) ? field.type : undefined;
    if (hasRelationAttr && !relatedModelName) {
      extractWarn(
        `@relation on ${field.modelName}.${field.fieldName} but type "${field.type}" is not a known model — skipping related model`
      );
    }
    return {
      ...field,
      isRelation,
      ...(relatedModelName ? { relatedModelName } : {}),
    };
  });

  return { models, fields };
}

export function findPrismaSchemas(projectRoot: string): string[] {
  const results: string[] = [];
  const skip = new Set(["node_modules", ".git", "dist", ".next"]);

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === "schema.prisma") results.push(full);
    }
  }

  walk(projectRoot);
  results.sort((a, b) => toPosix(a).localeCompare(toPosix(b)));
  return results;
}
