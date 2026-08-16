import chalk from "chalk";

// ── Palette ──────────────────────────────────────────────────────────────────
export const success = chalk.green;
export const warn    = chalk.yellow;
export const error   = chalk.red;
export const info    = chalk.dim;
export const accent  = chalk.cyan;
export const bold    = chalk.bold;

// ── Symbols ──────────────────────────────────────────────────────────────────
export const sym = {
  ok:    success.bold("✓"),
  fail:  error.bold("✗"),
  bullet: info("›"),
  warn:  warn.bold("!"),
} as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Format elapsed seconds, e.g. "1.2s". */
export function fmtElapsed(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${s.toFixed(0)}s`;
}

/** Strip ANSI escape codes from a string for length calculation. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, "");
}

/** Visible (unstyled) length of a string. */
export function visLen(s: string): number {
  return stripAnsi(s).length;
}

/** Pad string to visible width. */
export function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visLen(s)));
}

/** Dim horizontal rule. */
export function rule(width = 60): string {
  return info("─".repeat(width));
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
  const fillStr = "─".repeat(fill);
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
