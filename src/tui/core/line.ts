/**
 * The line model — the core of the layout system.
 *
 * Every piece of conversation content is rendered to `Line[]` *before* it
 * reaches Ink: a flat list of rows, each already wrapped to the exact available
 * width. Components then draw those rows verbatim.
 *
 * Three properties follow from that, and they are what the whole refactor rests
 * on:
 *
 *   1. **Overflow is impossible, not merely unlikely.** Wrapping happens once,
 *      in one place, against a known width. Ink never has to wrap for us, so it
 *      can never wrap somewhere we did not expect — which is what produced
 *      wrapped lines carrying stray border glyphs.
 *
 *   2. **Height is known before rendering.** `lines.length` *is* the block's
 *      height. That is what makes a bounded viewport, a scroll offset and a
 *      "input never gets pushed off screen" guarantee expressible at all.
 *
 *   3. **It is testable without a terminal.** A block is a pure function from
 *      data and width to rows, so the layout suite can assert the no-overflow
 *      invariant across every width and every state.
 *
 * Styling lives on spans rather than on nested Ink `<Box>`/`<Text>` elements,
 * because nested Ink layout is precisely what made widths implicit and
 * unpredictable in the previous implementation.
 */

import { UI_COLORS } from "../theme/tokens";
import { visualWidth, wrapText, cells, truncateEnd } from "./text";

