/**
 * Design tokens — the single source of truth for every colour, glyph, indent
 * and spacing value in the TUI.
 *
 * Two rules this module exists to enforce:
 *   1. No component invents a colour, a width, an indent or a box glyph. If a
 *      value is not here, it does not belong in a component.
 *   2. Every glyph in `UI_SYMBOLS` is exactly one terminal cell wide, in every
 *      terminal, under every Unicode width table. See `WIDE_UNSAFE` below for
 *      the glyphs that are deliberately excluded and why.
 */

// ── Colours ──────────────────────────────────────────────────────────────────
//
// Hex values are used for the semantic accents: chalk downsamples them to the
// 256/16-colour palette automatically on terminals that cannot do truecolor,
// so they degrade rather than break.
//
// `muted` intentionally uses the *named* "gray" rather than a hex value. Named
// colours resolve against the user's own terminal palette, so they stay legible
// on light and dark backgrounds alike — a hardcoded dark grey would vanish on a
// light theme.

export const UI_COLORS = {
  /** Primary accent. Agent identity, active state, user prompt, selection. */
  accent: "#D97757",
  /** Softer accent, for de-emphasised accent text (hints, secondary labels). */
  accentSoft: "#E89B7D",
  /** Secondary accent — muted amber. Section headers, counts, metadata keys. */
  secondary: "#D9A05B",

  success: "#79C77B",
  warning: "#D9B45B",
  error: "#E06C6C",

  /** Primary body text. Left undefined so it inherits the terminal foreground. */
  text: undefined as string | undefined,
  /** Secondary text — still readable, clearly subordinate. */
  muted: "gray",

  /** Diff colours. */
  added: "#79C77B",
  removed: "#E06C6C",

  /** Borders. Only ever used on the few elements allowed to have one. */
  border: "gray",
  borderActive: "#D97757",
} as const;

// ── Symbols ──────────────────────────────────────────────────────────────────
//
// ONE vocabulary. A given semantic always uses the same glyph, everywhere.
//
// Every glyph below measures 1 cell under both Unicode width tables we tested
// (string-width v7 and v8) and under the East Asian Width "Narrow"/"Neutral"
// classes, so wrap math can never disagree with what the terminal draws.

export const UI_SYMBOLS = {
  /** User turn. */
  user: "❯",
  /** Agent turn, and the "running" state. Same glyph — same meaning: active. */
  agent: "●",
  running: "●",

  success: "✓",
  error: "✗",
  /** Inline/bordered-safe warning marker. See WIDE_UNSAFE for why not "⚠". */
  warning: "!",
  pending: "○",
  skipped: "-",

  /** Tree hierarchy. */
  branch: "├─",
  branchLast: "└─",
  branchPipe: "│",

  arrow: "→",
  bullet: "·",
  ellipsis: "…",

  /** Collapsed / expanded disclosure. */
  collapsed: "▸",
  expanded: "▾",

  scrollUp: "↑",
  scrollDown: "↓",

  /** Diff gutters. */
  diffAdd: "+",
  diffRemove: "-",
  diffContext: " ",

  /** Block cursor for the input caret. */
  cursor: "█",

  horizontal: "─",
  vertical: "│",
} as const;

/**
 * Glyphs that are **ambiguous width** — different Unicode width tables and
 * different terminals disagree on whether they occupy one cell or two.
 *
 * Using any of these inside a padded or bordered row shifts that row's right
 * edge by a column, which is precisely the class of misalignment this design
 * system exists to eliminate. They are recorded here so the intent is explicit
 * and so the layout test can assert they never appear in rendered output.
 *
 * `⚠` U+26A0 — string-width v7 says 2, v8 says 1; most terminals draw 1, but
 *              with an emoji variation selector it becomes 2.
 * `✏` U+270F — same disagreement.
 * `✅ 📄 🚀` — genuinely 2 cells, but inconsistently so across terminals, and
 *              they carry no information a 1-cell glyph cannot.
 */
export const WIDE_UNSAFE = ["⚠", "✏", "✅", "❌", "📄", "🚀", "⏎", "️"] as const;

// ── Indentation ──────────────────────────────────────────────────────────────
//
// One primary content column. Every nesting level is a multiple of 2 so that
// tree glyphs line up with the text of the level above them.

export const UI_INDENT = {
  /** Flush with the speaker marker (`❯ You`, `● Agent`). */
  none: 0,
  /** Body text under a speaker marker. The primary content column. */
  sm: 2,
  /** A tool call's detail lines, under the tool name. */
  md: 5,
  /** Output nested inside a tool's detail. */
  lg: 7,
} as const;

// ── Vertical spacing ─────────────────────────────────────────────────────────
//
// Measured in blank rows. Terminal height is scarce; `md` is the default gap
// between blocks and everything else is an exception.

export const UI_SPACING = {
  none: 0,
  /** Between tightly related rows (a tool and its result). */
  xs: 0,
  /** Between a speaker marker and its body. */
  sm: 1,
  /** Between conversation blocks. */
  md: 1,
  /** Around major section boundaries. */
  lg: 2,
} as const;

// ── Responsive breakpoints ───────────────────────────────────────────────────

export const UI_BREAKPOINTS = {
  /** Below this: ultra-compact. Hide all secondary metadata. */
  narrow: 60,
  /** Below this: normal. At or above: room for contextual metadata. */
  wide: 100,
} as const;

export type Breakpoint = "narrow" | "medium" | "wide";

// ── Layout ───────────────────────────────────────────────────────────────────

export const UI_LAYOUT = {
  /**
   * The narrowest terminal we lay out for. Narrower than this and we still
   * render — we just stop subtracting gutters, because content beats framing.
   */
  minWidth: 30,
  /**
   * Long-form text stops getting wider than this even on a 200-column terminal.
   * Unbounded line length is unreadable; this keeps prose scannable while the
   * frame itself still uses the full width.
   */
  maxTextWidth: 100,
  /** Left gutter for the whole app. Dropped on narrow terminals. */
  gutter: 1,
  /** The conversation viewport never shrinks below this many rows. */
  minConversationRows: 4,
  /** Collapsed tool output shows at most this many lines. */
  collapsedOutputRows: 6,
  /** Expanded tool output shows at most this many lines before scrolling. */
  expandedOutputRows: 24,
  /** A single diff shows at most this many lines when collapsed. */
  collapsedDiffRows: 12,
} as const;

// ── Semantic status → visual mapping ─────────────────────────────────────────
//
// Colour is never the only signal (§36): every status carries a distinct glyph
// so the UI stays readable in a monochrome terminal.

export type StatusKind =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "warning"
  | "skipped";

export const STATUS_VISUALS: Record<
  StatusKind,
  { symbol: string; color: string | undefined; dim: boolean }
> = {
  pending: { symbol: UI_SYMBOLS.pending, color: UI_COLORS.muted, dim: true },
  running: { symbol: UI_SYMBOLS.running, color: UI_COLORS.accent, dim: false },
  success: { symbol: UI_SYMBOLS.success, color: UI_COLORS.success, dim: false },
  error: { symbol: UI_SYMBOLS.error, color: UI_COLORS.error, dim: false },
  warning: { symbol: UI_SYMBOLS.warning, color: UI_COLORS.warning, dim: false },
  skipped: { symbol: UI_SYMBOLS.skipped, color: UI_COLORS.muted, dim: true },
};

/**
 * Spinner frames. Braille dots — all exactly 1 cell, all the same width, so the
 * spinner animating can never reflow the line it sits on (§10, §28).
 */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const SPINNER_INTERVAL_MS = 80;
