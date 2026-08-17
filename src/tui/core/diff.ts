/**
 * Plain-text unified diffs.
 *
 * Separate from `cli/renderDiff`, which emits chalk-coloured strings for the
 * non-interactive CLI. Pre-coloured text cannot enter the line model — the span
 * renderer owns styling, and embedded escapes would corrupt width measurement
 * and therefore wrapping. So this produces uncoloured rows and the diff block
 * decides how they look.
 */

import * as Diff from "diff";

export interface DiffOptions {
  /** Lines of unchanged context around each change. */
  contextLines?: number;
  /** Cap on emitted rows; the block renderer caps again for display. */
  maxLines?: number;
}

/**
 * Unified diff of `before` → `after`, as plain rows.
 *
 * Returns an empty string when the two are identical, so callers can use the
 * result's emptiness to decide whether a diff is worth showing at all.
 */
export function unifiedDiff(
  before: string,
  after: string,
  options: DiffOptions = {}
): string {
  const { contextLines = 3, maxLines = 400 } = options;

  if (before === after) return "";

  const patch = Diff.structuredPatch("before", "after", before, after, "", "", {
    context: contextLines,
  });

  if (patch.hunks.length === 0) return "";

  const rows: string[] = [];

  for (const hunk of patch.hunks) {
    // A short header per hunk, so a multi-part change reads as separate edits
    // rather than one run-on block. Line numbers are what make a diff navigable.
    rows.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);

    for (const row of hunk.lines) {
      rows.push(row);
      if (rows.length >= maxLines) {
        rows.push(`… diff truncated at ${maxLines} lines`);
        return rows.join("\n");
      }
    }
  }

  return rows.join("\n");
}

/**
 * Diff for a newly created file — every line is an addition.
 *
 * Rendering creation as a diff against empty keeps one visual vocabulary for
 * "here is what changed", rather than a second presentation for new files.
 */
export function creationDiff(content: string, options: DiffOptions = {}): string {
  const { maxLines = 400 } = options;
  const lines = content.replace(/\n$/, "").split("\n");
  const shown = lines.slice(0, maxLines);

  const rows = [`@@ +1,${lines.length} @@`, ...shown.map((l) => `+${l}`)];
  if (lines.length > shown.length) {
    rows.push(`… ${lines.length - shown.length} more lines`);
  }
  return rows.join("\n");
}
