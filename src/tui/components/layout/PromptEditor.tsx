/**
 * The prompt editor (§16).
 *
 * Written from scratch rather than using `ink-text-input`, which is single-line,
 * has no history, and — the reason the old input's right border marched across
 * the screen as you typed — renders without any notion of the width it must live
 * within.
 *
 * **All edits are functional updates.** Ink parses a single stdin chunk into
 * several key events and dispatches them synchronously in one tick, so a handler
 * that computes its next value from props reads the same stale value for every
 * keystroke in the burst and all but the last character is lost. Typing quickly
 * or pasting is exactly that case. Every branch below therefore transforms
 * `prev`, never the props.
 *
 * Wrapping and caret arithmetic live in `core/editor`.
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import { UI_COLORS, UI_SYMBOLS } from "../../theme/tokens";
import { cells } from "../../core/text";
import {
  caretPosition,
  graphemeAfter,
  graphemeBefore,
  layoutEditor,
  offsetForRowColumn,
  wordStart,
} from "../../core/editor";

/** Rows of the editor shown before it scrolls internally. */
export const MAX_EDITOR_ROWS = 6;

export interface Draft {
  value: string;
  cursor: number;
}

interface PromptEditorProps {
  draft: Draft;
  /** Apply a transformation to the current draft. Never pass a bare value. */
  onEdit: (update: (prev: Draft) => Draft) => void;
  onSubmit: (value: string) => void;
  /** Navigate input history; returns the replacement value, or null. */
  onHistory: (direction: -1 | 1) => string | null;
  width: number;
  active: boolean;
  placeholder?: string;
}

