/**
 * Run log for the agent.
 *
 * Every other trace of a run is transient: the CLI's output scrolls away, and the
 * TUI's captured log block dies with the process. When a run goes wrong — a
 * verification failure, a stale edit, a step that wrote nothing — the only
 * evidence left is whatever was on screen at the time. This writes that evidence
 * down instead, one JSON object per line, one file per run.
 *
 * A run is scoped to the async flow that started it, so two API queries in
 * flight at once get two files rather than one interleaved one, and `log.*`
 * still needs no arguments in the shared pipeline, which never learns a run
 * happened.
 *
 * Four rules, in priority order:
 *
 * 1. **Never break a run.** Every write is wrapped. The first failure disables
 *    logging for the rest of the run rather than retrying: a full disk or a
 *    read-only project is not something retrying fixes, and a diagnostic aid that
 *    can abort a working run is worse than no log at all.
 * 2. **Never touch the terminal.** Writes go to a file through `fs`, never
 *    through `console`. The TUI owns the screen and captures console for the
 *    duration of a run; a stray write there tears the live frame.
 * 3. **Never record a secret.** Values are redacted on the way in, and callers
 *    log shapes and sizes rather than prompts and file contents.
 * 4. **Stay bounded.** Long values are truncated and old runs are pruned, so the
 *    log directory cannot grow without limit in somebody else's repo.
 */

import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { AsyncLocalStorage } from "async_hooks";

export const LOG_LEVELS = ["off", "error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const DEFAULT_LEVEL: LogLevel = "info";
const RANK: Record<LogLevel, number> = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };

/** Run files kept in the log directory. The oldest are pruned beyond this. */
const KEEP_RUNS = 20;

/** Longest value written verbatim. Anything larger is truncated. */
const MAX_VALUE_CHARS = 500;

/** Where run logs live, relative to the project being worked on. */
const LOG_DIR_SEGMENTS = [".dbagent", "logs"] as const;

export interface LogFields {
  [key: string]: unknown;
}

interface ActiveRun {
  runId: string;
  level: LogLevel;
  /** Absolute path, or null when the log is off or could not be opened. */
  file: string | null;
  /** Merged into every record of this run. */
  fields: LogFields;
  startedAt: number;
  /** Set once a write fails; the run keeps going, silently. */
  broken: boolean;
  /** Set by endAgentRun, so a stale reference stops writing. */
  ended: boolean;
}

/**
 * The run each async flow is logging to.
 *
 * The API server answers two queries at once, so "the current run" cannot be a
 * module global: with one, whichever request started last would swallow the
 * other's lines and close its log mid-flight. Keyed by async context, two
 * in-flight runs keep two files, and `log.*` still needs no arguments in the
 * shared pipeline, which has no way to receive a run.
 */
const storage = new AsyncLocalStorage<ActiveRun>();

/** The run `log.*` should join: this flow's run, or the last one started. */
function currentRun(): ActiveRun | null {
  const run = storage.getStore() ?? active;
  return run && !run.ended ? run : null;
}

let active: ActiveRun | null = null;
/** A level given on the command line, by a launcher with nowhere to pass it. */
let launcherLevel: LogLevel | null = null;

// ---------------------------------------------------------------------------
// Level
// ---------------------------------------------------------------------------

/** Parse a level, tolerating case and the aliases people actually type. */
export function parseLogLevel(value: string | undefined): LogLevel | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "silent" || normalized === "none" || normalized === "quiet") return "off";
  if (normalized === "verbose" || normalized === "trace" || normalized === "all") return "debug";
  return (LOG_LEVELS as readonly string[]).includes(normalized) ? (normalized as LogLevel) : null;
}

/**
 * The level a new run should use: the caller's choice, then the level given on
 * the command line, then `GRAPHYTI_LOG`, then `info`.
 *
 * A command-line flag outranks the env var because someone typed it; the env var
 * is the standing default for whoever set up the machine. An unparseable value
 * falls through to the next source rather than throwing — a typo in an env var
 * must not stop a run.
 */
function resolveLevel(explicit?: string): LogLevel {
  return (
    parseLogLevel(explicit) ??
    launcherLevel ??
    parseLogLevel(process.env.GRAPHYTI_LOG) ??
    DEFAULT_LEVEL
  );
}

/**
 * Set the command line's level for runs started from now on.
 *
 * Used by the TUI launcher, which parses `graphyti --log debug` before any run
 * exists but has nowhere to pass it — the TUI itself starts a run per prompt.
 * An unrecognised value is ignored, leaving the env var and the default in place.
 */
