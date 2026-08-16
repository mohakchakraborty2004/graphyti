import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { GoogleGenAI, Type } from "@google/genai";
import { requireGeminiApiKey } from "../config";
import {
  structuralSchemaMerge,
  formatPrismaSchema,
} from "../graph/schemaMerge";
import {
  extractPrismaSchemaFromSource,
} from "../extract/prismaExtractor";

// ---------------------------------------------------------------------------
// Zod schemas — validate every structured LLM output before use
// ---------------------------------------------------------------------------

const ScopedEditSchema = z.object({
  filePath: z.string().min(1),
  oldText: z.string().min(1),
  newText: z.string(),
});

const SchemaEditSchema = z.object({
  type: z.literal("schema"),
  model: z.string().min(1),
  op: z.enum(["add_field", "remove_field", "rename_field", "change_type"]),
  fieldName: z.string().optional(),
  newFieldName: z.string().optional(),
  fieldType: z.string().optional(),
  newFieldType: z.string().optional(),
});

const FileEditSchema = z.object({
  type: z.literal("file"),
  filePath: z.string().min(1),
  edits: z.array(ScopedEditSchema),
});

const CommandActionSchema = z.object({
  type: z.literal("command"),
  command: z.string().min(1),
});

const EditPlanSchema = z.array(
  z.discriminatedUnion("type", [
    SchemaEditSchema,
    FileEditSchema,
    CommandActionSchema,
  ])
);

// Inferred types
export type ScopedEdit = z.infer<typeof ScopedEditSchema>;
export type SchemaEdit = z.infer<typeof SchemaEditSchema>;
export type FileEdit = z.infer<typeof FileEditSchema>;
export type CommandAction = z.infer<typeof CommandActionSchema>;
export type EditPlan = z.infer<typeof EditPlanSchema>;

// ---------------------------------------------------------------------------
// Validation helper — reject + retry once on invalid shape
// ---------------------------------------------------------------------------

/**
 * Normalize an LLM response: fill in undefined/missing fields with defaults
 * so Zod validation doesn't reject otherwise-usable output.
 */
function normalizeEditPlan(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((item: any) => {
    if (!item || typeof item !== "object") return item;
    const normalized = { ...item };

    // Normalize FileEdit entries
    if (normalized.type === "file" && Array.isArray(normalized.edits)) {
      normalized.edits = normalized.edits
        .filter((e: any) => e && typeof e === "object")
        .map((e: any) => ({
          filePath: e.filePath ?? normalized.filePath ?? "",
          oldText: e.oldText ?? "",
          newText: e.newText ?? "",
        }))
        .filter((e: any) => e.oldText !== "" || e.newText !== ""); // drop empty edits
    }

    // Normalize SchemaEdit fields
    if (normalized.type === "schema") {
      normalized.fieldName = normalized.fieldName ?? undefined;
      normalized.newFieldName = normalized.newFieldName ?? undefined;
      normalized.fieldType = normalized.fieldType ?? undefined;
      normalized.newFieldType = normalized.newFieldType ?? undefined;
    }

    // Normalize CommandAction
    if (normalized.type === "command") {
      normalized.command = normalized.command ?? "";
    }

    return normalized;
  });
}

export function validateEditPlan(raw: unknown): {
  ok: true;
  plan: EditPlan;
} | {
  ok: false;
  reason: string;
} {
  const result = EditPlanSchema.safeParse(normalizeEditPlan(raw));
  if (result.success) {
    return { ok: true, plan: result.data };
  }
  return {
    ok: false,
    reason: result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; "),
  };
}

// ---------------------------------------------------------------------------
// Intent extraction — narrow LLM call, no code generation
// ---------------------------------------------------------------------------

