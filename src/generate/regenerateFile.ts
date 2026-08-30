import { generateCompletion } from "./llmClient";
import {
  applyScopedEdits,
  checkSyntax,
  scopedCodeGen,
  validateEditPlan,
  withTimeout,
  type EditPlan,
  type FileEdit,
} from "./scopedEdit";
import { findFieldReferences, referencesField, type ReferenceKind } from "../verify/symbolRefs";

/** "title at line 1 (property-access), line 1 (call-argument-key)" */
function describeRefs(refs: Array<{ field: string; line: number; kind: ReferenceKind }>): string {
  return refs.map((r) => `${r.field} at line ${r.line} (${r.kind})`).join(", ");
}

/** Cap a file pasted into a prompt, keeping both ends so edits stay anchorable. */
const PROMPT_FILE_CHAR_LIMIT = 24_000;

export function clampForPrompt(content: string): string {
  if (content.length <= PROMPT_FILE_CHAR_LIMIT) return content;
  const half = Math.floor(PROMPT_FILE_CHAR_LIMIT / 2);
  return (
    content.slice(0, half) +
    `\n… (${content.length - PROMPT_FILE_CHAR_LIMIT} characters elided) …\n` +
    content.slice(-half)
  );
}

export interface RegenerateOptions {
  /** Project-relative posix path. */
  filePath: string;
  /** Current on-disk content. */
  currentContent: string;
  /** e.g. "Post.title was renamed to headline2". */
  schemaChange: string;
  /** Field names that must no longer be referenced afterwards. */
  oldFields: string[];
  /** Retrieved codebase context plus the blast-radius injection. */
  context: string;
  timeoutMs?: number;
}

export interface RegenerateResult {
  edit: FileEdit;
  /** How the edit was produced, for reporting. */
  strategy: "scoped" | "whole-file";
}

export interface RegenerateFailure {
  edit: null;
  reason: string;
}

const WHOLE_FILE_PROMPT = `You are a professional TypeScript / Next.js / Prisma developer.

A Prisma schema field changed. Rewrite ONE file so it is consistent with that change.

RULES:
- Return the COMPLETE, final content of the file. Not a diff, not a snippet.
- Change ONLY what the schema change requires. Preserve every other line, including formatting and whitespace, exactly as given.
- Do not add imports, comments, or refactors that the schema change does not require.
- The old field name must not appear anywhere as a field reference when you are done.

Return a JSON object of exactly this shape:
{ "content": "<the complete file content>" }

No prose, no explanation, no markdown fences.`;

/**
 * Produce an edit that brings one blast-radius file back in line with the schema.
 *
 * Two strategies, in order:
 *
 * 1. **Scoped edit.** Minimal `oldText`/`newText` pairs — a small, readable diff.
 * 2. **Whole-file rewrite**, when the scoped edit does not apply or does not
 *    actually remove the field.
 *
 * The fallback exists because `oldText` matching fails routinely on real files:
 * anything minified onto one long line has no "verbatim snippet of 2-5 lines"
 * to quote, so the model returns something that never matches. Previously that
 * failure was silent — the unapplied edit was dropped, the file was judged on
 * its unchanged disk content, and verification reported "was not updated",
 * which reads as the model ignoring the file rather than as an edit that would
 * not apply.
 *
 * Whichever strategy produces the edit, the result is checked against the same
 * predicate the verifier uses, so an edit returned from here is guaranteed to
 * pass structural verification.
 */
