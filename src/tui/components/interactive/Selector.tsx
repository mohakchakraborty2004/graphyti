/**
 * Selector — the one keyboard-driven list in the app.
 *
 * Every choice surface (permission prompts, the command palette, any future
 * picker) uses this, so navigating a list feels identical everywhere and the
 * selected-item treatment is defined once: an accent `❯` marker plus bold text,
 * with two reserved cells so selection never shifts the row (§19, §31).
 */

import React from "react";
import { Box, Text } from "ink";
import { UI_COLORS, UI_SYMBOLS } from "../../theme/tokens";
import { truncateEnd, visualWidth } from "../../core/text";

export interface SelectorOption {
  value: string;
  label: string;
  /** Secondary text, dropped when the row is too narrow to hold it. */
  description?: string;
  /** Renders in the error colour — for destructive choices. */
  danger?: boolean;
}

interface SelectorProps {
  options: SelectorOption[];
  selectedIndex: number;
  width: number;
  /** Rows to show before scrolling the list. */
  maxRows?: number;
  narrow: boolean;
}

export function Selector({
  options,
  selectedIndex,
  width,
  maxRows = 8,
  narrow,
}: SelectorProps) {
  // Keep the selection inside the window, scrolling only as far as needed.
  const visibleCount = Math.min(maxRows, options.length);
  let start = 0;
  if (selectedIndex >= visibleCount) {
    start = Math.min(selectedIndex - visibleCount + 1, options.length - visibleCount);
  }
  const visible = options.slice(start, start + visibleCount);

  // The description column is aligned across rows, so labels of differing
  // lengths do not stagger their descriptions.
  const labelColumn = Math.max(...options.map((o) => visualWidth(o.label)));

  return (
    <Box flexDirection="column" flexShrink={0}>
      {start > 0 && (
        <Text color={UI_COLORS.muted} dimColor>
          {`  ${UI_SYMBOLS.scrollUp} ${start} more`}
        </Text>
      )}

      {visible.map((option, i) => {
        const index = start + i;
        const selected = index === selectedIndex;

        // Two cells are always reserved for the marker; only its glyph changes.
        const marker = selected ? `${UI_SYMBOLS.user} ` : "  ";
        const labelColor = option.danger
          ? UI_COLORS.error
          : selected
            ? UI_COLORS.accent
            : undefined;

        const used = 2 + labelColumn;
        const descriptionRoom = width - used - 2;
        const showDescription =
          !narrow && option.description !== undefined && descriptionRoom >= 8;

        return (
          <Box key={option.value} flexDirection="row" flexShrink={0}>
            <Text color={UI_COLORS.accent} bold>
              {marker}
            </Text>
            <Text color={labelColor} bold={selected}>
              {showDescription ? option.label.padEnd(labelColumn) : option.label}
            </Text>
            {showDescription && (
              <Text color={UI_COLORS.muted} dimColor wrap="truncate-end">
                {"  " + truncateEnd(option.description!, descriptionRoom)}
              </Text>
            )}
          </Box>
        );
      })}

      {start + visibleCount < options.length && (
        <Text color={UI_COLORS.muted} dimColor>
          {`  ${UI_SYMBOLS.scrollDown} ${options.length - start - visibleCount} more`}
        </Text>
      )}
    </Box>
  );
}

/**
 * Selection index state with wrap-around, shared by every list surface so that
 * navigation semantics cannot drift between them.
 */
export function useSelection(count: number, resetKey?: unknown) {
  const [index, setIndex] = React.useState(0);

  React.useEffect(() => {
    setIndex(0);
  }, [resetKey]);

  // A list that shrinks under the cursor must not leave it out of range.
  const clamped = count === 0 ? 0 : Math.min(index, count - 1);

  const move = React.useCallback(
    (delta: number) => {
      if (count === 0) return;
      setIndex((current) => {
        const next = (current + delta) % count;
        return next < 0 ? next + count : next;
      });
    },
    [count]
  );

  return { index: clamped, move, setIndex };
}