const INTENT_EXTRACTION_PROMPT = `You are a precise intent extractor. Given a user's natural-language query and the current project context, extract a structured description of what the user wants changed.

You MUST return exactly one of these operation shapes:

For schema changes (Prisma, database models):
{
  "type": "schema",
  "model": "<ModelName>",
  "op": "add_field" | "remove_field" | "rename_field" | "change_type",
  "fieldName": "<existing field name, required for remove/rename/change_type>",
  "newFieldName": "<new field name, required for rename>",
  "fieldType": "<current type, required for change_type>",
  "newFieldType": "<new type, required for change_type>"
}

For code changes (routes, components, utilities):
{
  "type": "file",
  "filePath": "<relative path to the file>",
  "edits": [
    {
      "filePath": "<relative path, same as above>",
      "oldText": "<exact small snippet from the CURRENT file that should be replaced>",
      "newText": "<the replacement snippet>"
    }
  ]
}

For commands:
{
  "type": "command",
  "command": "<exact command string>"
}

RULES:
- Return an ARRAY of operations. Each operation addresses exactly one thing the user asked for.
- Make the MINIMAL change necessary. Do NOT propose edits outside what the operation describes.
- If the request is ambiguous, choose the NARROWEST reasonable scope rather than reinterpreting the whole file.
- For file edits, oldText must be a SMALL, UNIQUE snippet (2-10 lines) from the current file — enough to be unambiguous but no more.
- Never modify code or fields unrelated to the request.
- If the user asks for multiple unrelated changes, return multiple separate operations.
- For schema operations: only include the model and field that change. Do not describe the rest of the schema.`;

/**
 * Extract the user's intent as a structured EditPlan via a narrow LLM call.
 * Retries once if the LLM output doesn't validate against the Zod schema.
 */
export async function extractIntent(
  query: string,
  context: string,
  /** Current schema.prisma source — needed so the LLM can reference exact field names. */
  schemaSource?: string
): Promise<{ plan: EditPlan; raw: unknown }> {
  const apiKey = requireGeminiApiKey();
  const ai = new GoogleGenAI({ apiKey });

  const userContent = [
    `User query: ${query}`,
    `\nProject context:\n${context}`,
    schemaSource
      ? `\nCurrent schema.prisma:\n\`\`\`prisma\n${schemaSource}\n\`\`\``
      : "",
    `\nReturn ONLY a JSON array of operations. No prose, no explanation.`,
  ].join("\n");

  const genPromise = ai.models.generateContent({
    model: "gemini-3.5-flash-lite",
    contents: `${INTENT_EXTRACTION_PROMPT}\n\n${userContent}`,
    config: {
      thinkingConfig: { thinkingBudget: 4096 },
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            type: { type: Type.STRING },
            model: { type: Type.STRING },
            op: { type: Type.STRING },
            fieldName: { type: Type.STRING },
            newFieldName: { type: Type.STRING },
            fieldType: { type: Type.STRING },
            newFieldType: { type: Type.STRING },
            filePath: { type: Type.STRING },
            edits: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  filePath: { type: Type.STRING },
                  oldText: { type: Type.STRING },
                  newText: { type: Type.STRING },
                },
              },
            },
            command: { type: Type.STRING },
          },
          propertyOrdering: [
            "type",
            "model",
            "op",
            "fieldName",
            "newFieldName",
            "fieldType",
            "newFieldType",
            "filePath",
            "edits",
            "command",
          ],
        },
      },
    },
  });

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Intent extraction timed out after 30s")), 30_000)
  );

  const response = await Promise.race([genPromise, timeoutPromise]);

  const raw = JSON.parse(response.text!);
  return { plan: raw as EditPlan, raw };
}

/**
 * High-level intent extraction with one retry on validation failure.
 */
