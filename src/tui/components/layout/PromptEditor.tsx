/**
 * The prompt editor (§16).
 *
 * Written from scratch rather than using `ink-text-input`, which is single-line,
 * has no history, and — the reason the old input's right border marched across
 * the screen as you typed — renders without any notion of the width it has to
 * live within.
 *
 * The model is a single string plus a cursor index. Everything visual is derived
 * from that: display rows come from wrapping the value to `width`, and the
 * caret's row/column come from the same wrap, so the caret can never disagree
 * with the text it sits in.
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import { UI_COLORS, UI_SYMBOLS } from "../../theme/tokens";
import { cells, visualWidth } from "../../core/text";

/** Rows of the editor the input area will ever show before scrolling. */
const MAX_VISIBLE_ROWS = 6;

export interface EditorRow {
  text: string;
  /** Index into the value at which this row starts. */
  start: number;
}

/**
 * Break `value` into display rows of at most `width` cells.
 *
 * Breaks at spaces when possible and mid-token when not, so a long unbroken
 * paste cannot overflow. Rows are returned with their source offsets so caret
 * position is a lookup rather than a second, possibly-divergent calculation.
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
    let lastBreak = -1;

    const graphemes = cells(paragraph.text);
    let offset = 0;

    for (const cell of graphemes) {
      if (currentWidth + cell.width > safeWidth) {
        // Prefer breaking at the last space in this row; fall back to a hard
        // break so an unbroken token still fits.
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
      offset += cell.text.length;
      if (cell.text === " ") lastBreak = current.length;
    }

    rows.push({ text: current, start: rowStart });
  }

  return rows;
}

function splitKeepingOffsets(value: string, separator: string): Array<{ text: string; start: number }> {
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

/** Locate the caret within the laid-out rows. */
export function caretPosition(
  rows: EditorRow[],
  cursor: number
): { row: number; column: number } {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (cursor >= row.start) {
      const within = cursor - row.start;
      // A caret exactly at a soft-wrap boundary belongs at the start of the next
      // row, not past the end of this one.
      if (within > row.text.length && i < rows.length - 1) continue;
      return {
        row: i,
        column: visualWidth(row.text.slice(0, Math.min(within, row.text.length))),
      };
    }
  }
  return { row: 0, column: 0 };
}

interface PromptEditorProps {
  value: string;
  cursor: number;
  onChange: (value: string, cursor: number) => void;
  onSubmit: (value: string) => void;
  /** Navigate input history; returns the replacement value or null. */
  onHistory: (direction: -1 | 1) => string | null;
  width: number;
  active: boolean;
  placeholder?: string;
}