export function setLauncherLogLevel(level: string | undefined): void {
  launcherLevel = parseLogLevel(level);
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

function runFileName(date: Date): string {
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${randomBytes(3).toString("hex")}.jsonl`;
}

/**
 * What a run file looks like.
 *
 * The prune matches on this rather than on `.jsonl`, so a user's own file that
 * happens to sit in the log directory is never a deletion candidate.
 */
const RUN_FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}\.jsonl$/;

function logDirFor(projectRoot: string): string {
  return path.join(projectRoot, ...LOG_DIR_SEGMENTS);
}

/**
 * Drop the oldest run files. Only files this module wrote are considered, so a
 * user's own files in the directory survive.
 */
function prune(dir: string, keep: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  // The timestamp prefix sorts lexicographically into time order, so the first
  // entries are the oldest runs.
  const runFiles = names.filter((name) => RUN_FILE.test(name)).sort();
  const stale = runFiles.slice(0, Math.max(0, runFiles.length - keep));
  for (const name of stale) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      // A file we cannot delete is not a reason to fail the run.
    }
  }
}

/**
 * Start a run log. Any previous run's log on this async flow is closed first,
 * so a flow that starts a run without ending the last one does not interleave
 * two files' worth of lines.
 *
 * Returns the run's file path, or null when logging is off or the file could not
 * be opened — in both cases the `log.*` helpers become no-ops and the agent
 * behaves exactly as it did before this module existed.
 */
export function beginAgentRun(options: {
  projectRoot: string;
  /** Where the run came from: `cli`, `tui`, `api`. */
  source?: string;
  level?: string;
  /** Explicit destination, overriding `GRAPHYTI_LOG_FILE`. */
  file?: string;
  /** Extra fields recorded on every line of this run. */
  fields?: LogFields;
}): string | null {
  endAgentRun();

  const level = resolveLevel(options.level);
  if (level === "off") {
    active = null;
    return null;
  }

  const runId = randomBytes(4).toString("hex");
  const explicitFile = options.file ?? process.env.GRAPHYTI_LOG_FILE;
  const file = explicitFile
    ? path.resolve(explicitFile)
    : path.join(logDirFor(options.projectRoot), runFileName(new Date()));

  const run: ActiveRun = {
    runId,
    level,
    file,
    fields: { run: runId, source: options.source ?? "unknown", ...options.fields },
    startedAt: Date.now(),
    broken: false,
    ended: false,
  };
  active = run;
  // From here on, this async flow logs to this run — including the shared
  // pipeline, which never learns a run happened.
  storage.enterWith(run);

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    run.broken = true;
    return null;
  }

  write("info", "run.start", {
    projectRoot: options.projectRoot,
    level,
    cwd: process.cwd(),
    node: process.version,
  });

  // After the first write, so the run being started counts towards the budget.
  if (!explicitFile) prune(path.dirname(file), KEEP_RUNS);
  return run.broken ? null : file;
}

/**
 * Close this flow's run, recording a final `run.end` summary.
 *
 * Safe to call when no run is active, and safe to call twice.
 */
export function endAgentRun(summary: LogFields = {}): void {
  const run = currentRun();
  if (!run) return;
  run.ended = true;
  if (active === run) active = null;
  writeTo(run, "info", "run.end", { ...summary, elapsedMs: Date.now() - run.startedAt });
}

/** Absolute path of the run being logged to, or null when nothing is being logged. */
export function agentLogFile(): string | null {
  const run = currentRun();
  return run && !run.broken ? run.file : null;
}

/** The current run's id, or null. Useful for correlating with other output. */
export function agentRunId(): string | null {
  return currentRun()?.runId ?? null;
}

/** Reconfigure the current run's base fields, e.g. the step a run is on. */
export function setAgentRunFields(fields: LogFields): void {
  const run = currentRun();
  if (run) Object.assign(run.fields, fields);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function write(level: Exclude<LogLevel, "off">, event: string, fields: LogFields = {}): void {
  const run = currentRun();
  if (run) writeTo(run, level, event, fields);
}

function writeTo(
  run: ActiveRun,
  level: Exclude<LogLevel, "off">,
  event: string,
  fields: LogFields
): void {
  if (run.broken || !run.file) return;
  if (RANK[level] > RANK[run.level]) return;

  const record: LogFields = {
    ts: new Date().toISOString(),
    level,
    event,
    ...run.fields,
    elapsedMs: Date.now() - run.startedAt,
    ...sanitizeFields(fields),
  };

  try {
    fs.appendFileSync(run.file, `${JSON.stringify(record)}\n`, "utf-8");
  } catch {
    run.broken = true;
  }
}

// ---------------------------------------------------------------------------
// Redaction and bounding
// ---------------------------------------------------------------------------

/**
 * Mask anything that looks like a credential.
 *
 * Errors from the OpenRouter SDK quote the request, and prompts quote the
 * environment, so a key can reach a log line by accident from either direction.
 */
function redact(text: string): string {
  return text
    .replace(/\b(sk|pk|rk|ghp|gho|hf|xox[abps])-[A-Za-z0-9_-]{6,}/g, "$1-***")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 ***")
    .replace(
      /((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|password|passwd|authorization)["']?\s*[:=]\s*["']?)([^\s"',;)}\]]{4,})/gi,
      "$1***"
    );
}

function sanitizeString(value: string): string {
  const redacted = redact(value);
  if (redacted.length <= MAX_VALUE_CHARS) return redacted;
  return `${redacted.slice(0, MAX_VALUE_CHARS)}… (+${redacted.length - MAX_VALUE_CHARS} chars)`;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: sanitizeString(value.message) };
  }
  if (value instanceof Date) return value.toISOString();
  // Deeply nested payloads are a shape, not evidence. Stop before the walk
  // becomes the most expensive thing in the process.
  if (depth >= 4) return "[deep]";
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: LogFields = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[redact(key)] = sanitizeValue(item, depth + 1);
    }
    return out;
  }
  return sanitizeString(String(value));
}

function sanitizeFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[redact(key)] = sanitizeValue(value, 0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Call-site surface
// ---------------------------------------------------------------------------

/**
 * The log handle, safe to call before a run exists.
 *
 * `log.info("write.complete", { written: 3 })` is valid at any point in the
 * pipeline: with no active run, or with a run whose level filters the line out,
 * it does nothing.
 */
export const log = {
  debug: (event: string, fields?: LogFields) => write("debug", event, fields),
  info: (event: string, fields?: LogFields) => write("info", event, fields),
  warn: (event: string, fields?: LogFields) => write("warn", event, fields),
  error: (event: string, fields?: LogFields) => write("error", event, fields),
} as const;