export async function extractIntentWithRetry(
  query: string,
  context: string,
  schemaSource?: string
): Promise<EditPlan> {
  const first = await extractIntent(query, context, schemaSource);
  const check = validateEditPlan(first.plan);
  if (check.ok) return check.plan;

  // Retry once with the validation error fed back
  const retry = await extractIntent(
    `${query}\n\nPREVIOUS ATTEMPT FAILED VALIDATION: ${check.reason}\nFix the schema and try again.`,
    context,
    schemaSource
  );
  const retryCheck = validateEditPlan(retry.plan);
  if (!retryCheck.ok) {
    throw new Error(
      `Intent extraction failed validation after retry: ${retryCheck.reason}`
    );
  }
  return retryCheck.plan;
}

// ---------------------------------------------------------------------------
// Apply ScopedEdits to a file — bottom-to-top to avoid offset shifts
// ---------------------------------------------------------------------------

/**
 * Apply an array of ScopedEdit entries to a file's current content.
 *
 * Each oldText is matched against the CURRENT in-memory content (not
 * precomputed offsets). We apply edits from the END of the file upward
 * so that earlier edits don't invalidate the positions of later ones.
 *
 * Returns the updated content, or throws on:
 *   - oldText not found (stale view)
 *   - oldText matching more than once (ambiguous)
 */