/** A run of text sharing one style. */
export interface Span {
  text: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

/** One terminal row. Never contains a newline; never exceeds its target width. */
export type Line = Span[];

export type SpanStyle = Omit<Span, "text">;

/** Build a styled span. */
export function span(text: string, style: SpanStyle = {}): Span {
  return { text, ...style };
}

/** Build a line from spans, dropping empties so widths stay exact. */
export function line(...spans: Array<Span | null | undefined | false>): Line {
  return spans.filter((s): s is Span => Boolean(s) && (s as Span).text.length > 0);
}

/** An empty row — one blank line of vertical spacing. */
export function blank(): Line {
  return [];
}

/** Total visible width of a line. */
export function lineWidth(l: Line): number {
  let total = 0;
  for (const s of l) total += visualWidth(s.text);
  return total;
}

/** Concatenated plain text of a line, with styling discarded. */
export function lineText(l: Line): string {
  return l.map((s) => s.text).join("");
}

/** Prepend `n` spaces to a line. */
export function indentLine(l: Line, n: number): Line {
  if (n <= 0 || l.length === 0) return l;
  return [span(" ".repeat(n)), ...l];
}

/** Prepend `n` spaces to every line. */
export function indentLines(lines: Line[], n: number): Line[] {
  return lines.map((l) => indentLine(l, n));
}

/**
 * Hard safety net: clip a line to `width` cells.
 *
 * Nothing should ever reach this — every builder wraps to the width it was
 * given. It exists so that a bug in a future block renderer degrades to a
 * truncated row rather than a corrupted frame, and so the layout test can prove
 * the difference between "clipped" and "never needed clipping".
 */
export function clipLine(l: Line, width: number): Line {
  if (width <= 0) return [];
  if (lineWidth(l) <= width) return l;

  const out: Line = [];
  let used = 0;

  for (const s of l) {
    const remaining = width - used;
    if (remaining <= 0) break;

    const w = visualWidth(s.text);
    if (w <= remaining) {
      out.push(s);
      used += w;
      continue;
    }

    out.push({ ...s, text: truncateEnd(s.text, remaining) });
    used = width;
    break;
  }

  return out;
}

export function clipLines(lines: Line[], width: number): Line[] {
  return lines.map((l) => clipLine(l, width));
}

// ── Span-aware wrapping ──────────────────────────────────────────────────────

interface Token {
  text: string;
  width: number;
  style: SpanStyle;
  isSpace: boolean;
}

/**
 * Tokenise spans into words that each remember their own style, so a wrapped
 * line can carry several styles and a style can span a line break.
 *
 * Break opportunities after `/ \ . - _ , ? & = :` match `wrapText`, so a long
 * path or URL breaks at a meaningful boundary here too.
 */
function tokenizeSpans(spans: Line): Token[] {
  const tokens: Token[] = [];

  for (const s of spans) {
    const { text, ...style } = s;
    const expanded = text.replace(/\t/g, "    ");

    for (const chunk of expanded.split(/( )/)) {
      if (chunk.length === 0) continue;
      if (chunk === " ") {
        tokens.push({ text: " ", width: 1, style, isSpace: true });
        continue;
      }
      const fragments =
        chunk.length > 1 ? chunk.split(/(?<=[/\\.\-_,?&=:])/) : [chunk];
      for (const fragment of fragments) {
        if (fragment.length === 0) continue;
        tokens.push({
          text: fragment,
          width: visualWidth(fragment),
          style,
          isSpace: false,
        });
      }
    }
  }

  return tokens;
}

export interface WrapSpansOptions {
  /** Indent applied to every produced line. Counts against `maxWidth`. */
  indent?: number;
  /** Additional indent on continuation lines only. */
  hangingIndent?: number;
  /**
   * Spans repeated at the start of every continuation line — a tree pipe, a
   * gutter marker. Its width counts against the content budget.
   */
  continuationPrefix?: Line;
}

/**
 * Wrap styled spans to `maxWidth`, preserving styles across line breaks.
 *
 * Same guarantee as `wrapText`: no returned line exceeds `maxWidth`, for any
 * input, at any width.
 */
export function wrapSpans(
  spans: Line,
  maxWidth: number,
  options: WrapSpansOptions = {}
): Line[] {
  const { indent = 0, hangingIndent = 0, continuationPrefix } = options;
  if (maxWidth <= 0) return [];

  const tokens = tokenizeSpans(spans);
  if (tokens.length === 0) return [];

  const prefixWidth = continuationPrefix ? lineWidth(continuationPrefix) : 0;

  // Reserve room for the widest atomic grapheme, since clusters cannot split.
  let widest = 1;
  for (const token of tokens) {
    for (const cell of cells(token.text)) {
      if (cell.width > widest) widest = cell.width;
    }
  }

  const ceiling = Math.max(0, maxWidth - Math.min(maxWidth, widest));
  const firstIndent = Math.min(indent, ceiling);
  const contIndent = Math.min(indent + hangingIndent, ceiling);

  const out: Line[] = [];
  let current: Span[] = [];
  let currentWidth = 0;
  let isFirst = true;

  const budget = () =>
    maxWidth - (isFirst ? firstIndent : contIndent + prefixWidth);

  const flush = () => {
    if (current.length === 0) return;
    const leading = isFirst ? firstIndent : contIndent;
    const head: Line = [];
    if (leading > 0) head.push(span(" ".repeat(leading)));
    if (!isFirst && continuationPrefix) head.push(...continuationPrefix);
    out.push([...head, ...current]);
    isFirst = false;
    current = [];
    currentWidth = 0;
  };

  const push = (text: string, width: number, style: SpanStyle) => {
    const last = current[current.length - 1];
    // Merge adjacent same-style runs so the frame carries fewer escape codes.
    if (last && sameStyle(last, style)) {
      last.text += text;
    } else {
      current.push({ text, ...style });
    }
    currentWidth += width;
  };

  for (const token of tokens) {
    if (token.isSpace) {
      if (currentWidth > 0 && currentWidth + 1 <= budget()) {
        push(" ", 1, token.style);
      }
      continue;
    }

    if (currentWidth + token.width <= budget()) {
      push(token.text, token.width, token.style);
      continue;
    }

    if (currentWidth > 0) flush();

    if (token.width <= budget()) {
      push(token.text, token.width, token.style);
      continue;
    }

    // Token wider than a whole line: break it on cell boundaries.
    for (const cell of cells(token.text)) {
      if (cell.width > budget()) {
        if (currentWidth > 0) flush();
        if (budget() >= 1) {
          push("…", 1, token.style);
          flush();
        }
        continue;
      }
      if (currentWidth + cell.width > budget()) flush();
      push(cell.text, cell.width, token.style);
    }
  }

  flush();
  return out;
}

function sameStyle(a: Span, b: SpanStyle): boolean {
  return (
    a.color === b.color &&
    a.backgroundColor === b.backgroundColor &&
    Boolean(a.bold) === Boolean(b.bold) &&
    Boolean(a.dim) === Boolean(b.dim) &&
    Boolean(a.italic) === Boolean(b.italic) &&
    Boolean(a.underline) === Boolean(b.underline) &&
    Boolean(a.inverse) === Boolean(b.inverse)
  );
}

// ── Common builders ──────────────────────────────────────────────────────────

/**
 * Wrap plain body text into indented rows.
 *
 * The workhorse for prose: agent messages, descriptions, error explanations.
 */
export function textLines(
  text: string,
  maxWidth: number,
  options: { indent?: number; style?: SpanStyle; hangingIndent?: number } = {}
): Line[] {
  const { indent = 0, style = {}, hangingIndent = 0 } = options;
  return wrapText(text, maxWidth, { indent, hangingIndent }).map((row) => {
    const lead = row.match(/^ */)?.[0] ?? "";
    const body = row.slice(lead.length);
    return line(lead.length > 0 ? span(lead) : null, body.length > 0 ? span(body, style) : null);
  });
}

/**
 * A labelled row: `label  value`, with the value wrapped under a hanging indent
 * so it stays in its own column instead of running back under the label.
 */
export function labelledLines(
  label: string,
  value: string,
  maxWidth: number,
  options: {
    indent?: number;
    labelWidth?: number;
    labelStyle?: SpanStyle;
    valueStyle?: SpanStyle;
  } = {}
): Line[] {
  const {
    indent = 0,
    labelWidth,
    labelStyle = { color: UI_COLORS.muted },
    valueStyle = {},
  } = options;

  const gap = labelWidth ?? visualWidth(label) + 2;
  const labelCell = label.padEnd(gap - 0, " ").slice(0, Math.max(gap, label.length));

  return wrapSpans(
    line(span(labelCell, labelStyle), span(value, valueStyle)),
    maxWidth,
    { indent, hangingIndent: gap }
  );
}

/** A horizontal rule spanning `width` cells. */
export function dividerLine(width: number, style: SpanStyle = { color: UI_COLORS.border, dim: true }): Line {
  if (width <= 0) return [];
  return [span("─".repeat(width), style)];
}