export async function regenerateAffectedFile(
  opts: RegenerateOptions
): Promise<RegenerateResult | RegenerateFailure> {
  const { filePath, currentContent, schemaChange, oldFields, context } = opts;
  const timeoutMs = opts.timeoutMs ?? 90_000;

  const stillBroken = (content: string): boolean =>
    oldFields.some((f) => referencesField(content, filePath, f));

  const fileBlock = `\n\nFull current content of ${filePath}:\n\`\`\`\n${clampForPrompt(
    currentContent
  )}\n\`\`\``;

  // ── 1. Scoped edit ────────────────────────────────────────────────
  const scopedQuery =
    `The Prisma schema changed: ${schemaChange}.\n` +
    `Update "${filePath}" so it no longer contradicts that change.\n` +
    `Produce MINIMAL oldText/newText edits. Each oldText must be copied VERBATIM from the content below and must appear exactly once.\n` +
    `Do NOT modify anything unrelated to the schema change.\n` +
    `If the file genuinely needs no change, return [].`;

  const scopedPlan: EditPlan = [
    { type: "file", filePath, edits: [{ filePath, oldText: "", newText: "" }] },
  ];

  let scopedReason = "no scoped edit returned";
  try {
    const raw = await scopedCodeGen(scopedQuery, context + fileBlock, scopedPlan, timeoutMs);
    const check = validateEditPlan(raw);
    if (!check.ok) {
      scopedReason = `scoped edit rejected: ${check.reason}`;
    } else {
      for (const action of check.plan) {
        if (action.type !== "file") continue;
        const edits = action.edits.filter((e) => e.oldText !== "");
        if (edits.length === 0) continue;
        try {
          const applied = applyScopedEdits(currentContent, edits, filePath);
          if (applied === currentContent) {
            scopedReason = "scoped edit was a no-op";
            continue;
          }
          if (stillBroken(applied)) {
            scopedReason = `scoped edit still references ${oldFields.join(", ")}`;
            continue;
          }
          return {
            strategy: "scoped",
            edit: { type: "file", filePath, edits: edits.map((e) => ({ ...e, filePath })) },
          };
        } catch (err) {
          scopedReason = `scoped edit did not apply: ${err instanceof Error ? err.message : err}`;
        }
      }
    }
  } catch (err) {
    scopedReason = `scoped edit failed: ${err instanceof Error ? err.message : err}`;
  }

  // ── 2. Whole-file rewrite, with one corrective pass ───────────────
  const basePrompt =
    `${WHOLE_FILE_PROMPT}\n\n` +
    `Schema change: ${schemaChange}\n` +
    `File: ${filePath}\n` +
    `These names must no longer be used as field references: ${oldFields.join(", ")}\n` +
    `\nCurrent content:\n\`\`\`\n${clampForPrompt(currentContent)}\n\`\`\``;

  let rewritten: string | null = null;
  let wholeFileReason = "";
  let correction = "";

  // Two attempts. The second is given the exact positions the first one missed,
  // which is far more actionable than "you still reference title" — a single
  // long line can hold half a dozen references, and the model reliably fixes
  // the obvious ones while leaving one behind.
  for (let attempt = 0; attempt < 2; attempt++) {
    let candidate: string;
    try {
      const text = await withTimeout(
        generateCompletion(basePrompt + correction, { responseFormat: "json" }),
        timeoutMs,
        "Whole-file regeneration"
      );
      const parsed = JSON.parse(text) as { content?: unknown };
      if (typeof parsed.content !== "string" || parsed.content.trim() === "") {
        wholeFileReason = "whole-file rewrite returned no content";
        continue;
      }
      candidate = parsed.content;
    } catch (err) {
      wholeFileReason = `whole-file rewrite failed: ${err instanceof Error ? err.message : err}`;
      continue;
    }

    if (candidate === currentContent) {
      wholeFileReason = "whole-file rewrite changed nothing";
      continue;
    }

    const remaining = oldFields.flatMap((f) =>
      findFieldReferences(candidate, filePath, f).map((r) => ({ field: f, ...r }))
    );
    if (remaining.length > 0) {
      wholeFileReason = `whole-file rewrite still references ${describeRefs(remaining)}`;
      correction =
        `\n\nYour previous attempt was rejected. It still referenced the old field at:\n` +
        remaining.map((r) => `  - line ${r.line}: ${r.field} used as ${r.kind}`).join("\n") +
        `\n\nEvery one of those must be renamed. Check destructuring, object keys inside ` +
        `calls, type members and property accesses. Return the corrected complete file.`;
      continue;
    }

    const syntax = checkSyntax(candidate, filePath);
    if (!syntax.ok) {
      wholeFileReason = `whole-file rewrite has ${syntax.reason}`;
      correction =
        `\n\nYour previous attempt was rejected for a syntax error:\n${syntax.reason}\n` +
        `Return the corrected complete file.`;
      continue;
    }

    rewritten = candidate;
    break;
  }

  if (rewritten === null) {
    return { edit: null, reason: `${scopedReason}; ${wholeFileReason}` };
  }

  // A whole-file replacement is expressed as a single edit whose oldText is the
  // entire current content, so it flows through the same apply-and-diff path as
  // any other edit and cannot go stale between here and the write.
  return {
    strategy: "whole-file",
    edit: {
      type: "file",
      filePath,
      edits: [{ filePath, oldText: currentContent, newText: rewritten }],
    },
  };
}
