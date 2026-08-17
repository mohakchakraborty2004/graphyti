/**
 * Conversation viewport — the scrolling model (§27) and the height budget (§26).
 *
 * Two mechanisms, deliberately separated:
 *
 *   **Finalised history** goes through Ink's `<Static>`, which writes rows once,
 *   above the live frame, and never redraws them. That hands scrollback to the
 *   terminal itself, which means unlimited history, native selection and copy,
 *   no flicker, and — critically — history that *cannot* push the input off
 *   screen, because it is not part of the live frame at all.
 *
 *   **The live turn** is a bounded window over pre-measured rows. Because every
 *   block was already wrapped to a known width, `lines.length` is the exact
 *   height, so the window can show the tail that fits and report precisely how
 *   much is above it.
 *
 * Auto-follow falls out of this: the live window is pinned to the tail while
 * `scrollOffset` is 0, and a user who scrolls up sets a non-zero offset, which
 * suppresses following until they return to the bottom (§27). Their terminal's
 * own scroll position is never touched.
 */

import React from "react";
import { Box, Static, Text } from "ink";
import { UI_COLORS, UI_SYMBOLS } from "../../theme/tokens";
import type { Line } from "../../core/line";
import { Lines } from "../primitives";

export interface ScrollState {
  /** Rows scrolled up from the bottom. 0 means pinned to the newest content. */
  offset: number;
  /** Rows hidden above the window at the current offset. */
  hiddenAbove: number;
  /** Rows hidden below the window — non-zero only while scrolled up. */
  hiddenBelow: number;
  /** True when pinned to the bottom, i.e. auto-following new output. */
  following: boolean;
}

/**
 * Compute the visible window over `lines`.
 *
 * Pure, so the scroll model can be tested exhaustively without a terminal.
 */
export function computeWindow(
  lines: Line[],
  height: number,
  offset: number
): { visible: Line[]; scroll: ScrollState } {
  const total = lines.length;
  const rows = Math.max(1, height);

  if (total <= rows) {
    return {
      visible: lines,
      scroll: { offset: 0, hiddenAbove: 0, hiddenBelow: 0, following: true },
    };
  }

  // Clamp so scrolling can never run past either end, no matter how the content
  // changed since the offset was set.
  const maxOffset = total - rows;
  const clamped = Math.max(0, Math.min(offset, maxOffset));

  const end = total - clamped;
  const start = end - rows;

  return {
    visible: lines.slice(start, end),
    scroll: {
      offset: clamped,
      hiddenAbove: start,
      hiddenBelow: total - end,
      following: clamped === 0,
    },
  };
}

interface ConversationProps {
  /** Finalised rows, grouped so `<Static>` can flush them incrementally. */
  history: Array<{ id: string; lines: Line[] }>;
  /** Rows for the in-flight turn. */
  live: Line[];
  width: number;
  height: number;
  scrollOffset: number;
}

export function Conversation({
  history,
  live,
  width,
  height,
  scrollOffset,
}: ConversationProps) {
  const { visible, scroll } = computeWindow(live, height, scrollOffset);

  return (
    <>
      {/*
        Static rows leave the live frame permanently once written. Keying by a
        stable id is what lets Ink append only what is new.
      */}
      <Static items={history}>
        {(item) => (
          <Box key={item.id} flexDirection="column">
            <Lines lines={item.lines} width={width} />
          </Box>
        )}
      </Static>

      <Box flexDirection="column" flexShrink={0}>
        {scroll.hiddenAbove > 0 && (
          <ScrollMarker
            direction="up"
            count={scroll.hiddenAbove}
            width={width}
            following={scroll.following}
          />
        )}

        <Lines lines={visible} width={width} />

        {scroll.hiddenBelow > 0 && (
          <ScrollMarker
            direction="down"
            count={scroll.hiddenBelow}
            width={width}
            following={scroll.following}
          />
        )}
      </Box>
    </>
  );
}

/**
 * Marks content outside the window, so being scrolled up is never ambiguous —
 * the user always knows whether they are seeing the newest output (§22, §27).
 */
function ScrollMarker({
  direction,
  count,
  width,
  following,
}: {
  direction: "up" | "down";
  count: number;
  width: number;
  following: boolean;
}) {
  const arrow = direction === "up" ? UI_SYMBOLS.scrollUp : UI_SYMBOLS.scrollDown;
  const label =
    direction === "down" && !following
      ? `${count} newer line${count === 1 ? "" : "s"}  ${UI_SYMBOLS.bullet}  end to follow`
      : `${count} more line${count === 1 ? "" : "s"}`;

  const text = `${arrow} ${label}`;

  return (
    <Text wrap="truncate-end">
      <Text color={direction === "down" && !following ? UI_COLORS.accent : UI_COLORS.muted} dimColor={following}>
        {text.length > width ? text.slice(0, Math.max(0, width)) : text}
      </Text>
    </Text>
  );
}
