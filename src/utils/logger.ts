import fs from "fs";
import path from "path";
import { env } from "../config";

/**
 * File logging for Graphyti runs.
 *
 * The terminal is a poor place to look after the fact: spinners redraw their
 * own line, the TUI collapses captured stdout behind `/debug`, and `--json`
 * prints a single object. A run that misbehaved — a verification block, a
 * command the allowlist refused, a plan that stopped three steps in — leaves
 * nothing readable once it has scrolled away. This appends those events to a
 * file instead.
 *
 * Three rules this module exists to enforce:
 *   1. Logging can never break a run. Every filesystem call is wrapped; a full
 *      disk or a read-only directory disables file logging for good and the
 *      pipeline carries on exactly as it would have.
 *   2. It never writes secrets. Details pass through a key/value redactor
 *      before they reach disk, so a stray `apiKey` in a payload is never
 *      persisted.
 *   3. It never writes to stdout/stderr. The TUI owns the terminal surface and
 *      captures console output to replay it; a logger that printed would tear
 *      the live frame, and `--json` consumers would see non-JSON lines.
 *
 * Default location: `<projectRoot>/.dbagent/logs/graphyti.log` — `.dbagent` is
 * already this tool's own ignored directory (`graph-map.json`,
 * `context.json`), so logs land next to the state they describe and never
 * appear in the target project's diff. `GRAPHYTI_LOG` overrides the path, and
 * `GRAPHYTI_LOG=off` turns file logging off entirely.
 *
 * Format — one line per event, stable and greppable:
 *
 *   2026-09-27T10:12:03.412Z INFO  verification.result {"passed":true,...}
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerConfig {
  /** Root of the project being changed; the default log lives under it. */
  projectRoot?: string;
  /**
   * Explicit log file. Absolute paths are used as-is; relative paths resolve
   * against `projectRoot`, so a target project's `.dbagent` never depends on
   * whatever directory graphyti happened to be launched from.
   */
  logFile?: string;
  /** Turn file logging off for this run, whatever `GRAPHYTI_LOG` says. */
  disabled?: boolean;
}

/** Values of `GRAPHYTI_LOG` that mean "no file logging". */
const OFF_VALUES = new Set(["off", "0", "false", "no", "none"]);

/** Rotate once the log passes this size; the previous file becomes `.1`. */
const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** Individual values longer than this are elided rather than written whole. */
const MAX_VALUE_CHARS = 500;

/** Hard cap on a single line, so one pathological payload cannot bloat the file. */
const MAX_LINE_CHARS = 4000;

/** Arrays are logged head-only; a 10k-element plan is not a log line. */
const MAX_ARRAY_ITEMS = 50;

/** Nesting deeper than this is summarized rather than walked. */
const MAX_DEPTH = 6;

/** Detail keys whose values are never written to disk, at any depth. */
const SECRET_KEY_RE =
  /(api[-_]?key|apikey|token|secret|pass(word|wd)|authorization|credential|private[-_]?key|session[-_]?id)/i;

/** Values that are secrets even when the key looks innocent. */
const SECRET_VALUE_RE =
  /^(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|gh[pousr]_[A-Za-z0-9]{8,}|hydradb_[A-Za-z0-9]{8,})$/i;

interface LoggerState {
  projectRoot: string;
  /** False until a path has been decided (configureLogger or lazy default). */
  resolved: boolean;
  /** `null` once resolved means logging is off. */
  file: string | null;
  /** Set after the first write failure — the reason, and the signal to stop. */
  failure: string | null;
  /** Bytes written this process, used to rotate without stat'ing every line. */
  bytes: number;
  /** Size check happens once, on the first write. */
  sizeChecked: boolean;
  /** Directory is created on demand, once. */
  dirReady: boolean;
}

function freshState(projectRoot: string): LoggerState {
  return {
    projectRoot,
    resolved: false,
    file: null,
    failure: null,
    bytes: 0,
    sizeChecked: false,
    dirReady: false,
  };
}

let state: LoggerState = freshState(process.cwd());

/** `<projectRoot>/.dbagent/logs/graphyti.log` — beside graph-map.json. */
function defaultLogFile(projectRoot: string): string {
  return path.join(projectRoot, ".dbagent", "logs", "graphyti.log");
}

/** Absolute paths pass through; anything else is relative to the project root. */
function resolveTarget(target: string, projectRoot: string): string {
  return path.isAbsolute(target) ? target : path.resolve(projectRoot, target);
}

/** Read `GRAPHYTI_LOG` through config — the single source of env truth. */
function envTarget(): string | undefined {
  return env.graphytiLog;
}

/** `GRAPHYTI_LOG=off` and friends mean "no file logging, ever". */
function envDisabled(): boolean {
  const raw = env.graphytiLog;
  return raw !== undefined && OFF_VALUES.has(raw.toLowerCase());
}

/**
 * Point the logger at a project for the rest of the run.
 *
 * Called once per run, before anything is logged — the CLI action, the TUI
 * launch, and `init-graph` each do this with the project root they are about
 * to work on. Safe to call again: state resets and the next write re-resolves.
 *
 * @returns the file that will be written, or `null` when logging is off.
 */
