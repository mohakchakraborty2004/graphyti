/**
 * Permission prompt layout (§18) — pure, so its height is exact.
 *
 * The prompt's height depends on how its command and explanation wrap, which
 * depends on the width. Estimating that in the height budget is guesswork, and a
 * wrong guess either overflows the frame or leaves a gap — so the sections are
 * computed once, here, and the component renders exactly what this returns.
 *
 * Budget and component therefore cannot disagree: they are reading the same
 * array.
 */

import type { PermissionRequest } from "../state/types";
import { wrapPath, wrapText } from "./text";

export interface PermissionLayout {
  title: string;
  /** Command rows, already wrapped, with the `$ ` gutter accounted for. */
  subject: string[];
  consequence: string[];
  question: string[];
  options: Array<{ value: "allow" | "deny"; label: string; description: string }>;
  /**
   * Total rows the bordered prompt occupies, including its border, blank
   * separators and option rows. This is what the height budget reserves.
   */
  height: number;
}

/** Cells the border and its horizontal padding consume. */
const BORDER_WIDTH = 4;
/** Rows the top and bottom border consume. */
const BORDER_ROWS = 2;

export function layoutPermission(
  request: PermissionRequest,
  width: number,
  narrow: boolean
): PermissionLayout {
  const inner = Math.max(8, width - BORDER_WIDTH);

  // Commands wrap at separators when they have no spaces to break on, so a long
  // `--schema ./path/to/file` breaks somewhere meaningful.
  const subject = request.subject
    ? request.subject.includes(" ")
      ? wrapText(request.subject, Math.max(1, inner - 2), { normalizeWhitespace: false })
      : wrapPath(request.subject, Math.max(1, inner - 2))
    : [];

  // The consequence is the first thing dropped on a narrow terminal — it is
  // context, whereas the command and the question are the decision itself.
  const consequence =
    request.consequence && !narrow ? wrapText(request.consequence, inner) : [];

  const question = wrapText(request.question, inner);

  const options: PermissionLayout["options"] = [
    { value: "allow", label: "Allow", description: "Run this once" },
    { value: "deny", label: "Deny", description: "Skip and stop here" },
  ];

  // One blank row precedes each section that is present, matching the component's
  // marginTop={1}.
  const sectionRows =
    (subject.length > 0 ? subject.length + 1 : 0) +
    (consequence.length > 0 ? consequence.length + 1 : 0) +
    question.length +
    1 +
    options.length +
    1;

  const height = BORDER_ROWS + 1 /* title */ + sectionRows;

  return { title: request.title, subject, consequence, question, options, height };
}