export function PromptEditor({
  draft,
  onEdit,
  onSubmit,
  onHistory,
  width,
  active,
  placeholder = "",
}: PromptEditorProps) {
  const { value, cursor } = draft;

  const rows = React.useMemo(() => layoutEditor(value, width), [value, width]);
  const caret = React.useMemo(() => caretPosition(rows, cursor), [rows, cursor]);

  useInput(
    (input, key) => {
      const insert = (text: string) =>
        onEdit((prev) => ({
          value: prev.value.slice(0, prev.cursor) + text + prev.value.slice(prev.cursor),
          cursor: prev.cursor + text.length,
        }));

      // Paste and other multi-character bursts arrive as one event. Handle them
      // before key interpretation, or a pasted newline reads as Enter and submits
      // half a message.
      if (input.length > 1 && !key.ctrl && !key.meta) {
        insert(input.replace(/\r\n?/g, "\n"));
        return;
      }

      if (key.return) {
        // Shift+Enter (where the terminal reports it) and Alt+Enter insert a
        // newline; plain Enter submits.
        if (key.shift || key.meta) {
          insert("\n");
          return;
        }
        // A trailing backslash is the universal fallback, for terminals that
        // cannot report Shift+Enter at all.
        if (value.endsWith("\\")) {
          onEdit((prev) => {
            const next = prev.value.replace(/\\$/, "\n");
            return { value: next, cursor: next.length };
          });
          return;
        }
        if (value.trim().length > 0) onSubmit(value);
        return;
      }

      if (key.backspace || key.delete) {
        // Some terminals report Backspace as `delete`; only treat it as a forward
        // delete when the key is unambiguous.
        const forward = key.delete && !key.backspace;
        onEdit((prev) => {
          if (forward) {
            if (prev.cursor >= prev.value.length) return prev;
            const size = graphemeAfter(prev.value, prev.cursor);
            return {
              value: prev.value.slice(0, prev.cursor) + prev.value.slice(prev.cursor + size),
              cursor: prev.cursor,
            };
          }
          if (prev.cursor <= 0) return prev;
          const size = graphemeBefore(prev.value, prev.cursor);
          return {
            value: prev.value.slice(0, prev.cursor - size) + prev.value.slice(prev.cursor),
            cursor: prev.cursor - size,
          };
        });
        return;
      }

      if (key.leftArrow) {
        onEdit((prev) =>
          prev.cursor > 0
            ? { ...prev, cursor: prev.cursor - graphemeBefore(prev.value, prev.cursor) }
            : prev
        );
        return;
      }
      if (key.rightArrow) {
        onEdit((prev) =>
          prev.cursor < prev.value.length
            ? { ...prev, cursor: prev.cursor + graphemeAfter(prev.value, prev.cursor) }
            : prev
        );
        return;
      }

      if (key.upArrow) {
        // Within a multi-row value the arrow moves the caret; on the first row it
        // reaches for history — what a shell user expects.
        if (caret.row > 0) {
          onEdit((prev) => {
            const prevRows = layoutEditor(prev.value, width);
            const at = caretPosition(prevRows, prev.cursor);
            if (at.row === 0) return prev;
            return { ...prev, cursor: offsetForRowColumn(prevRows, at.row - 1, at.column) };
          });
          return;
        }
        const previous = onHistory(-1);
        if (previous !== null) onEdit(() => ({ value: previous, cursor: previous.length }));
        return;
      }
      if (key.downArrow) {
        if (caret.row < rows.length - 1) {
          onEdit((prev) => {
            const prevRows = layoutEditor(prev.value, width);
            const at = caretPosition(prevRows, prev.cursor);
            if (at.row >= prevRows.length - 1) return prev;
            return { ...prev, cursor: offsetForRowColumn(prevRows, at.row + 1, at.column) };
          });
          return;
        }
        const next = onHistory(1);
        if (next !== null) onEdit(() => ({ value: next, cursor: next.length }));
        return;
      }

      if (key.ctrl) {
        switch (input) {
          case "a":
            onEdit((prev) => {
              const prevRows = layoutEditor(prev.value, width);
              const at = caretPosition(prevRows, prev.cursor);
              return { ...prev, cursor: prevRows[at.row]?.start ?? 0 };
            });
            return;
          case "e":
            onEdit((prev) => {
              const prevRows = layoutEditor(prev.value, width);
              const at = caretPosition(prevRows, prev.cursor);
              const row = prevRows[at.row];
              return row ? { ...prev, cursor: row.start + row.text.length } : prev;
            });
            return;
          case "k":
            onEdit((prev) => ({ value: prev.value.slice(0, prev.cursor), cursor: prev.cursor }));
            return;
          case "u":
            onEdit((prev) => ({ value: prev.value.slice(prev.cursor), cursor: 0 }));
            return;
          case "w":
            onEdit((prev) => {
              const start = wordStart(prev.value, prev.cursor);
              return {
                value: prev.value.slice(0, start) + prev.value.slice(prev.cursor),
                cursor: start,
              };
            });
            return;
          default:
            return;
        }
      }

      if (key.meta || key.tab || key.escape || key.pageUp || key.pageDown) return;

      if (key.home) {
        onEdit((prev) => ({ ...prev, cursor: 0 }));
        return;
      }
      if (key.end) {
        onEdit((prev) => ({ ...prev, cursor: prev.value.length }));
        return;
      }

      if (input.length === 1 && input >= " ") insert(input);
    },
    { isActive: active }
  );

  const showPlaceholder = value.length === 0 && placeholder.length > 0;

  // Scroll the editor internally so a long prompt cannot grow the frame past its
  // reserved rows, keeping the caret in view.
  const firstVisible = Math.max(0, caret.row - (MAX_EDITOR_ROWS - 1));
  const visibleRows = rows.slice(firstVisible, firstVisible + MAX_EDITOR_ROWS);

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
                  {active && <Text inverse> </Text>}
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
 * A row with the caret drawn into it.
 *
 * The caret is inverse video over the character it occupies, so the row's width
 * is identical whether the caret is on it or not — a caret that added a cell
 * would shift the text after it on every keystroke.
 */
function CaretRow({ text, column }: { text: string; column: number }) {
  let before = "";
  let at = "";
  let after = "";
  let x = 0;

  for (const cell of cells(text)) {
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
