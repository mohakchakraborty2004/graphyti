import * as Diff from "diff";
import chalk from "chalk";

/**
 * Render old/new file content as a colored unified-diff-style preview.
 *
 * Used for `--dry-run` file previews and blast-radius affected-file listings.
 * No file I/O — pure string in/out.
 */
export function renderDiff(
  oldContent: string,
  newContent: string,
  opts: { contextLines?: number; header?: string } = {}
): string {
  const contextLines = opts.contextLines ?? 3;
  const header = opts.header ?? "changes";
  const patch = Diff.structuredPatch(
    header,
    header,
    oldContent,
    newContent,
    "before",
    "after",
    { context: contextLines }
  );

  if (patch.hunks.length === 0) return "";

  const collected: string[] = [];
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        collected.push(chalk.green(line));
      } else if (line.startsWith("-")) {
        collected.push(chalk.red(line));
      } else {
        collected.push(chalk.dim(line));
      }
    }
  }
  return collected.join("\n");
}

/**
 * Render a single file's diff from old content on disk vs new in-memory content.
 * Returns null when there is no difference.
 */
export function renderFileDiff(
  oldContent: string | null,
  newContent: string,
  filePath: string
): string | null {
  if (oldContent === null) {
    const lines = newContent.split("\n");
    const preview = lines.slice(0, 60);
    const header = `--- /dev/null\n+++ ${filePath}`;
    const body = preview.map((l) => chalk.green(`+${l}`)).join("\n");
    const suffix = lines.length > 60 ? chalk.dim(`\n  ... (${lines.length - 60} more lines)`) : "";
    return `${chalk.dim(header)}\n${body}${suffix}`;
  }
  if (oldContent === newContent) return null;
  return renderDiff(oldContent, newContent, { header: filePath });
}
