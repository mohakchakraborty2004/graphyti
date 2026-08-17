/**
 * Terminal dimensions hook.
 *
 * A thin React wrapper over the pure arithmetic in `core/layout`. No component
 * may hardcode a width or read `process.stdout.columns` directly — they call
 * this and derive from what it returns, which is what makes terminal resize work
 * everywhere at once instead of in the places somebody remembered to handle it.
 */

import { useMemo } from "react";
import { useStdout, useWindowSize } from "ink";
import { computeLayout, type TerminalDimensions } from "../core/layout";

export type { TerminalDimensions, ChromeBudget } from "../core/layout";
export { chromeBudget, chromeRows, breakpointFor, computeLayout } from "../core/layout";

/**
 * Current terminal dimensions, recomputed on resize.
 *
 * `useWindowSize` re-renders the tree on SIGWINCH, so every consumer picks up
 * the new width in the same frame — no component can be left holding a stale one.
 */
export function useTerminalLayout(): TerminalDimensions {
  const { columns, rows } = useWindowSize();
  const { stdout } = useStdout();

  // `useWindowSize` reports 0 before the first measurement in some environments;
  // fall back to the stream's own view of the terminal.
  const width = columns > 0 ? columns : (stdout?.columns ?? 80);
  const height = rows > 0 ? rows : (stdout?.rows ?? 24);

  return useMemo(() => computeLayout(width, height), [width, height]);
}
