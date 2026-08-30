import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { generateCompletion } from "./llmClient";
import {
  structuralSchemaMerge,
  formatPrismaSchema,
} from "../graph/schemaMerge";
import {
  extractPrismaSchemaFromSource,
} from "../extract/prismaExtractor";
import { isPrismaSchemaPath, toPosix } from "../utils/paths";

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

/**
 * Race a promise against a deadline, always clearing the timer.
 *
 * The hand-rolled `Promise.race` these calls used left a live `setTimeout`
 * behind on every success, which keeps the event loop alive for the full
 * timeout after the work is done.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

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
  op: z.enum(["add_field", "remove_field", "rename_field", "change_type", "create_model", "remove_model"]),
  fieldName: z.string().optional(),
  newFieldName: z.string().optional(),
  fieldType: z.string().optional(),
  newFieldType: z.string().optional(),
  modelBody: z.string().optional(),
}).refine(
  (data) => {
    if (data.op === "add_field") {
      return typeof data.fieldName === "string" && data.fieldName.length > 0
        && typeof data.fieldType === "string" && data.fieldType.length > 0;
    }
    return true;
  },
  {
    message: "add_field requires both fieldName and fieldType",
  }
).refine(
  (data) => {
    if (data.op === "remove_field" || data.op === "rename_field" || data.op === "change_type") {
      return typeof data.fieldName === "string" && data.fieldName.length > 0;
    }
    return true;
  },
  {
    message: "remove_field/rename_field/change_type requires fieldName",
  }
).refine(
  (data) => {
    if (data.op === "rename_field") {
      return typeof data.newFieldName === "string" && data.newFieldName.length > 0;
    }
    return true;
  },
  {
    message: "rename_field requires newFieldName",
  }
).refine(
  (data) => {
    if (data.op === "change_type") {
      return typeof data.fieldType === "string" && data.fieldType.length > 0
        && typeof data.newFieldType === "string" && data.newFieldType.length > 0;
    }
    return true;
  },
  {
    message: "change_type requires fieldType and newFieldType",
  }
);

const FileEditSchema = z.object({
  type: z.literal("file"),
  filePath: z.string().min(1),
  edits: z.array(ScopedEditSchema),
});

const CommandActionSchema = z.object({
  type: z.literal("command"),
  command: z.string().min(1),
});

const CreateFileSchema = z.object({
  type: z.literal("create_file"),
  filePath: z.string().min(1),
  content: z.string(),
  reason: z.string().optional(),
});

const EditPlanSchema = z.array(
  z.discriminatedUnion("type", [
    SchemaEditSchema,
    FileEditSchema,
    CommandActionSchema,
    CreateFileSchema,
  ])
);

// Inferred types
export type ScopedEdit = z.infer<typeof ScopedEditSchema>;
export type SchemaEdit = z.infer<typeof SchemaEditSchema>;
export type FileEdit = z.infer<typeof FileEditSchema>;
export type CommandAction = z.infer<typeof CommandActionSchema>;
export type CreateFile = z.infer<typeof CreateFileSchema>;
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
  return raw.map(normalizeOperation).filter(isProductiveOperation);
}

/**
 * A file operation whose edits all normalised away changes nothing.
 *
 * Keeping it made a run *look* productive: the CLI printed "2 operation(s)
 * extracted", listed "file X (0 edit)", previewed "no changes", and reported
 * the step complete — while the model had in fact answered nothing. Dropping it
 * lets the caller see an empty plan and say so honestly.
 */
function isProductiveOperation(item: any): boolean {
  if (!item || typeof item !== "object") return true;
  if (item.type !== "file") return true;
  return Array.isArray(item.edits) && item.edits.length > 0;
}

