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
import { computeWindow, type ScrollState } from "../../core/scroll";
import { Lines } from "../primitives";

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
  const { visible, scroll, markers } = computeWindow(live, height, scrollOffset);

  return (
    <>
      <FinalizedHistory history={history} width={width} />

      <Box flexDirection="column" flexShrink={0}>
        {markers.above && (
          <ScrollMarker
            direction="up"
            count={scroll.hiddenAbove}
            width={width}
            following={scroll.following}
          />
        )}

        <Lines lines={visible} width={width} />

        {markers.below && (
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
 * Keep Ink's append-only output out of the live animation render path. The
 * parent still updates for spinner frames, but this component only re-renders
 * when a completed block or terminal width actually changes.
 */
const FinalizedHistory = React.memo(function FinalizedHistory({
  history,
  width,
}: Pick<ConversationProps, "history" | "width">) {
  return (
    <Static items={history}>
      {(item) => (
        <Box key={item.id} flexDirection="column">
          <Lines lines={item.lines} width={width} />
        </Box>
      )}
    </Static>
  );
});

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