export function PromptEditor({
  value,
  cursor,
  onChange,
  onSubmit,
  onHistory,
  width,
  active,
  placeholder = "",
}: PromptEditorProps) {
  const rows = React.useMemo(() => layoutEditor(value, width), [value, width]);
  const caret = React.useMemo(() => caretPosition(rows, cursor), [rows, cursor]);

  useInput(
    (input, key) => {
      // Paste and other multi-character bursts arrive as a single event. Handle
      // them before key interpretation, or a pasted newline reads as Enter and
      // submits half a message.
      if (input.length > 1 && !key.ctrl && !key.meta) {
        const normalized = input.replace(/\r\n?/g, "\n");
        insert(normalized);
        return;
      }

      if (key.return) {
        // Shift+Enter (where the terminal reports it) and Alt/Meta+Enter insert a
        // newline; plain Enter submits.
        if (key.shift || key.meta) {
          insert("\n");
          return;
        }
        // Trailing backslash is a universally-supported continuation, for
        // terminals that cannot report Shift+Enter at all.
        if (value.endsWith("\\")) {
          const next = value.slice(0, -1) + "\n";
          onChange(next, next.length);
          return;
        }
        if (value.trim().length > 0) onSubmit(value);
        return;
      }

      if (key.backspace || key.delete) {
        // Some terminals report Backspace as `delete`; treat Delete-forward only
        // when the key is unambiguous.
        if (key.delete && !key.backspace && cursor < value.length) {
          onChange(value.slice(0, cursor) + value.slice(cursor + 1), cursor);
          return;
        }
        if (cursor > 0) {
          const removed = graphemeBefore(value, cursor);
          onChange(value.slice(0, cursor - removed) + value.slice(cursor), cursor - removed);
        }
        return;
      }

      if (key.leftArrow) {
        if (cursor > 0) onChange(value, cursor - graphemeBefore(value, cursor));
        return;
      }
      if (key.rightArrow) {
        if (cursor < value.length) onChange(value, cursor + graphemeAfter(value, cursor));
        return;
      }

      if (key.upArrow) {
        // Within a multi-row value the arrow moves the caret; on the first row it
        // reaches for history, which is the behaviour a shell user expects.
        if (caret.row > 0) {
          onChange(value, offsetForRowColumn(rows, caret.row - 1, caret.column));
          return;
        }
        const previous = onHistory(-1);
        if (previous !== null) onChange(previous, previous.length);
        return;
      }
      if (key.downArrow) {
        if (caret.row < rows.length - 1) {
          onChange(value, offsetForRowColumn(rows, caret.row + 1, caret.column));
          return;
        }
        const next = onHistory(1);
        if (next !== null) onChange(next, next.length);
        return;
      }

      if (key.ctrl) {
        switch (input) {
          case "a":
            onChange(value, rows[caret.row]!.start);
            return;
          case "e": {
            const row = rows[caret.row]!;
            onChange(value, row.start + row.text.length);
            return;
          }
          case "k":
            onChange(value.slice(0, cursor), cursor);
            return;
          case "u":
            onChange(value.slice(cursor), 0);
            return;
          case "w": {
            const start = wordStart(value, cursor);
            onChange(value.slice(0, start) + value.slice(cursor), start);
            return;
          }
          default:
            return;
        }
      }

      if (key.meta) return;
      if (key.tab || key.escape || key.pageUp || key.pageDown) return;

      if (key.home) {
        onChange(value, 0);
        return;
      }
      if (key.end) {
        onChange(value, value.length);
        return;
      }

      if (input.length === 1 && input >= " ") insert(input);

      function insert(text: string) {
        const next = value.slice(0, cursor) + text + value.slice(cursor);
        onChange(next, cursor + text.length);
      }
    },
    { isActive: active }
  );

  const showPlaceholder = value.length === 0 && placeholder.length > 0;
  const visibleRows = rows.slice(
    Math.max(0, caret.row - (MAX_VISIBLE_ROWS - 1)),
    Math.max(MAX_VISIBLE_ROWS, caret.row + 1)
  );
  const firstVisible = Math.max(0, caret.row - (MAX_VISIBLE_ROWS - 1));

  return (
    <Box flexDirection="column" flexShrink={0}>
      {visibleRows.map((row, i) => {
        const rowIndex = firstVisible + i;
        const isCaretRow = rowIndex === caret.row && active;

        return (
          <Box key={rowIndex} flexDirection="row" flexShrink={0}>
            {/* Marker on the first row only; continuations align beneath it. */}
            <Text color={UI_COLORS.accent} bold>
              {rowIndex === 0 ? `${UI_SYMBOLS.user} ` : "  "}
            </Text>
            <Text wrap="truncate-end">
              {showPlaceholder && rowIndex === 0 ? (
                <>
                  {active && <Text inverse>{" "}</Text>}
                  <Text color={UI_COLORS.muted} dimColor>
                    {placeholder}
                  </Text>
                </>
              ) : isCaretRow ? (
                <CaretRow text={row.text} column={caret.column} />
              ) : (
                <Text>{row.text}</Text>
              )}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * A row with the caret drawn in it.
 *
 * The caret is an inverse-video cell over the character it sits on, which keeps
 * the row's width identical whether the caret is visible or not — a caret that
 * added a cell would shift the text after it on every keystroke.
 */
function CaretRow({ text, column }: { text: string; column: number }) {
  const graphemes = cells(text);
  let before = "";
  let at = "";
  let after = "";
  let x = 0;

  for (const cell of graphemes) {
    if (x < column) before += cell.text;
    else if (at.length === 0) at = cell.text;
    else after += cell.text;
    x += cell.width;
  }

  return (
    <>
      <Text>{before}</Text>
      <Text inverse>{at.length > 0 ? at : " "}</Text>
      <Text>{after}</Text>
    </>
  );
}

// ── Cursor helpers ───────────────────────────────────────────────────────────

/** Bytes to step back to clear one grapheme, so a cluster deletes as a unit. */
function graphemeBefore(value: string, cursor: number): number {
  const head = value.slice(0, cursor);
  const graphemes = cells(head);
  const last = graphemes[graphemes.length - 1];
  return last ? last.text.length : 1;
}

function graphemeAfter(value: string, cursor: number): number {
  const tail = value.slice(cursor);
  const graphemes = cells(tail);
  const first = graphemes[0];
  return first ? first.text.length : 1;
}

function wordStart(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && /\s/.test(value[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(value[i - 1]!)) i--;
  return i;
}

function offsetForRowColumn(rows: EditorRow[], rowIndex: number, column: number): number {
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
