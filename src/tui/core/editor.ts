/**
 * Prompt editor model (§16) — pure, so wrapping and caret placement can be
 * verified without a terminal.
 *
 * The model is one string plus a cursor index. Everything visual derives from
 * that single pair: display rows come from wrapping the value, and the caret's
 * row and column come from the *same* wrap. That shared derivation is why the
 * caret can never disagree with the text it sits in — the failure mode when
 * layout and caret are computed separately.
 */

import { cells, visualWidth } from "./text";

export interface EditorRow {
  text: string;
  /** Index into the value at which this row starts. */
  start: number;
}

/**
 * Break `value` into display rows of at most `width` cells.
 *
 * Breaks at spaces where possible and mid-token where not, so a long pasted URL
 * cannot overflow. Rows carry their source offsets so caret position is a lookup
 * rather than a second, possibly-divergent calculation.
 */
export function layoutEditor(value: string, width: number): EditorRow[] {
  const safeWidth = Math.max(1, width);
  const rows: EditorRow[] = [];

  for (const paragraph of splitKeepingOffsets(value, "\n")) {
    if (paragraph.text.length === 0) {
      rows.push({ text: "", start: paragraph.start });
      continue;
    }

    let rowStart = paragraph.start;
    let current = "";
    let currentWidth = 0;
    /** Offset within `current` just after the most recent space. */
    let lastBreak = -1;

    for (const cell of cells(paragraph.text)) {
      if (currentWidth + cell.width > safeWidth) {
        if (lastBreak > 0 && lastBreak < current.length) {
          const head = current.slice(0, lastBreak);
          rows.push({ text: head, start: rowStart });
          const carried = current.slice(lastBreak);
          rowStart += head.length;
          current = carried;
          currentWidth = visualWidth(carried);
        } else {
          rows.push({ text: current, start: rowStart });
          rowStart += current.length;
          current = "";
          currentWidth = 0;
        }
        lastBreak = -1;
      }

      current += cell.text;
      currentWidth += cell.width;
      if (cell.text === " ") lastBreak = current.length;
    }

    rows.push({ text: current, start: rowStart });
  }

  return rows;
}

function splitKeepingOffsets(
  value: string,
  separator: string
): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  let start = 0;
  let index = value.indexOf(separator);

  while (index !== -1) {
    out.push({ text: value.slice(start, index), start });
    start = index + separator.length;
    index = value.indexOf(separator, start);
  }
  out.push({ text: value.slice(start), start });
  return out;
}

/** Locate the caret within laid-out rows. */
export function caretPosition(
  rows: EditorRow[],
  cursor: number
): { row: number; column: number } {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (cursor >= row.start) {
      const within = cursor - row.start;
      // A caret exactly at a soft-wrap boundary belongs at the start of the next
      // row, not one past the end of this one.
      if (within > row.text.length && i < rows.length - 1) continue;
      return {
        row: i,
        column: visualWidth(row.text.slice(0, Math.min(within, row.text.length))),
      };
    }
  }
  return { row: 0, column: 0 };
}

/** Value offset for a row/column pair, for vertical caret movement. */
export function offsetForRowColumn(
  rows: EditorRow[],
  rowIndex: number,
  column: number
): number {
  const row = rows[Math.max(0, Math.min(rowIndex, rows.length - 1))]!;
  let x = 0;
  let offset = 0;
  for (const cell of cells(row.text)) {
    if (x >= column) break;
    x += cell.width;
    offset += cell.text.length;
  }
  return row.start + offset;
}

/** Bytes to step back to clear one grapheme, so a cluster deletes as a unit. */
export function graphemeBefore(value: string, cursor: number): number {
  const graphemes = cells(value.slice(0, cursor));
  const last = graphemes[graphemes.length - 1];
  return last ? last.text.length : 1;
}

export function graphemeAfter(value: string, cursor: number): number {
  const first = cells(value.slice(cursor))[0];
  return first ? first.text.length : 1;
}

/** Start of the word before the cursor, for ctrl+w. */
export function wordStart(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && /\s/.test(value[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(value[i - 1]!)) i--;
  return i;
}

/**
 * Rows the editor will occupy, so the height budget can reserve them before the
 * frame is built — measuring after render would mean a visible one-frame jump.
 */
export function editorRowCount(value: string, width: number, cap: number): number {
  if (value.length === 0) return 1;
  return Math.min(cap, Math.max(1, layoutEditor(value, width).length));
}
