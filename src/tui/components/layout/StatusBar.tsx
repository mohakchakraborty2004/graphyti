/**
 * Status bar and contextual help (§17, §22).
 *
 * Both are fixed-height chrome. The status row occupies exactly one row whether
 * or not anything is happening — rendering nothing when idle would change the
 * height budget and shift the conversation every time a run started or stopped,
 * which is the layout jump §28 forbids.
 *
 * Key hints are derived exhaustively from `SessionState`, so a new state cannot
 * be added without deciding what the user is allowed to press in it. Only the
 * keys that are live right now are shown; a static list of every shortcut
 * teaches nothing.
 */

import React from "react";
import { Box, Text } from "ink";
import { UI_COLORS, UI_SYMBOLS } from "../../theme/tokens";
import { truncateEnd } from "../../core/text";
import { formatElapsed } from "../../render/blocks";
import { KeyHints } from "../primitives";
import { hintsFor, type HintContext } from "../../core/hints";
import { isBusy, SESSION_LABELS, type SessionState } from "../../state/types";

// ── Status bar ───────────────────────────────────────────────────────────────

interface StatusBarProps {
  state: SessionState;
  /** What the agent is doing right now, e.g. "Retrieving codebase context". */
  activity: string | null;
  elapsedMs: number;
  spinnerFrame: string;
  width: number;
  narrow: boolean;
}

export function StatusBar({
  state,
  activity,
  elapsedMs,
  spinnerFrame,
  width,
  narrow,
}: StatusBarProps) {
  const busy = isBusy(state);

  if (state === "idle") {
    // Reserved, empty. Holds the row so nothing below it moves.
    return <Text> </Text>;
  }

  const label = activity ?? SESSION_LABELS[state];
  const timing = busy && !narrow ? formatElapsed(elapsedMs) : "";

  const marker = busy
    ? spinnerFrame
    : state === "error"
      ? UI_SYMBOLS.error
      : state === "cancelled"
        ? UI_SYMBOLS.skipped
        : state === "success"
          ? UI_SYMBOLS.success
          : UI_SYMBOLS.agent;

  const markerColor = busy
    ? UI_COLORS.accent
    : state === "error"
      ? UI_COLORS.error
      : state === "success"
        ? UI_COLORS.success
        : state === "waiting_for_permission"
          ? UI_COLORS.warning
          : UI_COLORS.muted;

  // The timer is right-aligned into reserved space, so its digits growing from
  // "9.9s" to "10s" cannot nudge the label beside it.
  const timingWidth = timing.length > 0 ? timing.length + 2 : 0;
  const labelWidth = Math.max(1, width - 2 - timingWidth);
  const ellipsis = busy ? UI_SYMBOLS.ellipsis : "";
  const shown = truncateEnd(`${label}${ellipsis}`, labelWidth);

  return (
    <Box flexDirection="row" flexShrink={0}>
      <Text color={markerColor} bold>
        {marker}
      </Text>
      <Text> </Text>
      <Text color={busy ? undefined : markerColor} wrap="truncate-end">
        {shown}
      </Text>
      {timing.length > 0 && (
        <>
          <Box flexGrow={1} />
          <Text color={UI_COLORS.muted} dimColor>
            {timing}
          </Text>
        </>
      )}
    </Box>
  );
}

// ── Contextual key hints ─────────────────────────────────────────────────────

export function HelpBar({
  ctx,
  width,
  compact,
}: {
  ctx: HintContext;
  width: number;
  compact: boolean;
}) {
  const hints = hintsFor(ctx);

  return (
    <Box flexDirection="column" flexShrink={0}>
      {!compact && <Text> </Text>}
      <KeyHints hints={hints} width={width} />
    </Box>
  );
}