export function configureLogger(config: LoggerConfig = {}): string | null {
  const projectRoot = config.projectRoot ?? state.projectRoot ?? process.cwd();
  state = freshState(projectRoot);

  if (config.disabled || envDisabled()) {
    state.resolved = true;
    state.file = null;
    return null;
  }

  const target = config.logFile ?? envTarget();
  state.file = target ? resolveTarget(target, projectRoot) : defaultLogFile(projectRoot);
  state.resolved = true;
  return state.file;
}

/** The file currently being written, or `null` when logging is off. */
export function currentLogFile(): string | null {
  if (!state.resolved) configureLogger({ projectRoot: state.projectRoot });
  return state.file;
}

/**
 * Drop all logger state. Tests use this between cases; production callers
 * should prefer `configureLogger`, which resets and re-points in one call.
 */
export function resetLogger(): void {
  state = freshState(process.cwd());
}

/**
 * Append one event. Never throws, never prints.
 *
 * @param level   severity, for grepping (`grep ERROR graphyti.log`)
 * @param event   dotted, stable name — `stage.name`, not prose
 * @param details structured payload; redacted and truncated before writing
 */
export function logEvent(
  level: LogLevel,
  event: string,
  details?: Record<string, unknown>
): void {
  try {
    if (!state.resolved) configureLogger({ projectRoot: state.projectRoot });
    // A previous failure already decided this. Re-trying on every line would
    // turn a read-only directory into a syscall storm on a long run.
    const file = state.file;
    if (state.failure || !file) return;

    const dir = path.dirname(file);
    if (!state.dirReady) {
      fs.mkdirSync(dir, { recursive: true });
      state.dirReady = true;
    }

    if (!state.sizeChecked) {
      state.sizeChecked = true;
      try {
        state.bytes = fs.statSync(file).size;
      } catch {
        state.bytes = 0; // not created yet
      }
      if (state.bytes >= MAX_LOG_BYTES) rotate(file);
    }

    const line = formatLine(level, event, details);
    fs.appendFileSync(file, line, "utf-8");
    state.bytes += Buffer.byteLength(line, "utf-8");
    if (state.bytes >= MAX_LOG_BYTES) rotate(file);
  } catch (err) {
    // Logging is an observability aid, never a correctness dependency: record
    // why we stopped and disable the file rather than surface the error.
    state.failure = err instanceof Error ? err.message : String(err);
    state.file = null;
  }
}

/** Move an oversized log aside so the next line starts a fresh file. */
function rotate(file: string): void {
  const previous = `${file}.1`;
  try {
    fs.rmSync(previous, { force: true });
    fs.renameSync(file, previous);
  } catch {
    // Rotation is best-effort. A failure here must not disable logging — the
    // file just keeps growing, which is the behaviour without rotation at all.
  }
  state.bytes = 0;
  state.sizeChecked = true;
}

export function logDebug(event: string, details?: Record<string, unknown>): void {
  logEvent("debug", event, details);
}
export function logInfo(event: string, details?: Record<string, unknown>): void {
  logEvent("info", event, details);
}
export function logWarn(event: string, details?: Record<string, unknown>): void {
  logEvent("warn", event, details);
}
export function logError(event: string, details?: Record<string, unknown>): void {
  logEvent("error", event, details);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatLine(
  level: LogLevel,
  event: string,
  details?: Record<string, unknown>
): string {
  const timestamp = new Date().toISOString();
  const levelTag = level.toUpperCase().padEnd(5, " ");
  const payload = details === undefined ? "" : ` ${safeJson(details)}`;
  let line = `${timestamp} ${levelTag} ${event}${payload}`;
  if (line.length > MAX_LINE_CHARS) {
    line = `${line.slice(0, MAX_LINE_CHARS - 1)}…`;
  }
  return `${line}\n`;
}

function safeJson(details: Record<string, unknown>): string {
  try {
    return JSON.stringify(redact(details)) ?? "{}";
  } catch {
    return `{"_unserializable":true}`;
  }
}

/**
 * Deep copy with secrets removed and oversized values elided.
 *
 * Both keys and values are checked: a payload keyed `apiKey` is redacted
 * whatever it holds, and a value that *looks* like a credential (`sk-…`,
 * `Bearer …`) is redacted whatever it is keyed. Depth and array caps keep a
 * runaway payload from turning a log line into a dump of the whole plan.
 */
function redact(value: unknown, depth = 0): unknown {
  if (value === null) return null;

  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncate(value.message),
      stack: value.stack ? truncate(value.stack) : undefined,
    };
  }

  switch (typeof value) {
    case "string":
      return SECRET_VALUE_RE.test(value) ? "[REDACTED]" : truncate(value);
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return String(value);
    case "undefined":
      return undefined;
    case "function":
      return `[function ${value.name || "anonymous"}]`;
    case "symbol":
      return String(value);
    default:
      break;
  }

  if (depth >= MAX_DEPTH) return "[depth limit]";

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redact(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`… ${value.length - MAX_ARRAY_ITEMS} more`);
    }
    return items;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_RE.test(key) ? "[REDACTED]" : redact(entry, depth + 1);
  }
  return out;
}

function truncate(value: string): string {
  if (value.length <= MAX_VALUE_CHARS) return value;
  return `${value.slice(0, MAX_VALUE_CHARS)}… (+${value.length - MAX_VALUE_CHARS} chars)`;
}