function normalizeOperation(item: any): unknown {
  if (!item || typeof item !== "object") return item;
  const normalized = { ...item };

  // Normalize FileEdit entries
  if (normalized.type === "file" && Array.isArray(normalized.edits)) {
    const edits = normalized.edits
      .filter((e: any) => e && typeof e === "object")
      .map((e: any) => ({
        filePath: e.filePath ?? normalized.filePath ?? "",
        oldText: e.oldText ?? "",
        newText: e.newText ?? "",
      }));

    // A whole file expressed as one edit with an empty oldText is a *creation*
    // wearing the edit shape. The prompt used to ask for exactly this and the
    // schema rejected it — `oldText` is min(1) — so every request to create a
    // file died in validation with "Too small: expected string to have >=1
    // characters" and took the step, and in a multi-step plan the whole run,
    // with it. The prompt now asks for `create_file`; this converts the old
    // shape rather than failing on it.
    const soleEdit = edits.length === 1 ? edits[0] : undefined;
    if (soleEdit && soleEdit.oldText === "" && soleEdit.newText !== "") {
      return {
        type: "create_file",
        filePath: normalized.filePath ?? soleEdit.filePath,
        content: soleEdit.newText,
        reason: normalized.reason ?? "new file",
      };
    }

    // An empty oldText among several edits cannot be applied to an existing
    // file and would fail the same validation. Drop it so the rest survive.
    normalized.edits = edits.filter((e: any) => e.oldText !== "");
  }

  // Normalize SchemaEdit fields — do NOT default fieldName/fieldType;
  // missing values must fail validation and trigger a retry.
  if (normalized.type === "schema") {
    if (normalized.fieldName === null) normalized.fieldName = undefined;
    if (normalized.newFieldName === null) normalized.newFieldName = undefined;
    if (normalized.fieldType === null) normalized.fieldType = undefined;
    if (normalized.newFieldType === null) normalized.newFieldType = undefined;
    normalized.modelBody = normalized.modelBody ?? undefined;
  }

  // Normalize CommandAction
  if (normalized.type === "command") {
    normalized.command = normalized.command ?? "";
  }

  // Normalize CreateFile entries
  if (normalized.type === "create_file") {
    normalized.content = normalized.content ?? "";
    normalized.reason = normalized.reason ?? "";
  }

  return normalized;
}

/**
 * Structural rules the Zod shapes cannot express.
 *
 * These are the ways a syntactically valid plan can still be wrong in a way
 * that silently disarms the pipeline, so they are rejected loudly and fed back
 * to the model on the retry rather than executed.
 */
function checkPlanSemantics(plan: EditPlan): string | null {
  const problems: string[] = [];

  for (const op of plan) {
    const filePath =
      op.type === "file" || op.type === "create_file" ? op.filePath : null;
    if (filePath === null) continue;

    const normalized = toPosix(filePath);

    // A Prisma schema reached through a text edit skips applySchemaEdit, the
    // blast radius, the migrate/generate injection and structural verification
    // — every guarantee this tool exists to provide. It is always a bug, and it
    // then fails anyway on a stale oldText match.
    if (isPrismaSchemaPath(normalized)) {
      problems.push(
        `${op.type} operation targets ${normalized}: schema.prisma must be changed with a {"type":"schema"} operation (add_field / remove_field / rename_field / change_type / create_model / remove_model), never a text edit`
      );
      continue;
    }

    if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
      problems.push(`${op.type} operation uses an absolute path (${normalized}); use a path relative to the project root`);
      continue;
    }

    if (normalized.split("/").includes("..")) {
      problems.push(`${op.type} operation escapes the project root (${normalized})`);
    }
  }

  return problems.length > 0 ? problems.join("; ") : null;
}

