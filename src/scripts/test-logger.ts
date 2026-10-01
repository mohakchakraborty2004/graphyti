/**
 * Tests for utils/logger.ts — the run log file.
 *
 * The module's promises are all about behaviour under failure: it must write a
 * readable line, never leak a secret, never throw, and never print. Each of
 * those is a different way the rest of the pipeline could break if the logger
 * were careless, so they are checked directly rather than assumed. Run with:
 *   npm run test:logging
 *
 * Every case gets its own throwaway directory under the OS temp dir, and the
 * module-level logger state is reset between cases so one case's configuration
 * (disabled, custom path, failed write) cannot leak into the next.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { env } from "../config";
import {
  configureLogger,
  currentLogFile,
  logDebug,
  logError,
  logEvent,
  logInfo,
  logWarn,
  resetLogger,
} from "../utils/logger";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A fresh project root nobody else touches, removed at the end of the run. */
function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "graphyti-logger-"));
}

/** The log file under `root`, read as an array of non-empty lines. */
function readLines(root: string): string[] {
  const file = path.join(root, ".dbagent", "logs", "graphyti.log");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

/** `2026-…Z INFO  run.start {…}` → parts, or null if the line is malformed. */
function parseLine(line: string): { level: string; event: string; payload: string } | null {
  const match = /^(\S{4}-\S{2}-\S{2}T\S+) +([A-Z]+) +([A-Za-z0-9_.]+)(?: (.*))?$/.exec(line);
  if (!match) return null;
  return { level: match[2]!, event: match[3]!, payload: match[4] ?? "" };
}

/** `GRAPHYTI_LOG` as the logger reads it — config's normalized view. */
const mutableEnv = env as unknown as Record<string, unknown>;
const originalLogSetting = mutableEnv.graphytiLog;
function setLogEnv(value: string | undefined): void {
  mutableEnv.graphytiLog = value;
}

const roots: string[] = [];

console.log("=== default path ===");
{
  const root = tempProject();
  roots.push(root);
  resetLogger();
  const file = configureLogger({ projectRoot: root });
  check(
    "defaults to <projectRoot>/.dbagent/logs/graphyti.log",
    file === path.join(root, ".dbagent", "logs", "graphyti.log"),
    String(file)
  );
  check("currentLogFile reports the same path", currentLogFile() === file);
}

console.log("\n=== writing ===");
{
  const root = tempProject();
  roots.push(root);
  resetLogger();
  configureLogger({ projectRoot: root });
  logInfo("run.start", { query: "add a heading field", dryRun: false });
  logWarn("command.refused", { command: "rm -rf /", reason: "not allowlisted" });
  logError("run.end", { status: "blocked", exitCode: 1 });
  logDebug("context.query", { lines: 12 });

  const lines = readLines(root);
  check("creates the directory and file", lines.length === 4, `${lines.length} lines`);

  const first = lines[0] ? parseLine(lines[0]) : null;
  check("line 1 parses", first !== null, lines[0] ?? "(missing)");
  check("line 1 is the event it was given", first?.event === "run.start");
  check("line 1 carries an ISO-8601 UTC timestamp", /^20\d\d-/.test(lines[0]!.split(" ")[0]!));

  check(
    "levels are recorded distinctly",
    lines.slice(1, 4).every((line, i) => parseLine(line)?.level === ["WARN", "ERROR", "DEBUG"][i]),
    lines.slice(1, 4).join(" | ")
  );
  check(
    "events appear in order",
    lines.map((line) => parseLine(line)?.event).join(",") ===
      "run.start,command.refused,run.end,context.query"
  );

  const payload = JSON.parse(first?.payload ?? "{}");
  check("details round-trip as JSON", payload.query === "add a heading field" && payload.dryRun === false);
}

console.log("\n=== one line per event ===");
{
  const root = tempProject();
  roots.push(root);
  resetLogger();
  configureLogger({ projectRoot: root });
  logInfo("multiline", { note: "first\nsecond\nthird" });
  const lines = readLines(root);
  check(
    "a newline in a value does not split the line",
    lines.length === 1 && parseLine(lines[0]!)?.event === "multiline",
    `${lines.length} lines`
  );
}

console.log("\n=== redaction ===");
{
  const root = tempProject();
  roots.push(root);
  resetLogger();
  configureLogger({ projectRoot: root });
  logInfo("config.loaded", {
    apiKey: "hydra-secret-value",
    nested: { openrouterApiKey: "openrouter-secret-value", model: "gpt-x" },
    list: [{ token: "token-secret-value" }],
    Authorization: "authorization-secret-value",
    safe: "visible-value",
  });
  logInfo("llm.response", { body: "sk-abcdefghijklmnop" });
  const raw = readLines(root).join("\n");

  check(
    "secret keys are redacted at any depth",
    !raw.includes("hydra-secret-value") &&
      !raw.includes("openrouter-secret-value") &&
      !raw.includes("token-secret-value") &&
      !raw.includes("authorization-secret-value"),
    raw
  );
  check("redaction is visible, not silent omission", (raw.match(/\[REDACTED\]/g) ?? []).length >= 4);
  check("credential-shaped values are redacted even under an innocent key", !raw.includes("sk-abcdefghijklmnop"));
  check("ordinary values survive", raw.includes("visible-value") && raw.includes("gpt-x"));
}

console.log("\n=== errors and oversized values ===");
{
  const root = tempProject();
  roots.push(root);
  resetLogger();
  configureLogger({ projectRoot: root });
  const boom = new Error("verification failed");
  logError("run.end", { error: boom });
  logInfo("context.big", { blob: "x".repeat(5000) });

  const lines = readLines(root);
  const first = lines[0] ? parseLine(lines[0]) : null;
  const errPayload = JSON.parse(first?.payload ?? "{}").error ?? {};
  check("an Error logs name and message", errPayload.name === "Error" && errPayload.message === "verification failed");
  check("an Error logs its stack too", typeof errPayload.stack === "string" && errPayload.stack.length > 0);

  const second = lines[1] ? parseLine(lines[1]) : null;
  const big = JSON.parse(second?.payload ?? "{}");
  check("oversized strings are elided, not written whole", typeof big.blob === "string" && big.blob.length < 700, `${big.blob?.length}`);
  check("the elision says how much was dropped", /\(\+\d+ chars\)/.test(String(big.blob)));
  check("no line exceeds the hard cap", lines.every((line) => line.length <= 4000));
}

console.log("\n=== path resolution ===");
{
  const root = tempProject();
  roots.push(root);
  resetLogger();
  const relative = configureLogger({ projectRoot: root, logFile: "runs/today.log" });
  check("a relative target resolves against the project root", relative === path.join(root, "runs/today.log"), String(relative));

  resetLogger();
  const absolute = path.join(os.tmpdir(), "graphyti-absolute.log");
  const configured = configureLogger({ projectRoot: root, logFile: absolute });
  check("an absolute target is used as-is", configured === absolute, String(configured));
  logInfo("absolute.event", {});
  check("the absolute target is written", fs.existsSync(absolute));
  fs.rmSync(absolute, { force: true });
}

console.log("\n=== turning logging off ===");
{
  const root = tempProject();
  roots.push(root);

  resetLogger();
  check("disabled: true returns null", configureLogger({ projectRoot: root, disabled: true }) === null);
  logInfo("disabled.event", {});
  check("a disabled logger writes nothing", !fs.existsSync(path.join(root, ".dbagent")));

  setLogEnv("off");
  resetLogger();
  check("GRAPHYTI_LOG=off returns null", configureLogger({ projectRoot: root }) === null);
  logInfo("off.event", {});
  check("GRAPHYTI_LOG=off writes nothing", !fs.existsSync(path.join(root, ".dbagent")));

  setLogEnv("logs/graphyti-run.log");
  resetLogger();
  const fromEnv = configureLogger({ projectRoot: root });
  check(
    "GRAPHYTI_LOG=<path> redirects the file",
    fromEnv === path.join(root, "logs", "graphyti-run.log"),
    String(fromEnv)
  );
  logInfo("redirected.event", {});
  check("the redirected file is written", fs.existsSync(path.join(root, "logs", "graphyti-run.log")));

  setLogEnv(undefined);
}

console.log("\n=== failures must not throw ===");
{
  const root = tempProject();
  roots.push(root);
  resetLogger();
  // A regular file where a directory must go: mkdir throws, every time.
  const blocked = path.join(root, "blocked");
  fs.writeFileSync(blocked, "not a directory", "utf-8");
  configureLogger({ projectRoot: root, logFile: path.join(blocked, "graphyti.log") });

  let threw: unknown = null;
  try {
    logInfo("first.after.failure", {});
    logWarn("second.after.failure", {});
    logError("third.after.failure", {});
  } catch (err) {
    threw = err;
  }
  check("an unwritable destination never throws", threw === null, String(threw));
  check("the logger disables itself after the first failure", currentLogFile() === null);

  // Re-enabling must work again — a failure is per-configuration, not sticky.
  const writable = configureLogger({ projectRoot: root, logFile: "recovered.log" });
  logInfo("after.recovery", {});
  check(
    "reconfiguring recovers from a failed write",
    writable !== null && fs.readFileSync(writable!, "utf-8").includes("after.recovery")
  );
}

console.log("\n=== no stdout/stderr ===");
{
  const root = tempProject();
  roots.push(root);
  resetLogger();
  configureLogger({ projectRoot: root });

  const captured: string[] = [];
  const originals = [process.stdout.write.bind(process.stdout), process.stderr.write.bind(process.stderr)];
  const swallow = (target: string) => (chunk: unknown) => {
    captured.push(`${target}:${String(chunk)}`);
    return true;
  };
  process.stdout.write = swallow("out") as typeof process.stdout.write;
  process.stderr.write = swallow("err") as typeof process.stderr.write;
  try {
    logEvent("info", "quiet.event", { detail: "x" });
    logEvent("error", "quiet.event", { detail: "y" });
  } finally {
    process.stdout.write = originals[0]!;
    process.stderr.write = originals[1]!;
  }
  check("logging prints nothing", captured.length === 0, captured.join(""));
  check("…but still writes the file", readLines(root).length === 2);
}

console.log("\n=== reset ===");
{
  const root = tempProject();
  roots.push(root);
  configureLogger({ projectRoot: root });
  resetLogger();
  const file = currentLogFile();
  check(
    "resetLogger returns to the cwd default",
    file === path.join(process.cwd(), ".dbagent", "logs", "graphyti.log"),
    String(file)
  );
}

// ---------------------------------------------------------------------------
// Restore environment and clean up
// ---------------------------------------------------------------------------

setLogEnv(originalLogSetting as string | undefined);
for (const root of roots) {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(passed > 0 && failed === 0 ? `\n✅ Logger behaved as expected` : `\n❌ Some logger cases failed`);
process.exit(failed === 0 ? 0 : 1);
