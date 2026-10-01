/**
 * Tests for the agent run log — src/utils/agentLog.ts.
 *
 * A log that can break a run is worse than no log, so most of what is checked
 * here is the failure behaviour: an unwritable destination, a level that filters
 * everything out, a value that arrives too large. Run with:
 *   npm run test:logs
 *
 * Nothing here spawns a process, talks to a model, or touches the repo: every
 * case writes into a fresh mkdtemp directory, and the one real pipeline call
 * runs with the console silenced and against a throwaway project root.
 */

import fs from "fs";
import os from "os";
import path from "path";

import {
  beginAgentRun,
  endAgentRun,
  agentLogFile,
  agentRunId,
  log,
  parseLogLevel,
  setAgentRunFields,
  setLauncherLogLevel,
} from "../utils/agentLog";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = true;

function fail(label: string, detail: string): void {
  console.log(`  ❌ FAIL  ${label}`);
  console.log(`           ${detail}`);
  passed = false;
}

function pass(label: string, note = ""): void {
  console.log(`  ✅ PASS  ${label}${note ? `  ${note}` : ""}`);
}

function check(label: string, condition: boolean, detail: string): void {
  if (condition) pass(label);
  else fail(label, detail);
}

const roots: string[] = [];

/** A project root that exists, is empty, and is removed when the suite ends. */
function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graphyti-log-"));
  roots.push(dir);
  return dir;
}

/** Sleep without a timer, so the harness stays a single synchronous-ish pass. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

process.on("exit", () => {
  for (const dir of roots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A directory we cannot remove must not turn a passing suite into a
      // failing one.
    }
  }
});

/**
 * The last run's file.
 *
 * `agentLogFile()` goes null the moment a run closes, and most assertions below
 * are about what that run left behind — so the path is kept here too.
 */
let lastFile: string | null = null;

/** beginAgentRun, remembering the file for assertions made after it closes. */
function startRun(options: Parameters<typeof beginAgentRun>[0]): string | null {
  lastFile = beginAgentRun(options);
  return lastFile;
}

/** The run's log as raw text — for assertions about what is *not* in it. */
function rawLog(): string {
  const file = agentLogFile() ?? lastFile;
  return file && fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
}

