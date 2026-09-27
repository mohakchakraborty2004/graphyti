/**
 * Minimal leveled logger.
 *
 * The rest of the CLI talks to the user through `console.log` + theme helpers;
 * this is for the quieter stuff — the per-file decisions that are useful when
 * debugging a reingest but noise in normal operation.
 *
 * Level comes from `GRAPHYTI_LOG_LEVEL` (`debug` | `info` | `warn` | `error` |
 * `silent`) and defaults to `warn`.
 */

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
} as const;

export type LogLevel = keyof typeof LEVELS;

/** True when messages at `level` pass the configured threshold. */
export function levelEnabled(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[threshold];
}

function parseLevel(raw: string | undefined): LogLevel {
  const value = (raw ?? "").trim().toLowerCase();
  return value in LEVELS ? (value as LogLevel) : "warn";
}

let threshold: LogLevel = parseLevel(process.env.GRAPHYTI_LOG_LEVEL);

/** Change the level at runtime (tests, CLI flags). Returns the previous level. */
export function setLogLevel(level: LogLevel): LogLevel {
  const previous = threshold;
  threshold = level;
  return previous;
}

function timestamp(): string {
  return new Date().toISOString();
}

function emit(level: Exclude<LogLevel, "silent">, scope: string, args: unknown[]): void {
  if (!levelEnabled(level)) return;
  const prefix = `${timestamp()} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  const sink = level === "error" || level === "warn" ? console.error : console.log;
  sink(prefix, ...args);
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Create a logger tagged with `scope`, shown in every emitted line. */
export function createLogger(scope: string): Logger {
  return {
    debug: (...args) => emit("debug", scope, args),
    info: (...args) => emit("info", scope, args),
    warn: (...args) => emit("warn", scope, args),
    error: (...args) => emit("error", scope, args),
  };
}