export function applyScopedEdits(
  currentContent: string,
  edits: ScopedEdit[],
  filePath: string
): string {
  // Sort edits by their position in the file (latest first) so we can
  // apply them without offset shifts.
  const positioned: Array<ScopedEdit & { index: number; count: number }> =
    edits.map((edit) => {
      // Count occurrences of oldText in the current content
      let count = 0;
      let searchFrom = 0;
      while (true) {
        const idx = currentContent.indexOf(edit.oldText, searchFrom);
        if (idx === -1) break;
        count++;
        searchFrom = idx + edit.oldText.length;
      }
      const index = currentContent.indexOf(edit.oldText);
      return { ...edit, index, count };
    });

  // Fail on any edit whose oldText isn't found
  const notFound = positioned.filter((p) => p.index === -1);
  if (notFound.length > 0) {
    throw new StaleEditError(
      `oldText not found in ${filePath} (stale view):`,
      notFound.map((e) => ({
        filePath,
        oldText: e.oldText.slice(0, 80) + (e.oldText.length > 80 ? "..." : ""),
      }))
    );
  }

  // Fail on any edit whose oldText matches more than once (ambiguous)
  const ambiguous = positioned.filter((p) => p.count > 1);
  if (ambiguous.length > 0) {
    throw new AmbiguousEditError(
      `oldText is ambiguous (matches ${ambiguous.length} occurrence(s)) in ${filePath}:`,
      ambiguous.map((e) => ({
        filePath,
        oldText: e.oldText.slice(0, 80) + (e.oldText.length > 80 ? "..." : ""),
        count: e.count,
      }))
    );
  }

  // Sort by index descending (apply from bottom to top)
  positioned.sort((a, b) => b.index - a.index);

  let result = currentContent;
  for (const edit of positioned) {
    result =
      result.slice(0, edit.index) +
      edit.newText +
      result.slice(edit.index + edit.oldText.length);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Apply SchemaEdit deterministically (no LLM, no full-file regeneration)
// ---------------------------------------------------------------------------

/**
 * Apply a single SchemaEdit operation to the existing schema.prisma source.
 *
 * This is a deterministic text-level edit — no LLM call. The operation
 * describes exactly which model/field to touch; everything else is preserved
 * byte-for-byte. After mutation, `npx prisma format` is run as a post-edit pass.
 */
export function applySchemaEdit(
  existingSource: string,
  edit: SchemaEdit,
  schemaPath: string,
  projectRoot: string
): string {
  const lines = existingSource.split("\n");
  const result: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const modelMatch = line.match(/^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/);

    if (modelMatch && modelMatch[1] === edit.model) {
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

      const bodyLines = blockLines.slice(1); // skip `model Foo {`
      const kept: string[] = [];

      for (const bl of bodyLines) {
        const trimmed = bl.trim();
        const fieldMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+/);

        if (fieldMatch && edit.fieldName && fieldMatch[1] === edit.fieldName) {
          switch (edit.op) {
            case "remove_field":
              // Skip this line entirely — field removed
              continue;

            case "rename_field": {
              // Replace the field name in the line
              const newName = edit.newFieldName;
              if (!newName) {
                throw new Error(
                  `rename_field requires newFieldName for ${edit.model}.${edit.fieldName}`
                );
              }
              const renamed = bl.replace(
                new RegExp(`\\b${escapeRegex(edit.fieldName)}\\b`),
                newName
              );
              kept.push(renamed);
              continue;
            }

            case "change_type": {
              // Replace the type in the line
              const oldType = edit.fieldType;
              const newType = edit.newFieldType;
              if (!oldType || !newType) {
                throw new Error(
                  `change_type requires fieldType and newFieldType for ${edit.model}.${edit.fieldName}`
                );
              }
              const retyped = bl.replace(
                new RegExp(`\\b${escapeRegex(oldType)}\\b`),
                newType
              );
              kept.push(retyped);
              continue;
            }

            default:
              // add_field is handled separately below
              break;
          }
        }

        kept.push(bl);
      }

      // For add_field: insert the new field before the closing `}`
      if (edit.op === "add_field" && edit.fieldType) {
        const parts = [edit.fieldName, edit.fieldType];
        kept.push(`  ${parts.join("  ")}`);
      }

      // Reassemble: header + kept body + closing
      result.push(line); // `model Foo {`
      result.push(...kept);
      result.push("}");
    } else {
      result.push(line);
      i++;
    }
  }

  const mutated = result.join("\n");

  // Write temporarily, format with prisma, read back
  const absSchemaPath = path.isAbsolute(schemaPath)
    ? schemaPath
    : path.resolve(projectRoot, schemaPath);
  fs.writeFileSync(absSchemaPath, mutated, "utf-8");
  const formatted = formatPrismaSchema(absSchemaPath, projectRoot);

  return formatted;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Error types for structured edit failures
// ---------------------------------------------------------------------------

export interface EditFailure {
  filePath: string;
  oldText?: string;
  count?: number;
}

export class StaleEditError extends Error {
  constructor(
    message: string,
    public failures: EditFailure[]
  ) {
    super(message);
    this.name = "StaleEditError";
  }
}

export class AmbiguousEditError extends Error {
  constructor(
    message: string,
    public failures: EditFailure[]
  ) {
    super(message);
    this.name = "AmbiguousEditError";
  }
}

// ---------------------------------------------------------------------------
// Updated codeGen prompt — produces scoped edits, not full files
// ---------------------------------------------------------------------------

const SCOPEDCodeGenPrompt = `You are a professional typescript, prisma, and nextjs developer. You will be given a user query, project context, and a structured edit plan describing EXACTLY what operations to perform.

For each operation in the plan, produce the actual code changes. You have three kinds of output:

1. SCHEMA EDITS (type: "schema"):
   These are handled deterministically — you do NOT produce schema code. Just pass through the schema edit descriptor as-is.

2. FILE EDITS (type: "file"):
   For each file edit, you MUST:
   - Read the "edits" array from the plan
   - For each edit, produce the EXACT oldText (verbatim from the current file) and the newText (the minimal replacement)
   - oldText must be a SMALL, UNIQUE snippet (2-10 lines) from the current file
   - Do NOT modify any code outside the oldText/newText snippets
   - Do NOT add imports, exports, or code that wasn't in the original unless the operation explicitly requires it

3. COMMANDS (type: "command"):
   Pass through the command string as-is.

CRITICAL RULES:
- Make the MINIMAL change necessary to satisfy the request.
- Do NOT modify code or fields unrelated to the request.
- If the request is ambiguous, choose the NARROWEST reasonable scope.
- Never regenerate an entire file. You produce ONLY targeted oldText/newText pairs.
- For each file, the edits must be small, focused snippets — NOT the whole file content.

PRISMA RULES:
- Do NOT modify or remove anything that Prisma generates by default.
- Do NOT change the default generator block.
- Do NOT rename or remove existing models unless explicitly asked.
- Do NOT add 'url = env("DATABASE_URL")' inside schema.prisma.
- Always use "import { prisma } from "@/lib/prisma" for Prisma instance.
- Never instantiate a new PrismaClient directly.
- Before "npx prisma generate", run "npm install @prisma/client".
- Always use "import { PrismaClient } from "@/generated/prisma" instead of "@prisma/client".

BACKEND RULES:
- Use Next.js App Router API routes only.
- Use correct HTTP verbs and return proper JSON with error handling.

FRONTEND RULES:
- Build proper server or client components depending on the requirement.
- Ensure zero hydration errors.

OUTPUT FORMAT:
Return a JSON array where each element is one of:
  { "type": "schema", "model": "...", "op": "...", ... }
  { "type": "file", "filePath": "...", "edits": [{ "filePath": "...", "oldText": "...", "newText": "..." }, ...] }
  { "type": "command", "command": "..." }

Return ONLY the JSON array. No prose, no explanation.`;

/**
 * Generate scoped edits via LLM, given the structured edit plan as guidance.
 * The LLM fills in the actual code for file edits; schema edits pass through.
 */
export async function scopedCodeGen(
  query: string,
  context: string,
  plan: EditPlan,
  timeoutMs = 60_000
): Promise<EditPlan> {
  const apiKey = requireGeminiApiKey();
  const ai = new GoogleGenAI({ apiKey });

  const prompt = `${SCOPEDCodeGenPrompt}

User query: ${query}

Project context:
${context}

Edit plan (follow this exactly — fill in actual code for file edits):
${JSON.stringify(plan, null, 2)}

Remember: for file edits, provide EXACT oldText (verbatim from current file) and newText (minimal replacement). For schema and command entries, pass them through as-is.`;

  const genPromise = ai.models.generateContent({
    model: "gemini-3.5-flash-lite",
    contents: prompt,
    config: {
      thinkingConfig: { thinkingBudget: 20000 },
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            type: { type: Type.STRING },
            model: { type: Type.STRING },
            op: { type: Type.STRING },
            fieldName: { type: Type.STRING },
            newFieldName: { type: Type.STRING },
            fieldType: { type: Type.STRING },
            newFieldType: { type: Type.STRING },
            filePath: { type: Type.STRING },
            edits: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  filePath: { type: Type.STRING },
                  oldText: { type: Type.STRING },
                  newText: { type: Type.STRING },
                },
              },
            },
            command: { type: Type.STRING },
          },
          propertyOrdering: [
            "type",
            "model",
            "op",
            "fieldName",
            "newFieldName",
            "fieldType",
            "newFieldType",
            "filePath",
            "edits",
            "command",
          ],
        },
      },
    },
  });

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`LLM generation timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
  );

  const response = await Promise.race([genPromise, timeoutPromise]);

  return JSON.parse(response.text!) as EditPlan;
}

/**
 * High-level scoped code generation with one retry on validation failure.
 */
export async function scopedCodeGenWithRetry(
  query: string,
  context: string,
  plan: EditPlan
): Promise<EditPlan> {
  const first = await scopedCodeGen(query, context, plan);
  const check = validateEditPlan(first);
  if (check.ok) return check.plan;

  const retry = await scopedCodeGen(
    `${query}\n\nPREVIOUS OUTPUT FAILED VALIDATION: ${check.reason}\nFix the output and try again. Return ONLY valid JSON.`,
    context,
    plan
  );
  const retryCheck = validateEditPlan(retry);
  if (!retryCheck.ok) {
    throw new Error(
      `Scoped code generation failed validation after retry: ${retryCheck.reason}`
    );
  }
  return retryCheck.plan;
}