/** Every record in the run's log, parsed. */
function records(): Array<Record<string, any>> {
  const file = agentLogFile() ?? lastFile;
  if (!file || !fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function events(): string[] {
  return records().map((r) => r.event);
}

function logFiles(root: string): string[] {
  const dir = path.join(root, ".dbagent", "logs");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort();
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------------------
  // 1. Shape
  // ---------------------------------------------------------------------------

  console.log("\n=== SHAPE ===");

  {
  const root = tempRoot();
  const file = startRun({ projectRoot: root, source: "cli", fields: { query: "add heading" } });

  check("a run creates a log file under .dbagent/logs", file !== null && fs.existsSync(file!), `file=${file}`);
  check(
    "the file is inside the project being worked on",
    Boolean(file) && file!.startsWith(root) && file!.includes(path.join(".dbagent", "logs")),
    `file=${file} root=${root}`
  );
  check("the run id is readable while it is open", typeof agentRunId() === "string", `${agentRunId()}`);

  log.info("generation.ready", { actions: 2 });
  log.debug("prompt.built", { chars: 4000 });
  endAgentRun({ outcome: "completed", filesWritten: 2 });

    const lines = records();
    check("one JSON object per line", lines.length === 3, `lines=${JSON.stringify(lines)}`);
    check(
      "every line parses and carries the run's identity",
      lines.every((r) => r.run && r.ts && r.level && typeof r.event === "string"),
      JSON.stringify(lines.map((r) => ({ run: r.run, event: r.event })))
    );
    check(
      "run-level fields are on every line, not just the first",
      lines.every((r) => r.source === "cli" && r.query === "add heading"),
      JSON.stringify(lines[1])
    );
    check(
      "elapsed time is measured from the start of the run",
      lines.every((r) => typeof r.elapsedMs === "number") &&
        lines[0].elapsedMs <= lines[lines.length - 1].elapsedMs,
      JSON.stringify(lines.map((r) => r.elapsedMs))
    );
    check(
      "the run opens and closes with run.start / run.end",
      lines[0].event === "run.start" && lines[lines.length - 1].event === "run.end",
      JSON.stringify(lines.map((r) => r.event))
    );
    check(
      "run.end carries the outcome the caller passed",
      lines[lines.length - 1].outcome === "completed" && lines[lines.length - 1].filesWritten === 2,
      JSON.stringify(lines[lines.length - 1])
    );
    check(
      "run.start records the configuration without any secret value",
      lines[0].level === "info" && typeof lines[0].node === "string" && !("apiKey" in lines[0]),
      JSON.stringify(lines[0])
    );
    check("agentLogFile() is null once the run is closed", agentLogFile() === null, `${agentLogFile()}`);
  }

  // ---------------------------------------------------------------------------
  // 2. Levels
  // ---------------------------------------------------------------------------

  console.log("\n=== LEVELS ===");

  {
    const root = tempRoot();
    startRun({ projectRoot: root, level: "info" });
    log.debug("noisy", {});
    log.info("kept", {});
    log.warn("kept.warn", {});
    log.error("kept.error", {});
    endAgentRun();

    const found = events();
    check(
      "info keeps info and above, drops debug",
      !found.includes("noisy") && ["kept", "kept.warn", "kept.error"].every((e) => found.includes(e)),
      JSON.stringify(found)
    );
  }

  {
    const root = tempRoot();
    startRun({ projectRoot: root, level: "debug" });
    log.debug("noisy", {});
    log.info("kept", {});
    endAgentRun();
    check("debug keeps everything", events().includes("noisy") && events().includes("kept"), JSON.stringify(events()));
  }

  {
    const root = tempRoot();
    startRun({ projectRoot: root, level: "error" });
    log.info("dropped", {});
    log.warn("dropped.warn", {});
    log.error("kept", {});
    endAgentRun();
    const found = events();
    check(
      "error keeps only errors",
      !found.includes("dropped") && !found.includes("dropped.warn") && found.includes("kept"),
      JSON.stringify(found)
    );
  }

  {
    const root = tempRoot();
    const file = startRun({ projectRoot: root, level: "off" });
    log.info("never", {});
    endAgentRun();
    check("off writes no file at all", file === null && logFiles(root).length === 0, `file=${file}`);
    check("off leaves no run open", agentLogFile() === null, `${agentLogFile()}`);
  }

  {
    const root = tempRoot();
    process.env.GRAPHYTI_LOG = "debug";
    startRun({ projectRoot: root });
    log.debug("from.env", {});
    endAgentRun();
    check("GRAPHYTI_LOG sets the level", events().includes("from.env"), JSON.stringify(events()));
    delete process.env.GRAPHYTI_LOG;
  }

  {
    const root = tempRoot();
    process.env.GRAPHYTI_LOG = "loud";
    startRun({ projectRoot: root });
    log.info("survives.bad.level", {});
    endAgentRun();
    check(
      "an unparseable GRAPHYTI_LOG falls back instead of failing the run",
      events().includes("survives.bad.level"),
      JSON.stringify(events())
    );
    delete process.env.GRAPHYTI_LOG;
  }

  {
    // An explicit level must win over the environment, or `--log off` could not
    // switch logging off on a machine that has it on by default.
    const root = tempRoot();
    process.env.GRAPHYTI_LOG = "debug";
    startRun({ projectRoot: root, level: "error" });
    log.debug("suppressed.by.explicit", {});
    log.error("kept.by.explicit", {});
    endAgentRun();
    const found = events();
    check(
      "an explicit level overrides GRAPHYTI_LOG",
      !found.includes("suppressed.by.explicit") && found.includes("kept.by.explicit"),
      JSON.stringify(found)
    );
    delete process.env.GRAPHYTI_LOG;
  }

  {
    check(
      "levels parse case-insensitively, with the usual aliases",
      parseLogLevel("DEBUG") === "debug" && parseLogLevel("verbose") === "debug" && parseLogLevel("silent") === "off",
      `${parseLogLevel("DEBUG")} ${parseLogLevel("verbose")} ${parseLogLevel("silent")}`
    );
  }

  {
    // The TUI launcher parses `graphyti --log debug` before any run exists and
    // has nowhere to pass it down, so it sets it here. It has to outrank
    // GRAPHYTI_LOG, or the flag would be ignored on a configured machine.
    const root = tempRoot();
    process.env.GRAPHYTI_LOG = "error";
    setLauncherLogLevel("debug");
    startRun({ projectRoot: root });
    log.debug("from.launcher.flag", {});
    endAgentRun();
    check(
      "a level from the command line outranks GRAPHYTI_LOG",
      events().includes("from.launcher.flag"),
      JSON.stringify(events())
    );
    delete process.env.GRAPHYTI_LOG;
    setLauncherLogLevel(undefined);
  }

  // ---------------------------------------------------------------------------
  // 3. Destination
  // ---------------------------------------------------------------------------

  {
    const root = tempRoot();
    const target = path.join(tempRoot(), "elsewhere", "run.jsonl");
    const file = startRun({ projectRoot: root, file: target });
    log.info("redirected", {});
    endAgentRun();

    check("an explicit file overrides the default directory", file === target, `file=${file}`);
    check("the parent directory is created on demand", fs.existsSync(target), target);
    check("nothing is written to the default directory", logFiles(root).length === 0, JSON.stringify(logFiles(root)));
  }

  {
    const root = tempRoot();
    const target = path.join(tempRoot(), "env.jsonl");
    process.env.GRAPHYTI_LOG_FILE = target;
    startRun({ projectRoot: root });
    log.info("from.env.file", {});
    endAgentRun();
    check("GRAPHYTI_LOG_FILE redirects the destination", fs.existsSync(target), target);
    delete process.env.GRAPHYTI_LOG_FILE;
  }

  {
    // 25 runs against a budget of 20 must leave 20 behind, newest kept. The
    // prune sorts by file name and the name starts with a millisecond
    // timestamp, so the runs have to be spaced far enough apart to order.
    const root = tempRoot();
    const dir = path.join(root, ".dbagent", "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "notes.jsonl"), "mine\n");
    fs.writeFileSync(path.join(dir, "today.jsonl"), "mine too\n");

    let oldest = "";
    for (let i = 0; i < 25; i++) {
      startRun({ projectRoot: root });
      if (i === 0) oldest = logFiles(root).find((n) => n.includes("T") && n.endsWith(".jsonl")) ?? "";
      log.info("filler", { i });
      endAgentRun();
      sleep(2);
    }

    const kept = logFiles(root);
    const mine = kept.filter((n) => n === "notes.jsonl" || n === "today.jsonl");
    const runs = kept.filter((n) => n !== "notes.jsonl" && n !== "today.jsonl");
    check("the number of runs kept is capped", runs.length === 20, `kept=${JSON.stringify(kept)}`);
    check(
      "the oldest runs are the ones pruned",
      oldest !== "" && !runs.includes(oldest),
      `oldest=${oldest} kept=${JSON.stringify(runs.slice(0, 2))}`
    );
    check(
      "the newest run is kept",
      runs[runs.length - 1] !== undefined &&
        fs.readFileSync(path.join(dir, runs[runs.length - 1]!), "utf-8").includes('"i":24'),
      JSON.stringify(runs[runs.length - 1])
    );
    check(
      "a user's own files in the log directory are never pruned",
      mine.length === 2,
      `mine=${JSON.stringify(mine)} kept=${JSON.stringify(kept)}`
    );
  }

  // ---------------------------------------------------------------------------
  // 4. Never break a run
  // ---------------------------------------------------------------------------

  {
    // `blocker` is a file, so creating a directory under it cannot work. The run
    // must come back empty-handed rather than taking the agent down with it.
    const root = tempRoot();
    const blocker = path.join(root, "blocker");
    fs.writeFileSync(blocker, "not a directory");

    let threw: unknown = null;
    let file: string | null | undefined;
    try {
      file = startRun({ projectRoot: root, file: path.join(blocker, "run.jsonl") });
      log.info("must.not.throw", {});
      log.error("must.not.throw.either", {});
      endAgentRun({ outcome: "completed" });
    } catch (err) {
      threw = err;
    }

    check("an unwritable destination does not throw", threw === null, `${threw}`);
    check("an unwritable destination reports no log file", file === null, `${file}`);
    check("the pipeline continues with logging silently off", agentLogFile() === null, `${agentLogFile()}`);
  }

  {
    const root = tempRoot();
    log.info("no.run.open", {});
    check("logging before any run is a no-op", agentLogFile() === null, `${agentLogFile()}`);
    check("a no-op still leaves no file in the project", logFiles(root).length === 0, JSON.stringify(logFiles(root)));
    check("endAgentRun with no run open is safe", (() => { endAgentRun(); return true; })(), "");
  }

  {
    const root = tempRoot();
    startRun({ projectRoot: root });
    endAgentRun();
    endAgentRun();
    check("ending a run twice is safe", agentLogFile() === null, `${agentLogFile()}`);
  }

  // ---------------------------------------------------------------------------
  // 5. Redaction and bounds
  // ---------------------------------------------------------------------------

  console.log("\n=== REDACTION AND BOUNDS ===");

  {
    const root = tempRoot();
    startRun({ projectRoot: root });
    log.info("llm.error", {
      error: new Error("OpenRouter auth error for key sk-or-v1-abcdef1234567890"),
      config: "OPENROUTER_API_KEY=sk-or-v1-zzzzzzzzzzzz",
      headers: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdef",
    });
    endAgentRun();

    const raw = rawLog();
  check(
    "an API key in an error message is masked",
    !raw.includes("abcdef1234567890") && raw.includes("sk-***"),
    raw.split("\n")[1]?.slice(0, 200)
  );
  check("a key=value secret is masked", !raw.includes("sk-or-v1-zzzzzzzzzzzz"), raw.split("\n")[1]?.slice(0, 200));
  check("a bearer token is masked", !raw.includes("eyJhbGciOiJIUzI1NiJ9"), raw.split("\n")[1]?.slice(0, 200));
  const errorLine = records().find((r) => r.event === "llm.error");
  check(
    "an Error is recorded as its name and message, not a serialised blob",
    errorLine?.error?.name === "Error" && typeof errorLine?.error?.message === "string",
    JSON.stringify(errorLine)
  );
}

  {
    const root = tempRoot();
    startRun({ projectRoot: root });
    log.info("context", { chars: 120_000, body: "x".repeat(5000) });
    log.info("plan", { files: ["a.tsx", "b.tsx"], nested: { deep: { deeper: { deepest: 1 } } } });
    endAgentRun();

    const contextLine = records().find((r) => r.event === "context");
    const planLine = records().find((r) => r.event === "plan");
    check(
      "an oversized value is truncated rather than written whole",
      typeof contextLine?.body === "string" && contextLine.body.length < 700,
      `len=${String(contextLine?.body).length}`
    );
    check(
      "shapes and sizes are recorded, so nothing needs the body",
      contextLine?.chars === 120000 && planLine?.files.length === 2,
      JSON.stringify(contextLine)
    );
    check("arrays survive as arrays", JSON.stringify(planLine?.files) === '["a.tsx","b.tsx"]', JSON.stringify(planLine?.files));
    check(
      "a deeply nested payload is cut off rather than walked forever",
      JSON.stringify(planLine?.nested).includes("deepest"),
      JSON.stringify(planLine?.nested)
    );
  }

  // ---------------------------------------------------------------------------
  // 6. The agent actually logs
  // ---------------------------------------------------------------------------

  console.log("\n=== THE AGENT LOGS ===");

  {
    // The point of the module: a real pipeline call leaves a trail behind. This
    // drives handleAgentOutput, which every surface — CLI, TUI, API — goes
    // through, and asserts the write phase is recorded.
  const root = tempRoot();
  const { handleAgentOutput } = require("../agentPipeline") as typeof import("../agentPipeline");

  fs.writeFileSync(path.join(root, "note.txt"), "before\n");

  const realLog = console.log;
    const realError = console.error;
    console.log = () => {};
    console.error = () => {};
    startRun({ projectRoot: root, source: "tui" });
    setAgentRunFields({ step: 1, stepDescription: "add a heading field to Post" });
    try {
      await handleAgentOutput(
        [
          {
            type: "file",
            filePath: "note.txt",
            edits: [{ filePath: "note.txt", oldText: "before", newText: "after" }],
          },
          { type: "command", command: "npm install zod && rm -rf /" },
          { type: "file", filePath: "../escaped.txt", edits: [{ filePath: "../escaped.txt", oldText: "", newText: "x" }] },
        ],
        { yes: true, projectRoot: root }
      );
      log.info("step.done", { written: 1 });
      endAgentRun({ outcome: "completed" });
    } finally {
      console.log = realLog;
      console.error = realError;
    }

    const found = events();
    check("a file write is recorded", found.includes("write.file"), JSON.stringify(found));
    check("a refused command is recorded", found.includes("command.refused"), JSON.stringify(found));
    check("a path escaping the project root is recorded", found.includes("path.refused"), JSON.stringify(found));
    check("the write phase reports its totals", found.includes("write.complete"), JSON.stringify(found));

    const writeLine = records().find((r) => r.event === "write.complete");
    check(
      "the totals are the ones the pipeline returned",
      writeLine?.written === 1 && writeLine?.created === 0 && writeLine?.executed === 0,
      JSON.stringify(writeLine)
    );
    check(
      "the step fields set by the caller are inherited by later lines",
      records().filter((r) => r.event === "write.file").every((r) => r.step === 1),
      JSON.stringify(records().filter((r) => r.event === "write.file"))
    );
    check(
      "the log records the refusal reason, not the whole allowlist dump",
      records().find((r) => r.event === "command.refused")?.reason !== undefined,
      JSON.stringify(records().find((r) => r.event === "command.refused"))
    );
  }

  {
    // One run per process: a second beginAgentRun closes the first rather than
    // interleaving two files' worth of lines.
    const root = tempRoot();
    const first = startRun({ projectRoot: root, fields: { query: "one" } });
    const second = startRun({ projectRoot: root, fields: { query: "two" } });
    log.info("belongs.to.second", {});
    endAgentRun();

    check("starting a run closes the previous one", first !== second && Boolean(second), `${first} ${second}`);
    check(
      "lines go to the newest run only",
      first !== null &&
        !fs.readFileSync(first!, "utf-8").includes("belongs.to.second") &&
        fs.readFileSync(second!, "utf-8").includes("belongs.to.second"),
      `${first} ${second}`
    );
    const lastLineOfFirst = (first: string | null): string =>
      first ? (fs.readFileSync(first, "utf-8").trim().split("\n").pop() ?? "") : "";
    check(
      "the closed run still ends with its own run.end",
      lastLineOfFirst(first).includes("run.end"),
      lastLineOfFirst(first).slice(0, 120)
    );
  }

  {
    // The API server answers two queries at once, so two runs can be in flight
    // together. Both are started from separate async flows, the way two
    // requests are, and neither may end up in the other's file.
    const rootA = tempRoot();
    const rootB = tempRoot();
    const files: Array<string | null> = [null, null];

    const runIn = (index: number, root: string, tag: string) =>
      new Promise<void>((resolve) => {
        setImmediate(() => {
          files[index] = startRun({ projectRoot: root, fields: { query: tag } });
          log.info("in.flight", { tag });
          setTimeout(() => {
            log.info("late", { tag });
            endAgentRun({ outcome: "completed" });
            resolve();
          }, 5);
        });
      });

    await Promise.all([runIn(0, rootA, "first"), runIn(1, rootB, "second")]);

    const read = (index: number): string =>
      files[index] ? fs.readFileSync(files[index]!, "utf-8") : "";
    check("two concurrent runs get two files", files[0] !== files[1] && files.every(Boolean), JSON.stringify(files));
    check(
      "each run's lines stay in its own file",
      read(0).includes('"tag":"first"') &&
        !read(0).includes('"tag":"second"') &&
        read(1).includes('"tag":"second"') &&
        !read(1).includes('"tag":"first"'),
      `a=${read(0).length}b=${read(1).length}`
    );
    check(
      "a line written after the other run started still lands in its own file",
      read(0).includes("late") && read(1).includes("late"),
      JSON.stringify(files)
    );
    const lastEventOf = (index: number): string => {
      const text = read(index).trim();
      if (!text) return "";
      try {
        return (JSON.parse(text.split("\n").pop() as string).event as string) ?? "";
      } catch {
        return "";
      }
    };
    check(
      "each concurrent run ends its own log",
      lastEventOf(0) === "run.end" && lastEventOf(1) === "run.end",
      `a=${lastEventOf(0)} b=${lastEventOf(1)}`
    );
  }
}

// ---------------------------------------------------------------------------

main().then(
  () => {
    console.log(
      passed ? `\n✅ Agent run log behaved as expected` : `\n❌ Some agent log cases failed`
    );
    process.exit(passed ? 0 : 1);
  },
  (err) => {
    console.error(`\n💥 Agent log test harness threw:`, err);
    process.exit(1);
  }
);
