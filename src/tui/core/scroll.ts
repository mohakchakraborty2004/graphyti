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
  /**
   * Whether each scroll marker has room to be drawn.
   *
   * Distinct from `hiddenAbove > 0`: on a viewport too short to hold both a row
   * of content and a marker, the marker is what gives way. Content outranks
   * chrome, the same rule the indent clamp follows. The viewport reads these
   * rather than re-deriving from the hidden counts, so the decision lives in one
   * place and stays consistent with `renderedHeight`.
   */
  markers: { above: boolean; below: boolean };
  /**
   * Total rows the viewport will draw, markers included.
   *
   * Callers budget against this rather than `visible.length`: the scroll markers
   * are part of the viewport's height, and treating them as free is what lets a
   * frame overflow by a row or two the moment content starts scrolling.
   */
  renderedHeight: number;
}

/**
 * Compute the visible window over `lines`.
 *
 * The marker reservation is circular — whether a marker is needed depends on the
 * window, which depends on how many rows the markers take — so it is resolved by
 * trying each reservation from zero upward and keeping the first that is
 * self-consistent. At most three iterations, and it terminates because a larger
 * reservation can only ever increase the number of hidden rows.
 */
export function computeWindow(lines: Line[], height: number, offset: number): Window {
  const total = lines.length;
  const rows = Math.max(1, height);

  if (total <= rows) {
    return {
      visible: lines,
      scroll: { offset: 0, hiddenAbove: 0, hiddenBelow: 0, following: true },
      markers: { above: false, below: false },
      renderedHeight: total,
    };
  }

  for (let reserve = 0; reserve <= 2; reserve++) {
    const contentRows = Math.max(1, rows - reserve);

    // Clamp so scrolling can never run past either end, however the content
    // changed since the offset was set — content grows under the user constantly.
    const maxOffset = Math.max(0, total - contentRows);
    const clamped = Math.max(0, Math.min(offset, maxOffset));

    const end = total - clamped;
    const start = Math.max(0, end - contentRows);

    const hiddenAbove = start;
    const hiddenBelow = total - end;
    const needed = (hiddenAbove > 0 ? 1 : 0) + (hiddenBelow > 0 ? 1 : 0);

    if (needed === reserve || reserve === 2) {
      const visible = lines.slice(start, end);

      // Draw a marker only if it fits. Below outranks above: not knowing there
      // is newer output is worse than not knowing there is older output.
      const room = rows - visible.length;
      const below = hiddenBelow > 0 && room >= 1;
      const above = hiddenAbove > 0 && room >= (below ? 2 : 1);

      return {
        visible,
        scroll: {
          offset: clamped,
          hiddenAbove,
          hiddenBelow,
          following: clamped === 0,
        },
        markers: { above, below },
        renderedHeight: visible.length + (above ? 1 : 0) + (below ? 1 : 0),
      };
    }
  }

  // Unreachable: the loop always returns at reserve === 2.
  return {
    visible: lines.slice(-rows),
    scroll: { offset: 0, hiddenAbove: total - rows, hiddenBelow: 0, following: true },
    markers: { above: false, below: false },
    renderedHeight: rows,
  };
}
