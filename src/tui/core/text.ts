/**
 * Text measurement and wrapping — the only place in the TUI that decides how
 * wide a string is or where it breaks.
 *
 * Why hand-rolled instead of `string-width`: two copies of that package are
 * installed at different major versions, and they disagree by one column on
 * ambiguous-width glyphs (`⚠` U+26A0, `✏` U+270F). Layout math that disagrees
 * with the renderer by one column is exactly the bug class this system exists
 * to remove, so measurement is defined once, here, and differential-tested
 * against the copy Ink's renderer actually uses.
 *
 * Width model: East Asian Wide and Fullwidth are 2 cells, default-presentation
 * emoji are 2 cells, combining marks and zero-width joiners are 0, everything
 * else is 1. Ambiguous-width glyphs resolve to 1 — the narrow interpretation,
 * which is what Ink's renderer and virtually every modern terminal use.
 */

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /[][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

const ASCII_PRINTABLE = /^[ -~]*$/;

/** Combining marks and enclosing marks occupy no cell of their own. */
const ZERO_WIDTH_MARK = /^[\p{Mn}\p{Me}]$/u;

/**
 * Emoji that default to emoji (colour, double-width) presentation. Note this is
 * deliberately NOT `\p{Extended_Pictographic}`: glyphs like `✓` and `→` are
 * pictographic but default to *text* presentation and occupy a single cell.
 */
const EMOJI_WIDE = /^\p{Emoji_Presentation}$/u;

const ZERO_WIDTH_CODEPOINTS = new Set([
  0x200b, // zero width space
  0x200c, // zero width non-joiner
  0x200d, // zero width joiner
  0x200e, // LTR mark
  0x200f, // RTL mark
  0xfeff, // BOM
]);

function isVariationSelector(cp: number): boolean {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
}

/** East Asian Wide (W) and Fullwidth (F) ranges. */
function isWideCodepoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x17000 && cp <= 0x18aff) ||
    (cp >= 0x1b000 && cp <= 0x1b12f) ||
    (cp >= 0x1b170 && cp <= 0x1b2ff) ||
    (cp >= 0x1f200 && cp <= 0x1f2ff) ||
    (cp >= 0x1f300 && cp <= 0x1f5ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

let segmenter: Intl.Segmenter | undefined;
function graphemes(text: string): string[] {
  if (typeof Intl?.Segmenter === "function") {
    segmenter ??= new Intl.Segmenter("en", { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

/** Strip ANSI escape sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * Width of a single grapheme cluster in terminal cells.
 *
 * A cluster is measured as a unit — `👨‍👩‍👦` is one 2-cell glyph, not three —
 * which is why this operates on clusters rather than code points.
 */
function graphemeWidth(cluster: string): number {
  const first = cluster.codePointAt(0);
  if (first === undefined) return 0;

  // Control characters render as nothing (or garbage); never reserve space.
  if (first < 0x20 || (first >= 0x7f && first <= 0x9f)) return 0;
  if (ZERO_WIDTH_CODEPOINTS.has(first)) return 0;
  if (ZERO_WIDTH_MARK.test(cluster)) return 0;

  // An explicit emoji variation selector forces 2-cell emoji presentation on an
  // otherwise-1-cell glyph, e.g. "⚠" (1) vs "⚠️" (2).
  for (const ch of cluster) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xfe0f) return 2;
  }

  if (EMOJI_WIDE.test(cluster[0]!) || isWideCodepoint(first)) return 2;
  return 1;
}

/** Visible width of `text` in terminal cells, ignoring ANSI escapes. */
export function visualWidth(text: string): number {
  if (text.length === 0) return 0;
  // Fast path: printable ASCII is always one cell per character.
  if (ASCII_PRINTABLE.test(text)) return text.length;

  const plain = stripAnsi(text);
  if (ASCII_PRINTABLE.test(plain)) return plain.length;

  let width = 0;
  for (const cluster of graphemes(plain)) {
    if (isVariationSelector(cluster.codePointAt(0)!)) continue;
    width += graphemeWidth(cluster);
  }
  return width;
}

/**
 * Split `text` into an array of grapheme clusters paired with their widths, so
 * callers can slice on cell boundaries without re-measuring.
 */
export function cells(text: string): Array<{ text: string; width: number }> {
  if (ASCII_PRINTABLE.test(text)) {
    return Array.from(text, (ch) => ({ text: ch, width: 1 }));
  }
  return graphemes(text).map((g) => ({ text: g, width: graphemeWidth(g) }));
}

/** Pad `text` on the right to exactly `width` cells. Never truncates. */
export function padEnd(text: string, width: number): string {
  const gap = width - visualWidth(text);
  return gap > 0 ? text + " ".repeat(gap) : text;
}

/** Pad `text` on the left to exactly `width` cells. Never truncates. */
export function padStart(text: string, width: number): string {
  const gap = width - visualWidth(text);
  return gap > 0 ? " ".repeat(gap) + text : text;
}

/** Centre `text` within `width` cells. */
export function padCenter(text: string, width: number): string {
  const gap = width - visualWidth(text);
  if (gap <= 0) return text;
  const left = Math.floor(gap / 2);
  return " ".repeat(left) + text + " ".repeat(gap - left);
}

/**
 * Truncate to `width` cells, appending an ellipsis when anything was dropped.
 * Cell-accurate: a double-width glyph is never split down the middle.
 */
export function truncateEnd(text: string, width: number): string {
  if (width <= 0) return "";
  if (visualWidth(text) <= width) return text;
  if (width === 1) return "…";

  const budget = width - 1;
  let used = 0;
  let out = "";
  for (const cell of cells(text)) {
    if (used + cell.width > budget) break;
    out += cell.text;
    used += cell.width;
  }
  return out + "…";
}

/**
 * Truncate from the middle, preserving both ends. The right choice for file
 * paths and identifiers, where the tail carries as much meaning as the head.
 */
export function truncateMiddle(text: string, width: number): string {
  if (width <= 0) return "";
  if (visualWidth(text) <= width) return text;
  if (width <= 3) return "…";

  const budget = width - 1;
  const headBudget = Math.ceil(budget / 2);
  const tailBudget = budget - headBudget;

  const all = cells(text);

  let head = "";
  let headUsed = 0;
  for (const cell of all) {
    if (headUsed + cell.width > headBudget) break;
    head += cell.text;
    headUsed += cell.width;
  }

  let tail = "";
  let tailUsed = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const cell = all[i]!;
    if (tailUsed + cell.width > tailBudget) break;
    tail = cell.text + tail;
    tailUsed += cell.width;
  }

  return head + "…" + tail;
}

// ── Wrapping ─────────────────────────────────────────────────────────────────

export interface WrapOptions {
  /**
   * Cells of indentation on every line. Counts against `maxWidth`, so the
   * result is always `maxWidth` cells wide overall, never `maxWidth + indent`.
   */
  indent?: number;
  /** Extra indentation on continuation lines only, for hanging indents. */
  hangingIndent?: number;
  /**
   * Break tokens longer than the available width mid-token instead of letting
   * them overflow. Always safe to leave on for terminal output; the only reason
   * to disable it is when a caller has already broken the token itself.
   *
   * @default true
   */
  breakLongTokens?: boolean;
  /**
   * Preserve each source line's own leading whitespace on its wrapped
   * continuations. Use for code and pre-formatted output, not prose.
   *
   * @default false
   */
  preserveIndent?: boolean;
  /**
   * Collapse runs of whitespace and trim each line. Correct for prose, wrong
   * for code.
   *
   * @default true
   */
  normalizeWhitespace?: boolean;
}

/** Width of the widest single grapheme in `text`. Zero for empty input. */
function widestGrapheme(text: string): number {
  if (ASCII_PRINTABLE.test(text)) return text.length > 0 ? 1 : 0;
  let widest = 0;
  for (const cell of cells(text)) {
    if (cell.width > widest) widest = cell.width;
  }
  return widest;
}

/**
 * Wrap `text` to `maxWidth` cells.
 *
 * Guarantees, for any input: every returned line measures at most `maxWidth`
 * cells, and no returned line contains a newline. When `maxWidth` is too small
 * to fit even one cell of content, returns `[]` rather than overflowing.
 */
export function wrapText(text: string, maxWidth: number, options: WrapOptions = {}): string[] {
  const {
    indent = 0,
    hangingIndent = 0,
    breakLongTokens = true,
    preserveIndent = false,
    normalizeWhitespace = true,
  } = options;

  if (maxWidth <= 0) return [];

  const out: string[] = [];
  // Tabs are width-0 under our model and would silently disappear; expand them
  // so indentation in code and command output survives wrapping.
  const sourceLines = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");

  for (const sourceLine of sourceLines) {
    const ownIndent = preserveIndent ? (sourceLine.match(/^[ ]*/)?.[0].length ?? 0) : 0;
    const body = normalizeWhitespace
      ? sourceLine.trim().replace(/\s+/g, " ")
      : sourceLine.slice(ownIndent);

    if (body.length === 0) {
      out.push("");
      continue;
    }

    // Indentation counts against the total width, so on a terminal too narrow
    // to hold both the indent and a unit of content, the indent is what gives
    // way. Content always wins: clamping here is what keeps the guarantee that
    // no returned line exceeds `maxWidth`, at any width, for any indent.
    //
    // The reserved amount is the width of the widest grapheme on this line, not
    // one cell — a grapheme cluster cannot be split across lines, so a 2-cell
    // CJK character or emoji needs 2 cells reserved or it would overhang.
    const minContent = Math.min(maxWidth, widestGrapheme(body));
    const indentCeiling = Math.max(0, maxWidth - minContent);
    const firstPrefix = Math.min(indent + ownIndent, indentCeiling);
    const contPrefix = Math.min(indent + ownIndent + hangingIndent, indentCeiling);

    const firstAvail = maxWidth - firstPrefix;
    const contAvail = maxWidth - contPrefix;

    const tokens = splitTokens(body, contAvail);

    let line = "";
    let lineWidth = 0;
    let isFirst = true;
    const avail = () => (isFirst ? firstAvail : contAvail);
    const prefix = () => " ".repeat(isFirst ? firstPrefix : contPrefix);

    const flush = () => {
      if (line.length === 0) return;
      out.push(prefix() + line);
      isFirst = false;
      line = "";
      lineWidth = 0;
    };

    for (const token of tokens) {
      const tokenWidth = visualWidth(token);

      // A space that would land past the edge is simply dropped.
      if (token === " ") {
        if (lineWidth > 0 && lineWidth + 1 <= avail()) {
          line += " ";
          lineWidth += 1;
        }
        continue;
      }

      if (lineWidth + tokenWidth <= avail()) {
        line += token;
        lineWidth += tokenWidth;
        continue;
      }

      // Does not fit on the current line.
      if (lineWidth > 0) flush();

      if (tokenWidth <= avail()) {
        line = token;
        lineWidth = tokenWidth;
        continue;
      }

      // Token is wider than a whole line.
      if (!breakLongTokens) {
        line = token;
        lineWidth = tokenWidth;
        flush();
        continue;
      }

      for (const chunk of breakToken(token, avail, () => {
        flush();
      })) {
        line = chunk.text;
        lineWidth = chunk.width;
        if (chunk.full) flush();
      }
    }

    flush();
  }

  return out;
}

/**
 * Split into tokens, keeping single spaces as their own tokens so the wrapper can
 * decide whether a space survives a line break.
 *
 * Tokens wider than `fitWidth` are additionally split after `/ \ . - _ , ? & = :`
 * so that long paths and URLs break at meaningful boundaries. That split is a
 * *fallback for tokens that cannot fit*, not a default: applying it universally
 * would break ordinary prose at every full stop, turning "Next.js" into "Next."
 * and an orphaned "js".
 */
function splitTokens(text: string, fitWidth: number): string[] {
  const words = text.split(/( )/).filter((t) => t.length > 0);
  const out: string[] = [];

  for (const word of words) {
    if (word === " " || word.length <= 1) {
      out.push(word);
      continue;
    }

    // Fits on a line as-is: no reason to look for break points inside it.
    if (visualWidth(word) <= fitWidth) {
      out.push(word);
      continue;
    }

    // Keep the separator attached to the end of the preceding fragment, so a
    // wrapped path reads "src/auth/" + "session.ts" rather than "src/auth" +
    // "/session.ts".
    const fragments = word.split(/(?<=[/\\.\-_,?&=:])/).filter((f) => f.length > 0);
    if (fragments.length === 1) {
      out.push(word);
      continue;
    }
    out.push(...fragments);
  }

  return out;
}

function breakToken(
  token: string,
  avail: () => number,
  _onFull: () => void
): Array<{ text: string; width: number; full: boolean }> {
  const chunks: Array<{ text: string; width: number; full: boolean }> = [];
  let current = "";
  let currentWidth = 0;
  let limit = avail();

  for (const cell of cells(token)) {
    // A grapheme wider than an entire line cannot be rendered at this width and
    // cannot be split — a cluster is atomic. Mark the elision rather than
    // overflowing the line or silently dropping the character.
    if (cell.width > limit) {
      if (currentWidth > 0) {
        chunks.push({ text: current, width: currentWidth, full: true });
        current = "";
        currentWidth = 0;
        limit = avail();
      }
      if (cell.width > limit) {
        if (limit >= 1) {
          chunks.push({ text: "…", width: 1, full: true });
          limit = avail();
        }
        continue;
      }
    }

    if (currentWidth + cell.width > limit) {
      chunks.push({ text: current, width: currentWidth, full: true });
      current = "";
      currentWidth = 0;
      limit = avail();
    }
    current += cell.text;
    currentWidth += cell.width;
  }

  if (current.length > 0) {
    chunks.push({ text: current, width: currentWidth, full: false });
  }
  return chunks;
}

/**
 * Wrap a file path, breaking only at separators.
 *
 * A path is far more scannable broken at directory boundaries than at arbitrary
 * cell positions, so this is preferred over `wrapText` for anything path-like.
 * Falls back to a hard break for a single segment longer than the line.
 */
export function wrapPath(filePath: string, maxWidth: number, indent = 0): string[] {
  if (maxWidth <= 0) return [];
  // As in wrapText: content outranks indentation when the two cannot coexist,
  // and the reserved amount is the widest grapheme, since clusters are atomic.
  const minContent = Math.min(maxWidth, widestGrapheme(filePath));
  const effectiveIndent = Math.min(indent, Math.max(0, maxWidth - minContent));
  const avail = maxWidth - effectiveIndent;
  const pad = " ".repeat(effectiveIndent);

  if (visualWidth(filePath) <= avail) return [pad + filePath];

  const segments = filePath.split(/(?<=[/\\])/);
  const out: string[] = [];
  let line = "";

  for (const segment of segments) {
    const segWidth = visualWidth(segment);
    const lineWidth = visualWidth(line);

    if (lineWidth > 0 && lineWidth + segWidth > avail) {
      out.push(pad + line);
      line = "";
    }

    if (segWidth > avail) {
      // One segment longer than the line: hard-break it on cell boundaries.
      let chunk = "";
      let chunkWidth = 0;
      for (const cell of cells(segment)) {
        if (cell.width > avail) {
          // Un-renderable at this width and atomic; mark the elision.
          if (chunkWidth > 0) {
            out.push(pad + chunk);
            chunk = "";
            chunkWidth = 0;
          }
          if (avail >= 1) out.push(pad + "…");
          continue;
        }
        if (chunkWidth + cell.width > avail) {
          out.push(pad + chunk);
          chunk = "";
          chunkWidth = 0;
        }
        chunk += cell.text;
        chunkWidth += cell.width;
      }
      line = chunk;
      continue;
    }

    line += segment;
  }

  if (line.length > 0) out.push(pad + line);
  return out;
}
