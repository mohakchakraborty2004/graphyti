/**
 * Console capture.
 *
 * The generation pipeline writes progress and diffs to `console.log` in over a
 * hundred places, and every one of those writes lands in the middle of a live
 * Ink frame. Rather than rewrite the pipeline's logging, capture it at the
 * boundary for the duration of a run and route it into the transcript as a
 * collapsed log block, where it is available but cannot overpower the
 * conversation (§34, §35).
 *
 * Ink's own `patchConsole` is not enough here: it relocates output above the
 * frame but keeps it as raw pre-styled text outside the layout system, so it
 * still wraps at whatever width the terminal happens to be.
 */

export interface ConsoleCapture {
  /** Stop capturing and restore the real console. Safe to call twice. */
  restore: () => void;
  /** Everything captured so far. */
  lines: () => string[];
}

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug" | "trace";

const METHODS: ConsoleMethod[] = ["log", "info", "warn", "error", "debug", "trace"];

/**
 * Redirect console output to `onLine` until the returned handle is restored.
 *
 * Each captured argument list is formatted the way the console would, then split
 * on newlines so downstream sees individual rows — the log renderer wraps rows
 * to the terminal width, and a row containing embedded newlines would break the
 * height accounting the viewport depends on.
 */
export function captureConsole(onLine?: (line: string) => void): ConsoleCapture {
  const collected: string[] = [];
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();
  let restored = false;

  const record = (args: unknown[]) => {
    const text = args.map(formatArg).join(" ");
    for (const row of text.split("\n")) {
      collected.push(row);
      onLine?.(row);
    }
  };

  for (const method of METHODS) {
    originals.set(method, console[method] as (...args: unknown[]) => void);
    console[method] = ((...args: unknown[]) => record(args)) as never;
  }

  return {
    restore() {
      if (restored) return;
      restored = true;
      for (const [method, original] of originals) {
        console[method] = original as never;
      }
    },
    lines: () => [...collected],
  };
}

function formatArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? arg.message;
  if (arg === null) return "null";
  if (arg === undefined) return "undefined";
  if (typeof arg === "object") {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

/** Strip ANSI so captured text can be restyled by our own renderers. */
export function decolorize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, "");
}
