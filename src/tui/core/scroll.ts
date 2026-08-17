/**
 * Scroll model (§27) — pure, so every offset can be verified headlessly.
 *
 * The viewport is a window over pre-measured rows. Because every block was
 * already wrapped to a known width, `lines.length` is the exact height, so the
 * window can show the tail that fits and report precisely how much lies outside
 * it.
 *
 * Auto-follow falls out of the representation rather than needing a flag: offset
 * 0 *means* pinned to the newest row, so new output is followed while the user is
 * at the bottom and left alone while they are not.
 */

import type { Line } from "./line";

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

export interface Window {
  visible: Line[];
  scroll: ScrollState;
}

/** Compute the visible window over `lines`. */
export function computeWindow(lines: Line[], height: number, offset: number): Window {
  const total = lines.length;
  const rows = Math.max(1, height);

  if (total <= rows) {
    return {
      visible: lines,
      scroll: { offset: 0, hiddenAbove: 0, hiddenBelow: 0, following: true },
    };
  }

  // Clamp so scrolling can never run past either end, however the content
  // changed since the offset was set — content grows under the user constantly.
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
