/**
 * Layout arithmetic — pure, so it can be evaluated at any width and height
 * without a terminal.
 *
 * Deliberately separate from the `useTerminalLayout` hook: the hook is a thin
 * React wrapper over these functions. Keeping the arithmetic free of any React
 * or Ink import is what lets the layout suite verify every breakpoint headlessly.
 */

import { UI_BREAKPOINTS, UI_LAYOUT, type Breakpoint } from "../theme/tokens";

export interface TerminalDimensions {
  /** Full terminal width in columns. */
  width: number;
  /** Full terminal height in rows. */
  height: number;
  /**
   * Width available to content, after the app gutter. Every block renderer
   * wraps to this.
   */
  contentWidth: number;
  /** Width available to the input editor, after its prompt marker. */
  inputWidth: number;
  /**
   * Width for long-form prose. Capped by `maxTextWidth` so a 200-column terminal
   * produces readable paragraphs rather than 200-character lines.
   */
  maxTextWidth: number;
  /** Left gutter, dropped entirely on narrow terminals. */
  gutter: number;
  /** Rows available to the conversation viewport, after fixed chrome. */
  conversationHeight: number;
  breakpoint: Breakpoint;
  isNarrow: boolean;
  isWide: boolean;
  /** Terminal is too short even for reduced chrome; drop optional chrome. */
  isCramped: boolean;
  /** Height or width is tight enough to warrant the compact chrome. */
  compact: boolean;
}

/** Fixed row costs of the app chrome, reserved before the conversation. */
export interface ChromeBudget {
  header: number;
  status: number;
  input: number;
  help: number;
}

/**
 * Rows the chrome occupies.
 *
 * Kept as data rather than measured at runtime: a measured chrome height that
 * changes as content changes is exactly what makes a layout jump (§28). These
 * numbers are asserted against what the components render, in the layout suite.
 */
export function chromeBudget(compact: boolean): ChromeBudget {
  return compact
    ? { header: 1, status: 1, input: 2, help: 1 }
    : { header: 2, status: 1, input: 3, help: 2 };
}

export function chromeRows(compact: boolean): number {
  const b = chromeBudget(compact);
  return b.header + b.status + b.input + b.help;
}

export function breakpointFor(width: number): Breakpoint {
  if (width < UI_BREAKPOINTS.narrow) return "narrow";
  if (width < UI_BREAKPOINTS.wide) return "medium";
  return "wide";
}

/** Compute a full layout from raw terminal dimensions. */
export function computeLayout(rawWidth: number, rawHeight: number): TerminalDimensions {
  // A terminal reporting 0 columns means "not a TTY, or not yet known". Fall
  // back to the classic 80x24 rather than laying out against zero.
  const width = Math.max(UI_LAYOUT.minWidth, rawWidth > 0 ? rawWidth : 80);
  const height = Math.max(6, rawHeight > 0 ? rawHeight : 24);

  const breakpoint = breakpointFor(width);
  const isNarrow = breakpoint === "narrow";
  const isWide = breakpoint === "wide";

  // Narrow terminals spend every column on content (§25, §37).
  const gutter = isNarrow ? 0 : UI_LAYOUT.gutter;
  const contentWidth = Math.max(UI_LAYOUT.minWidth - 2, width - gutter * 2);

  const maxTextWidth = Math.min(contentWidth, UI_LAYOUT.maxTextWidth);

  // The prompt marker is "❯ " — two cells, reserved so a wrapping caret cannot
  // push the editor past the right edge.
  const inputWidth = Math.max(1, contentWidth - 2);

  const compact = height < 20 || isNarrow;
  const chrome = chromeRows(compact);
  const conversationHeight = Math.max(
    UI_LAYOUT.minConversationRows,
    height - chrome
  );
  const isCramped = height - chrome < UI_LAYOUT.minConversationRows;

  return {
    width,
    height,
    contentWidth,
    inputWidth,
    maxTextWidth,
    gutter,
    conversationHeight,
    breakpoint,
    isNarrow,
    isWide,
    isCramped,
    compact,
  };
}