export function validateEditPlan(raw: unknown): {
  ok: true;
  plan: EditPlan;
} | {
  ok: false;
  reason: string;
} {
  const result = EditPlanSchema.safeParse(normalizeEditPlan(raw));
  if (!result.success) {
    return {
      ok: false,
      reason: result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }

  const semantic = checkPlanSemantics(result.data);
  if (semantic) return { ok: false, reason: semantic };

  return { ok: true, plan: result.data };
}

// ---------------------------------------------------------------------------
// Syntax sanity check — lightweight parse-only validation for new files
// ---------------------------------------------------------------------------

import ts from "typescript";

/**
 * Check whether content is syntactically parseable as TypeScript/TSX.
 * This is NOT a full type-check — just "is this valid syntax."
 * Returns { ok: true } or { ok: false, reason: string }.
 */
export function checkSyntax(
  content: string,
  filePath: string
): { ok: true } | { ok: false; reason: string } {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const isTsFile = ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx";
  if (!isTsFile) return { ok: true }; // skip non-JS/TS files

  const scriptKind = ext === "tsx"
    ? ts.ScriptKind.TSX
    : ext === "jsx"
      ? ts.ScriptKind.JSX
      : ext === "ts"
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,  // setParentNodes
    scriptKind
  );

  // parseDiagnostics contains syntax/parse errors (not type errors)
  const parseDiags = (sourceFile as any).parseDiagnostics as ts.Diagnostic[];
  if (parseDiags.length > 0) {
    const msg = parseDiags
      .slice(0, 5)
      .map((d) => {
        const line = d.start !== undefined
          ? sourceFile.getLineAndCharacterOfPosition(d.start).line + 1
          : "?";
        const msgText = ts.flattenDiagnosticMessageText(d.messageText, "\n");
        return `  line ${line}: ${msgText}`;
      })
      .join("\n");
    return { ok: false, reason: `Syntax errors in ${filePath}:\n${msg}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Query classification — detect single-step vs. multi-step before intent extraction
// ---------------------------------------------------------------------------

const StepSchema = z.object({
  description: z.string().min(1),
  kind: z.enum(["structural_edit", "new_file"]),
});

const ClassificationSchema = z.object({
  decomposable: z.boolean(),
  steps: z.array(StepSchema).min(1),
});

export type Step = z.infer<typeof StepSchema>;
export type Classification = z.infer<typeof ClassificationSchema>;

export function validateClassification(raw: unknown): {
  ok: true;
  classification: Classification;
} | {
  ok: false;
  reason: string;
} {
  const result = ClassificationSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, classification: pruneRedundantSteps(result.data) };
  }
  return {
    ok: false,
    reason: result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; "),
  };
}

/** Descriptions that only restate work the blast radius already performs. */
const PROPAGATION_ONLY =
  /\b(references?|usages?|call ?sites?|consumers?|occurrences?)\b|\b(that|which)\s+(use|uses|using|reference|references|render|renders)\b/i;

/**
 * Drop follow-up steps that only ask for downstream propagation.
 *
 * The prompt forbids them, but the classifier runs on whatever model the user
 * configured and a small one emits them anyway. They are never merely wasteful:
 * a propagation step carries no schema edit, so it is the one path through the
 * pipeline that runs with no blast radius and no structural verification, and
 * it is handed a file its predecessor has already rewritten — so it either
 * produces nothing or quotes pre-change text and fails the whole plan.
 *
 * Pruning is deliberately conservative: it needs an earlier step to have done
 * the real work, it never touches `new_file` steps, and it never empties a plan.
 */
export function pruneRedundantSteps(classification: Classification): Classification {
  // A one-step plan is single-step whatever the model called it. Left as
  // `decomposable: true` it took the multi-step path — extra confirmation
  // prompt, plan banner and per-step framing — to do exactly one thing.
  if (classification.steps.length < 2) {
    return classification.decomposable
      ? { decomposable: false, steps: classification.steps }
      : classification;
  }

  const kept = classification.steps.filter(
    (step, i) =>
      i === 0 || step.kind === "new_file" || !PROPAGATION_ONLY.test(step.description)
  );

  if (kept.length === classification.steps.length) return classification;

  return {
    decomposable: kept.length > 1,
    steps: kept,
  };
}

const CLASSIFICATION_PROMPT = `You are a query classifier. Given a user's natural-language request about a codebase, determine whether it reduces to a SINGLE structural edit on an existing file/model, or whether it requires MULTIPLE steps (including creating files that don't exist yet).

A "structural_edit" is a change to an existing file: adding/removing/renaming a field in a Prisma model, editing a route, modifying a component, etc.

A "new_file" is creating a file that does not currently exist in the project.

Return a JSON object with exactly this shape:
{
  "decomposable": true or false,
  "steps": [
    { "description": "<short imperative description>", "kind": "structural_edit" | "new_file" }
  ]
}

DOWNSTREAM PROPAGATION IS AUTOMATIC — DO NOT PLAN IT.
When a Prisma field or model changes, the system already computes which routes,
components and files reference it and updates every one of them in the same
step, then verifies the result. So a schema change and all the call-site updates
it forces are ONE step, never two.

Never emit a step like "update references to X", "update the components that use
X", "fix call sites", "update types/imports/usages", or "update the API routes"
as a follow-up to a schema step. Those are already covered.

Wrong (two steps):
  1. Rename User.phone to phoneNo in the Prisma schema
  2. Update phone references in the routes and components
Right (one step):
  1. Rename User.phone to phoneNo

RULES:
- If the request is a SINGLE change to an existing file or model, set "decomposable" to false and "steps" to exactly one entry with kind "structural_edit".
- If the request requires creating new files, setting up multiple routes, or combining several unrelated changes, set "decomposable" to true and list each step in order.
- Decompose only genuinely INDEPENDENT changes — two different features, or a new file plus an edit to an existing one. Never decompose one change into "do it" plus "propagate it".
- Steps that create a file that does not currently exist must have kind "new_file".
- Steps that modify an existing file or Prisma model must have kind "structural_edit".
- Keep descriptions short (under 15 words). Use imperative mood (e.g. "Add login route", "Rename field").
- Order steps logically — prerequisites first.`;

/**
 * Classification is the cheapest call in the pipeline but was given the
 * tightest budget — 15s for a prompt carrying the entire retrieved context,
 * while intent extraction got 30s for a larger one. On a queued or free-tier
 * model that reliably expired, and the timeout escaped `classifyQueryWithRetry`
 * (which only ever retried *validation* failures), killing the whole run before
 * a single file was touched.
 */
const CLASSIFICATION_TIMEOUT_MS = 30_000;
const CLASSIFICATION_MAX_TOKENS = 512;

export async function classifyQuery(
  query: string,
  context: string
): Promise<{ classification: Classification; raw: unknown }> {
  const contents = `${CLASSIFICATION_PROMPT}\n\nUser request: ${query}\n\nProject context:\n${context}\n\nReturn ONLY a JSON object. No prose, no explanation.`;

  const text = await withTimeout(
    generateCompletion(contents, {
      responseFormat: "json",
      maxTokens: CLASSIFICATION_MAX_TOKENS,
      timeoutMs: CLASSIFICATION_TIMEOUT_MS,
    }),
    CLASSIFICATION_TIMEOUT_MS,
    "Classification"
  );
  const raw = JSON.parse(text);
  return { classification: raw as Classification, raw };
}

/** A single-step plan — what any request reduces to when classification fails. */
export function singleStepClassification(query: string): Classification {
  return {
    decomposable: false,
    steps: [{ description: query, kind: "structural_edit" }],
  };
}

/**
 * Classify with one retry, covering timeouts and transport errors as well as
 * validation failures.
 *
 * Never throws: classification is an optimisation, not a correctness gate. If
 * it cannot be obtained the request is treated as a single step, which is what
 * every request did before this stage existed.
 */
export async function classifyQueryWithRetry(
  query: string,
  context: string
): Promise<{ classification: Classification; degraded: string | null }> {
  let lastReason: string;

  try {
    const first = await classifyQuery(query, context);
    const check = validateClassification(first.classification);
    if (check.ok) return { classification: check.classification, degraded: null };
    lastReason = check.reason;
  } catch (err) {
    lastReason = err instanceof Error ? err.message : String(err);
  }

  try {
    const retry = await classifyQuery(
      `${query}\n\nPREVIOUS ATTEMPT FAILED: ${lastReason}\nFix the output and try again.`,
      context
    );
    const retryCheck = validateClassification(retry.classification);
    if (retryCheck.ok) return { classification: retryCheck.classification, degraded: null };
    lastReason = retryCheck.reason;
  } catch (err) {
    lastReason = err instanceof Error ? err.message : String(err);
  }

  return {
    classification: singleStepClassification(query),
    degraded: lastReason,
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
  "op": "add_field" | "remove_field" | "rename_field" | "change_type" | "create_model" | "remove_model",
  "fieldName": "<existing field name, required for remove/rename/change_type>",
  "newFieldName": "<new field name, required for rename>",
  "fieldType": "<current type, required for change_type>",
  "newFieldType": "<new type, required for change_type>",
  "modelBody": "<full model body for create_model, e.g. 'id Int @id @default(autoincrement())\\nname String?\\nposts Post[]'>"
}

For edits to an EXISTING file (routes, components, utilities):
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

For creating a file that does NOT yet exist:
{
  "type": "create_file",
  "filePath": "<relative path to the new file>",
  "content": "<the COMPLETE contents of the new file>",
  "reason": "<short reason this file is being created>"
}

For commands:
{
  "type": "command",
  "command": "<exact command string>"
}

RULES:
- ANY change to a Prisma model — adding, removing, renaming or retyping a field, adding or dropping a model — MUST use the "schema" shape above. NEVER emit a "file" or "create_file" operation whose filePath is schema.prisma. A text edit on schema.prisma will be rejected.
- filePath is always relative to the project root, e.g. "components/PostCard.tsx". Never absolute, never starting with the project folder's own name, never containing "..".
- Return an ARRAY of operations. Each operation addresses exactly one thing the user asked for.
- Make the MINIMAL change necessary. Do NOT propose edits outside what the operation describes.
- If the request is ambiguous, choose the NARROWEST reasonable scope rather than reinterpreting the whole file.
- For editing EXISTING files use "file": oldText must be a SMALL, UNIQUE snippet (2-10 lines) copied exactly from the current file, and it must be non-empty. Never use "file" for a path that does not exist yet.
- For creating NEW files use "create_file" and put the whole file in "content". Never express a new file as a "file" edit with an empty oldText — that shape is rejected.
- Never modify code or fields unrelated to the request.
- If the user asks for multiple unrelated changes, return multiple separate operations.
- For schema operations: only include the model and field that change. Do not describe the rest of the schema.
- For "create_model": include the full model body with fields in "modelBody". The model name goes in "model".
- For "remove_model": only include the model name, no field needed.`;

/**
 * Extract the user's intent as a structured EditPlan via a narrow LLM call.
 * Retries once if the LLM output doesn't validate against the Zod schema.
 */
const INTENT_TIMEOUT_MS = 60_000;
const INTENT_RETRY_TIMEOUT_MS = 30_000;
const INTENT_MAX_TOKENS = 1_600;
const INTENT_CONTEXT_CHAR_LIMIT = 16_000;

function compactIntentContext(context: string): string {
  if (context.length <= INTENT_CONTEXT_CHAR_LIMIT) return context;
  const head = Math.floor(INTENT_CONTEXT_CHAR_LIMIT * 0.75);
  const tail = INTENT_CONTEXT_CHAR_LIMIT - head;
  return (
    context.slice(0, head) +
    `\n… (${context.length - INTENT_CONTEXT_CHAR_LIMIT} characters omitted for retry) …\n` +
    context.slice(-tail)
  );
}

/**
 * Recognise a verified, unambiguous request to remove a Prisma model.
 *
 * This is deliberately narrow: the schema proves the model exists before we
 * bypass the LLM. It makes an operation such as "remove Post model" immediate
 * even when a queued free-tier provider is slow or temporarily unavailable.
 */
export function inferSchemaIntent(query: string, schemaSource?: string): EditPlan | null {
  if (!schemaSource) return null;
  const match = query.match(
    /\b(?:remove|delete|drop)\s+(?:the\s+)?(?:(?:model\s+)([A-Za-z][A-Za-z0-9_]*)\b|([A-Za-z][A-Za-z0-9_]*)\s+(?:model|schema model)\b)/i
  );
  if (!match) return null;

  const requested = match[1] ?? match[2];
  if (!requested) return null;
  const models = [...schemaSource.matchAll(/^\s*model\s+([A-Za-z][A-Za-z0-9_]*)\b/gm)].map(
    (model) => model[1]!
  );
  const model = models.find((name) => name.toLowerCase() === requested.toLowerCase());
  return model ? [{ type: "schema", model, op: "remove_model" }] : null;
}

export async function extractIntent(
  query: string,
  context: string,
  /** Current schema.prisma source — needed so the LLM can reference exact field names. */
  schemaSource?: string,
  timeoutMs = INTENT_TIMEOUT_MS
): Promise<{ plan: EditPlan; raw: unknown }> {
  const userContent = [
    `User query: ${query}`,
    `\nProject context:\n${context}`,
    schemaSource
      ? `\nCurrent schema.prisma:\n\`\`\`prisma\n${schemaSource}\n\`\`\``
      : "",
    `\nReturn ONLY a JSON array of operations. No prose, no explanation.`,
  ].join("\n");

  const text = await withTimeout(
    generateCompletion(`${INTENT_EXTRACTION_PROMPT}\n\n${userContent}`, {
      responseFormat: "json",
      maxTokens: INTENT_MAX_TOKENS,
      timeoutMs,
    }),
    timeoutMs,
    "Intent extraction"
  );

  const raw = JSON.parse(text);
  return { plan: raw as EditPlan, raw };
}

/**
 * High-level intent extraction with one retry on every recoverable model
 * failure. The retry uses a compact context and a smaller deadline, preventing
 * a queued provider from turning a single user request into a dead end.
 */
export async function extractIntentWithRetry(
  query: string,
  context: string,
  schemaSource?: string
): Promise<EditPlan> {
  const inferred = inferSchemaIntent(query, schemaSource);
  if (inferred) return inferred;

  let firstReason: string;
  try {
    const first = await extractIntent(query, context, schemaSource);
    const check = validateEditPlan(first.plan);
    if (check.ok) return check.plan;
    firstReason = check.reason;
  } catch (err) {
    firstReason = err instanceof Error ? err.message : String(err);
  }

  try {
    const retry = await extractIntent(
      `${query}\n\nPREVIOUS ATTEMPT FAILED: ${firstReason}\nReturn a valid JSON array of minimal operations only.`,
      compactIntentContext(context),
      schemaSource,
      INTENT_RETRY_TIMEOUT_MS
    );
    const retryCheck = validateEditPlan(retry.plan);
    if (retryCheck.ok) return retryCheck.plan;
    throw new Error(retryCheck.reason);
  } catch (err) {
    const retryReason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Intent extraction failed after retry. First attempt: ${firstReason}. Retry: ${retryReason}`
    );
  }
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

  // An edit whose oldText is missing but whose newText is already present is
  // not stale — it is *already applied*.
  //
  // This is the ordinary case when a multi-step plan revisits a file an earlier
  // step already fixed: step 1 renames Post.title everywhere, step 2 is handed
  // "update the title references" and quotes the pre-rename text. Treating that
  // as a failure aborted the entire run — "Stopping — remaining steps may
  // depend on this step's output" — over work that had in fact been completed
  // correctly. Skipping it is both safe and what the model meant.
  const missing = positioned.filter((p) => p.index === -1);
  const stale = missing.filter(
    (p) => p.newText.length === 0 || !currentContent.includes(p.newText)
  );
  if (stale.length > 0) {
    throw new StaleEditError(
      `oldText not found in ${filePath} (stale view):`,
      stale.map((e) => ({
        filePath,
        oldText: e.oldText.slice(0, 80) + (e.oldText.length > 80 ? "..." : ""),
      }))
    );
  }

  // Only edits that still have work to do take part from here on.
  const applicable = positioned.filter((p) => p.index !== -1);

  // Fail on any edit whose oldText matches more than once (ambiguous)
  const ambiguous = applicable.filter((p) => p.count > 1);
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
  applicable.sort((a, b) => b.index - a.index);

  let result = currentContent;
  for (const edit of applicable) {
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

export interface ApplySchemaEditOptions {
  /**
   * Whether the result is committed to disk. Default true.
   *
   * `npx prisma format` only works on a real file, so the mutated source is
   * always written, formatted, and read back — but with `write: false` the
   * original bytes are restored afterwards. Verification needs the *proposed*
   * schema before the write phase runs; without this it wrote the change to
   * disk early and the write phase then applied the same edit a second time,
   * which duplicates an `add_field` line.
   */
  write?: boolean;
}

function finalizeSchema(
  absSchemaPath: string,
  mutated: string,
  projectRoot: string,
  write: boolean
): string {
  const original = fs.existsSync(absSchemaPath)
    ? fs.readFileSync(absSchemaPath, "utf-8")
    : null;
  fs.writeFileSync(absSchemaPath, mutated, "utf-8");
  try {
    return formatPrismaSchema(absSchemaPath, projectRoot);
  } finally {
    if (!write && original !== null) {
      fs.writeFileSync(absSchemaPath, original, "utf-8");
    }
  }
}

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
  projectRoot: string,
  options: ApplySchemaEditOptions = {}
): string {
  const write = options.write ?? true;
  // ── create_model: append a new model block before the final newline ──
  if (edit.op === "create_model") {
    const body = edit.modelBody ?? "";
    const newBlock = `\nmodel ${edit.model} {\n${body}\n}`;
    const mutated = existingSource.trimEnd() + "\n" + newBlock + "\n";
    const absSchemaPath = path.isAbsolute(schemaPath)
      ? schemaPath
      : path.resolve(projectRoot, schemaPath);
    return finalizeSchema(absSchemaPath, mutated, projectRoot, write);
  }

  // ── remove_model: drop the entire model block ──
  if (edit.op === "remove_model") {
    const lines = existingSource.split("\n");
    const result: string[] = [];
    let i = 0;
    let removedTarget = false;
    let currentModel: string | null = null;
    let depth = 0;
    const relationType = new RegExp(
      `^\\s*[A-Za-z_][A-Za-z0-9_]*\\s+${escapeRegex(edit.model)}(?:\\[\\])?\\??(?:\\s|$)`
    );
    while (i < lines.length) {
      const line = lines[i];
      const modelMatch = line.match(/^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/);
      if (modelMatch && modelMatch[1] === edit.model) {
        // Skip the entire model block
        removedTarget = true;
        depth = 1;
        i++;
        while (i < lines.length && depth > 0) {
          if (lines[i].includes("{")) depth++;
          if (lines[i].includes("}")) depth--;
          i++;
        }
        continue;
      }
      if (modelMatch) {
        currentModel = modelMatch[1];
        depth = 1;
      } else if (currentModel !== null) {
        // A relation to the deleted model cannot stay in the schema. Remove it
        // deterministically alongside the model so Prisma format/migrate never
        // sees a dangling `LikeDislike[]` (or optional singular) field.
        if (relationType.test(line)) {
          i++;
          continue;
        }
        if (line.includes("{")) depth++;
        if (line.includes("}")) depth--;
        if (depth === 0) currentModel = null;
      }
      result.push(line);
      i++;
    }
    if (!removedTarget) {
      throw new Error(`Model ${edit.model} was not found in schema.prisma`);
    }
    const mutated = result.join("\n");
    const absSchemaPath = path.isAbsolute(schemaPath)
      ? schemaPath
      : path.resolve(projectRoot, schemaPath);
    return finalizeSchema(absSchemaPath, mutated, projectRoot, write);
  }

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

  const absSchemaPath = path.isAbsolute(schemaPath)
    ? schemaPath
    : path.resolve(projectRoot, schemaPath);
  return finalizeSchema(absSchemaPath, mutated, projectRoot, write);
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
   For "create_model": pass through the full descriptor including modelBody.
   For "remove_model": pass through the descriptor with just the model name.

2. FILE EDITS (type: "file") — for a file that ALREADY EXISTS:
   For each file edit, you MUST:
   - Produce EXACT oldText (verbatim from the current file) and newText (minimal replacement). oldText must be a SMALL, UNIQUE snippet (2-10 lines) and must never be empty.
   - Do NOT modify any code outside the oldText/newText snippets
   - Do NOT add imports, exports, or code that wasn't in the original unless the operation explicitly requires it

3. NEW FILES (type: "create_file") — for a file that does NOT exist yet:
   { "type": "create_file", "filePath": "<relative path>", "content": "<the COMPLETE file>", "reason": "<why>" }
   Never express a new file as a "file" edit with an empty oldText.

4. COMMANDS (type: "command"):
   Pass through the command string as-is.

CRITICAL RULES:
- Make the MINIMAL change necessary to satisfy the request.
- Do NOT modify code or fields unrelated to the request.
- If the request is ambiguous, choose the NARROWEST reasonable scope.
- For EXISTING files: produce ONLY targeted oldText/newText pairs — NOT the whole file content.
- For NEW files: emit a "create_file" operation carrying the COMPLETE file content.

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
  { "type": "schema", "model": "...", "op": "create_model", "modelBody": "..." }
  { "type": "schema", "model": "...", "op": "remove_model" }
  { "type": "schema", "model": "...", "op": "add_field", "fieldName": "...", "fieldType": "..." }
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
  const prompt = `${SCOPEDCodeGenPrompt}

User query: ${query}

Project context:
${context}

Edit plan (follow this exactly — fill in actual code for file edits):
${JSON.stringify(plan, null, 2)}

Remember: for file edits, provide EXACT oldText (verbatim from current file) and newText (minimal replacement). For schema and command entries, pass them through as-is.`;

  const text = await withTimeout(
    generateCompletion(prompt, { responseFormat: "json" }),
    timeoutMs,
    "LLM generation"
  );

  return JSON.parse(text) as EditPlan;
}

/**
 * High-level scoped code generation with one retry on validation failure.
 */
export async function scopedCodeGenWithRetry(
  query: string,
  context: string,
  plan: EditPlan,
  timeoutMs = 120_000
): Promise<EditPlan> {
  const first = await scopedCodeGen(query, context, plan, timeoutMs);
  const check = validateEditPlan(first);
  if (check.ok) return check.plan;

  const retry = await scopedCodeGen(
    `${query}\n\nPREVIOUS OUTPUT FAILED VALIDATION: ${check.reason}\nFix the output and try again. Return ONLY valid JSON.`,
    context,
    plan,
    timeoutMs
  );
  const retryCheck = validateEditPlan(retry);
  if (!retryCheck.ok) {
    throw new Error(
      `Scoped code generation failed validation after retry: ${retryCheck.reason}`
    );
  }
  return retryCheck.plan;
}
