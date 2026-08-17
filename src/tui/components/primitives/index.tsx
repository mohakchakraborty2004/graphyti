/**
 * Primitives — the only components that touch Ink directly for content.
 *
 * `Lines` is the single bridge between the line model and Ink. Everything that
 * displays conversation content goes through it, which is what keeps the
 * "wrapped exactly once, at a known width" guarantee intact: no other component
 * is in a position to let Ink re-wrap something.
 */

import React from "react";
import { Box, Text } from "ink";
import { clipLine, type Line, type Span } from "../../core/line";
import {
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  STATUS_VISUALS,
  UI_COLORS,
  UI_SYMBOLS,
  type StatusKind,
} from "../../theme/tokens";

// ── Lines ────────────────────────────────────────────────────────────────────

interface LinesProps {
  lines: Line[];
  /**
   * Hard clip width. Rows are already wrapped to this by the renderers; passing
   * it here is a backstop so a bug degrades to a clipped row rather than a
   * corrupted frame.
   */
  width: number;
}

/**
 * Draw pre-wrapped rows.
 *
 * `wrap="truncate-end"` is deliberate: the rows are already the right width, so
 * this only ever engages if something upstream is wrong. Letting Ink wrap
 * instead would reflow a row we had already measured, and a reflowed row is how
 * a border glyph ends up orphaned on its own line.
 */
export const Lines = React.memo(function Lines({ lines, width }: LinesProps) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {lines.map((l, i) => (
        <LineRow key={i} line={l} width={width} />
      ))}
    </Box>
  );
});

function LineRow({ line, width }: { line: Line; width: number }) {
  // An empty row must still occupy a row, hence the explicit space.
  if (line.length === 0) return <Text> </Text>;

  const clipped = clipLine(line, width);

  return (
    <Text wrap="truncate-end">
      {clipped.map((s, i) => (
        <SpanText key={i} span={s} />
      ))}
    </Text>
  );
}

function SpanText({ span }: { span: Span }) {
  return (
    <Text
      color={span.color}
      backgroundColor={span.backgroundColor}
      bold={span.bold}
      dimColor={span.dim}
      italic={span.italic}
      underline={span.underline}
      inverse={span.inverse}
    >
      {span.text}
    </Text>
  );
}

// ── Spinner ──────────────────────────────────────────────────────────────────

/**
 * Animated frame index, shared by every spinner on screen.
 *
 * One interval for the whole app rather than one per component: multiple
 * independent timers drift apart, and two spinners animating out of phase reads
 * as jitter. It also means the frame is available to pure renderers as a plain
 * string.
 */
export function useSpinnerFrame(active: boolean): string {
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((t) => t + 1), SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active]);

  // When idle, hold a stable frame so the glyph does not flicker on mount.
  return active ? SPINNER_FRAMES[tick % SPINNER_FRAMES.length]! : UI_SYMBOLS.running;
}

// ── Status icon ──────────────────────────────────────────────────────────────

/**
 * A status glyph in a fixed one-cell slot.
 *
 * Every glyph in the vocabulary is one cell wide (asserted in the text suite),
 * so switching status can never change this component's width and therefore can
 * never shift what sits beside it (§10, §28).
 */
export function StatusIcon({
  status,
  frame,
}: {
  status: StatusKind;
  frame?: string;
}) {
  const visual = STATUS_VISUALS[status];
  const glyph = status === "running" && frame ? frame : visual.symbol;

  return (
    <Text color={visual.color} bold={!visual.dim} dimColor={visual.dim}>
      {glyph}
    </Text>
  );
}

// ── Divider ──────────────────────────────────────────────────────────────────

export function Divider({ width }: { width: number }) {
  if (width <= 0) return null;
  return (
    <Text color={UI_COLORS.border} dimColor>
      {UI_SYMBOLS.horizontal.repeat(width)}
    </Text>
  );
}

// ── Key hints ────────────────────────────────────────────────────────────────

export interface KeyHint {
  keys: string;
  label: string;
}

/**
 * Contextual keyboard hints (§17).
 *
 * Hints are dropped from the end when they do not fit rather than wrapped: the
 * help row is fixed-height chrome, and a wrapping help row would change the
 * height budget and push the conversation around.
 */
export function KeyHints({ hints, width }: { hints: KeyHint[]; width: number }) {
  const separator = `  ${UI_SYMBOLS.bullet}  `;
  const parts: KeyHint[] = [];
  let used = 0;

  for (const hint of hints) {
    const cost =
      (parts.length > 0 ? separator.length : 0) + hint.keys.length + 1 + hint.label.length;
    if (used + cost > width) break;
    parts.push(hint);
    used += cost;
  }

  if (parts.length === 0) return <Text> </Text>;

  return (
    <Text wrap="truncate-end">
      {parts.map((hint, i) => (
        <React.Fragment key={hint.keys}>
          {i > 0 && (
            <Text color={UI_COLORS.muted} dimColor>
              {separator}
            </Text>
          )}
          <Text color={UI_COLORS.secondary}>{hint.keys}</Text>
          <Text color={UI_COLORS.muted} dimColor>
            {" " + hint.label}
          </Text>
        </React.Fragment>
      ))}
    </Text>
  );
}
