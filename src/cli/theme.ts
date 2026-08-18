import chalk from "chalk";

// ── Palette ──────────────────────────────────────────────────────────────────
export const success = chalk.green;
export const warn    = chalk.yellow;
export const error   = chalk.red;
export const info    = chalk.dim;
export const accent  = chalk.cyan;
export const bold    = chalk.bold;
export const muted   = chalk.gray;

// ── Symbols ──────────────────────────────────────────────────────────────────
export const sym = {
  ok:    success.bold("✓"),
  fail:  error.bold("✗"),
  bullet: info("›"),
  warn:  warn.bold("!"),
  dot:   info("·"),
  arrow: accent("→"),
  star:  accent("★"),
  heart: error("♥"),
  diamond: accent("◆"),
  square:  info("■"),
  circle:  info("●"),
  triangle: warn("▲"),
} as const;

// ── Box Drawing Characters ───────────────────────────────────────────────────
export const box = {
  // Single line
  topLeft:     "┌",
  topRight:    "┐",
  bottomLeft:  "└",
  bottomRight: "┘",
  horizontal:  "─",
  vertical:    "│",
  // Double line
  doubleTopLeft:     "╔",
  doubleTopRight:    "╗",
  doubleBottomLeft:  "╚",
  doubleBottomRight: "╝",
  doubleHorizontal:  "═",
  doubleVertical:    "║",
  // T junctions
  teeDown:  "┬",
  teeUp:    "┴",
  teeRight: "├",
  teeLeft:  "┤",
  cross:    "┼",
  // Mixed
  doubleTeeDown:  "╥",
  doubleTeeUp:    "╨",
  doubleTeeRight: "╠",
  doubleTeeLeft:  "╣",
} as const;

// ── Box Builders ─────────────────────────────────────────────────────────────

/**
 * Create a horizontal line with optional label
 */
export function hline(label: string = "", width: number = 60): string {
  if (!label) {
    return info(box.horizontal.repeat(width));
  }
  const labelStr = ` ${label} `;
  const padding = Math.max(0, width - labelStr.length);
  const leftPad = Math.floor(padding / 2);
  const rightPad = padding - leftPad;
  return info(
    box.horizontal.repeat(leftPad) +
    labelStr +
    box.horizontal.repeat(rightPad)
  );
}

/**
 * Create a double-line horizontal rule
 */
export function doubleHline(label: string = "", width: number = 60): string {
  if (!label) {
    return accent(box.doubleHorizontal.repeat(width));
  }
  const labelStr = ` ${label} `;
  const padding = Math.max(0, width - labelStr.length);
  const leftPad = Math.floor(padding / 2);
  const rightPad = padding - leftPad;
  return accent(
    box.doubleHorizontal.repeat(leftPad) +
    labelStr +
    box.doubleHorizontal.repeat(rightPad)
  );
}

/**
 * Wrap text in a single-line box
 */
export function wrapBox(content: string, opts: { 
  width?: number; 
  color?: typeof chalk;
  title?: string;
  padding?: number;
} = {}): string {
  const width = opts.width ?? 60;
  const color = opts.color ?? info;
  const pad = opts.padding ?? 1;
  const lines = content.split("\n");
  
  const result: string[] = [];
  
  // Top border with optional title
  if (opts.title) {
    const titleStr = ` ${opts.title} `;
    const remaining = width - 2 - titleStr.length;
    const leftDash = Math.floor(remaining / 2);
    const rightDash = remaining - leftDash;
    result.push(
      color(box.topLeft) +
      color(box.horizontal.repeat(leftDash)) +
      bold(titleStr) +
      color(box.horizontal.repeat(rightDash)) +
      color(box.topRight)
    );
  } else {
    result.push(
      color(box.topLeft) +
      color(box.horizontal.repeat(width - 2)) +
      color(box.topRight)
    );
  }
  
  // Content with padding
  const innerWidth = width - 2;
  for (const line of lines) {
    const stripped = line.replace(/\x1B\[[0-9;]*m/g, "");
    const visibleLen = stripped.length;
    const padLeft = Math.floor(pad);
    const padRight = Math.floor(pad);
    const contentPad = Math.max(0, innerWidth - padLeft - padRight - visibleLen);
    
    result.push(
      color(box.vertical) +
      " ".repeat(padLeft) +
      line +
      " ".repeat(padRight + contentPad) +
      color(box.vertical)
    );
  }
  
  // Bottom border
  result.push(
    color(box.bottomLeft) +
    color(box.horizontal.repeat(width - 2)) +
    color(box.bottomRight)
  );
  
  return result.join("\n");
}

/**
 * Create a double-line box (for emphasis)
 */
export function doubleBox(content: string, opts: { 
  width?: number; 
  title?: string;
  padding?: number;
} = {}): string {
  const width = opts.width ?? 60;
  const pad = opts.padding ?? 1;
  const lines = content.split("\n");
  
  const result: string[] = [];
  
  // Top border
  if (opts.title) {
    const titleStr = ` ${opts.title} `;
    const remaining = width - 2 - titleStr.length;
    const leftDash = Math.floor(remaining / 2);
    const rightDash = remaining - leftDash;
    result.push(
      accent(box.doubleTopLeft) +
      accent(box.doubleHorizontal.repeat(leftDash)) +
      bold(titleStr) +
      accent(box.doubleHorizontal.repeat(rightDash)) +
      accent(box.doubleTopRight)
    );
  } else {
    result.push(
      accent(box.doubleTopLeft) +
      accent(box.doubleHorizontal.repeat(width - 2)) +
      accent(box.doubleTopRight)
    );
  }
  
  // Content
  const innerWidth = width - 2;
  for (const line of lines) {
    const stripped = line.replace(/\x1B\[[0-9;]*m/g, "");
    const visibleLen = stripped.length;
    const padLeft = Math.floor(pad);
    const padRight = Math.floor(pad);
    const contentPad = Math.max(0, innerWidth - padLeft - padRight - visibleLen);
    
    result.push(
      accent(box.doubleVertical) +
      " ".repeat(padLeft) +
      line +
      " ".repeat(padRight + contentPad) +
      accent(box.doubleVertical)
    );
  }
  
  // Bottom border
  result.push(
    accent(box.doubleBottomLeft) +
    accent(box.doubleHorizontal.repeat(width - 2)) +
    accent(box.doubleBottomRight)
  );
  
  return result.join("\n");
}

/**
 * Create a section header with decorative borders
 */
export function sectionHeader(label: string, width: number = 60): string {
  return doubleHline(label, width);
}

/**
 * Format elapsed seconds, e.g. "1.2s".
 */
export function fmtElapsed(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${s.toFixed(0)}s`;
}

/**
 * Strip ANSI escape codes from a string for length calculation.
 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, "");
}

/**
 * Visible (unstyled) length of a string.
 */
export function visLen(s: string): number {
  return stripAnsi(s).length;
}

/**
 * Pad string to visible width.
 */
export function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visLen(s)));
}

/**
 * Dim horizontal rule.
 */
export function rule(width = 60): string {
  return info(box.horizontal.repeat(width));
}

/**
 * Print a section header: `── Label ────────────────`
 * Optionally appends a right-aligned result badge.
 */
export function section(label: string, suffix?: string): string {
  const tag = `── ${label} `;
  const minWidth = 60;
  const suffixLen = suffix ? visLen(suffix) : 0;
  const fill = Math.max(0, minWidth - tag.length - suffixLen);
  const fillStr = box.horizontal.repeat(fill);
  return suffix
    ? `${info(tag)}${fillStr}${suffix}`
    : `${info(tag)}${fillStr}`;
}

/**
 * Compact summary table row: `  Key           : value`
 */
export function row(key: string, value: string, w = 16): string {
  const p = " ".repeat(Math.max(0, w - key.length));
  return `  ${key}${p} : ${value}`;
}

/**
 * Build a compact summary box (no top/bottom borders — clean for terminals).
 */
export function summaryBox(rows: [string, string][], opts: { width?: number } = {}): string {
  const w = opts.width ?? 16;
  const lines = rows.map(([k, v]) => row(k, v, w));
  const maxLen = Math.max(60, ...lines.map((l) => visLen(l)));
  return [rule(maxLen), ...lines, rule(maxLen)].join("\n");
}

// ── JSON-safe output ─────────────────────────────────────────────────────────

/** True when --json is active; set by the CLI entry point. */
let jsonMode = false;
export function setJsonMode(on: boolean) { jsonMode = on; }
export function isJsonMode() { return jsonMode; }

/**
 * Conditionally print only if not in --json mode.
 */
export function print(...args: any[]): void {
  if (!jsonMode) console.log(...args);
}
export function printErr(...args: any[]): void {
  if (!jsonMode) console.error(...args);
}
