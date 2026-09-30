import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { createServer, type IncomingMessage } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { CancelledError, runPipeline, type PipelineEvents } from "../tui/engine/runPipeline";
import { runInitGraph } from "../cli/init-graph";
import { graphMapPath, loadGraphMap } from "../graph/ingest";
import type { BlastRadiusResult } from "../graph/blastRadius";
import type { UnifiedValidationResult } from "../verify/unifiedValidation";

type QueryBody = { query?: unknown; yes?: unknown; dryRun?: unknown };
type StreamStatus = "start" | "update" | "done" | "error";
type StreamMessage = {
  stage: string;
  status?: StreamStatus;
  message?: string;
  data?: unknown;
  elapsedMs?: number;
  result?: CliJsonResult;
};

/** The exact result envelope printed by the CLI's --json mode. */
type CliJsonResult = {
  query: string;
  filesWritten: string[];
  blastRadiusSize: number;
  /** Full existing pipeline reports; empty means no breaking-change verification ran. */
  verification: UnifiedValidationResult[];
  /** Full existing graph blast-radius reports; empty means no breaking schema change. */
  blastRadius: BlastRadiusResult[];
  graphIndexUpdated: boolean;
  elapsedMs: number;
  exitCode: number;
  /** Present when the pipeline could not reach a safe write. */
  error?: string;
  branch?: string;
  push?: { pushed: boolean; note?: string };
  prUrl?: string;
};

class ApiError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
  }
}

type LogLevel = "info" | "warn" | "error";

/**
 * Emit one-line, machine-readable operational logs without including query
 * text, authorization headers, or other credentials.
 */
function apiLog(level: LogLevel, event: string, details: Record<string, unknown> = {}) {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...details,
  });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}

function requiredTargetProject(): string {
  const configured = process.env.GRAPHYTI_TARGET_PROJECT?.trim();
  if (!configured) throw new Error("GRAPHYTI_TARGET_PROJECT must point to the project Graphyti may change.");

  // dotenv intentionally does not expand shell expressions. Supporting $PWD
  // keeps a local `.env` ergonomic while still resolving to one fixed path.
  const expanded = configured === "$PWD"
    ? process.cwd()
    : configured.startsWith("$PWD/")
      ? path.join(process.cwd(), configured.slice("$PWD/".length))
      : configured;
  const projectRoot = path.resolve(expanded);
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw new Error(`GRAPHYTI_TARGET_PROJECT is not a directory: ${projectRoot}`);
  }
  return projectRoot;
}

function auth(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.GRAPHYTI_API_TOKEN;
  if (!expected || req.header("authorization") !== `Bearer ${expected}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

function graphStatus(projectRoot: string): { graphReady: boolean; nodeCount?: number } {
  const mapPath = graphMapPath(projectRoot);
  if (!fs.existsSync(mapPath)) return { graphReady: false };

  return { graphReady: true, nodeCount: Object.keys(loadGraphMap(projectRoot)).length };
}

function graphCounts(projectRoot: string): { nodeCount: number; edgeCount: number } {
  const graph = loadGraphMap(projectRoot);
  return {
    nodeCount: Object.keys(graph).length,
    edgeCount: Object.values(graph).reduce((count, node) => count + node.edges.length, 0),
  };
}

function git(projectRoot: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const detail = error && typeof error === "object" && "stderr" in error
      ? String((error as { stderr?: string }).stderr).trim()
      : "";
    throw new ApiError(`Git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
}

function ensureCleanGitRepo(projectRoot: string) {
  if (git(projectRoot, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    throw new ApiError("GRAPHYTI_TARGET_PROJECT must be inside a git worktree.", 400);
  }
  if (git(projectRoot, ["status", "--porcelain"])) {
    throw new ApiError("Target repo has uncommitted changes. Commit or discard them before running a write query.", 409);
  }
}

type QueryBranch = { name: string; originalRef: string };

function createQueryBranch(projectRoot: string, query: string): QueryBranch {
  const originalRef = (() => {
    try {
      return git(projectRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    } catch {
      return git(projectRoot, ["rev-parse", "HEAD"]);
    }
  })();
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "change";
  const name = `graphyti/${timestamp}-${slug}`;
  git(projectRoot, ["checkout", "-b", name]);
  return { name, originalRef };
}

function discardEmptyBranch(projectRoot: string, branch: QueryBranch): boolean {
  if (git(projectRoot, ["status", "--porcelain"])) return false;
  git(projectRoot, ["checkout", branch.originalRef]);
  git(projectRoot, ["branch", "-D", branch.name]);
  return true;
}

function commitQuery(projectRoot: string, branch: QueryBranch, query: string, paths: string[]) {
  // Only stage files reported by the pipeline. Never scoop up unrelated files
  // created by another editor or process while this request was running.
  git(projectRoot, ["add", "-A", "--", ...paths]);
  // A generator can target a file but leave it byte-for-byte unchanged. Do not
  // turn that safe no-op into a 500 from `git commit`; the caller will remove
  // the empty branch and return the normal blocked/no-write result instead.
  if (!git(projectRoot, ["diff", "--cached", "--name-only"])) return false;
  git(projectRoot, ["commit", "-m", `graphyti: ${query.slice(0, 160)}`]);
  return true;
}

function commandOutput(command: string, args: string[], projectRoot: string): string | null {
  try {
    return execFileSync(command, args, { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

function pushBranch(projectRoot: string, branch: string): { pushed: boolean; note?: string } {
  if (!commandOutput("git", ["remote", "get-url", "origin"], projectRoot)) {
    return { pushed: false, note: "No origin remote is configured; branch remains local." };
  }
  const output = commandOutput("git", ["push", "-u", "origin", branch], projectRoot);
  return output === null
    ? { pushed: false, note: "Push failed; the write and local commit succeeded, but the branch remains local." }
    : { pushed: true };
}

function createDraftPr(projectRoot: string, query: string): string | undefined {
  if (commandOutput("gh", ["auth", "status"], projectRoot) === null) return undefined;
  const output = commandOutput("gh", ["pr", "create", "--draft", "--title", query, "--body", "Created by Graphyti"], projectRoot);
  return output?.match(/https:\/\/github\.com\/\S+/)?.[0];
}

const silentEvents: PipelineEvents = {
  message: () => {}, activity: () => {}, toolStart: () => "api", toolUpdate: () => {},
  operations: () => {}, plan: () => {}, planProgress: () => {}, blast: () => {}, diff: () => {},
  confirm: async () => true, logs: () => {}, state: () => {},
};

function streamEvents(send: (message: StreamMessage) => void): PipelineEvents {
  const emit = (
    stage: string,
    status: StreamStatus,
    message: string,
    data?: unknown,
    elapsedMs?: number
  ) => send({ stage, status, message, ...(data === undefined ? {} : { data }), ...(elapsedMs === undefined ? {} : { elapsedMs }) });

  return {
    message: (message) => emit("pipeline", "update", message),
    activity: (label) => {
      if (label) emit(label, "update", label);
    },
    toolStart: (kind, target) => {
      emit(target, "start", `${kind}: ${target}`);
      return target;
    },
    toolUpdate: (target, patch) => {
      const status: StreamStatus = patch.status === "error"
        ? "error"
        : patch.status === "success"
          ? "done"
          : "update";
      emit(target, status, patch.error ?? patch.result ?? target, patch, patch.elapsedMs);
    },
    operations: (operations) => emit("intent extraction", "done", "Intent extracted", operations),
    plan: (plan) => emit("plan", "start", "Multi-step plan created", plan),
    planProgress: (currentIndex, completed, failed) =>
      emit("plan", "update", "Plan progress updated", { currentIndex, completed, failed }),
    blast: (results) => emit("blast radius", "done", "Blast radius computed", results),
    diff: (filePath, patch) => emit("write", "update", `Prepared ${filePath}`, { filePath, patch }),
    confirm: async (request) => {
      emit("confirmation", "done", "Auto-confirmed for API request", request);
      return true;
    },
    logs: (lines) => lines.forEach((line) => emit("pipeline", "update", line)),
    state: (state) => emit(state, "update", state),
  };
}

async function executeQuery(
  query: string,
  dryRun: boolean,
  projectRoot: string,
  events: PipelineEvents = silentEvents,
  signal: AbortSignal = new AbortController().signal
): Promise<CliJsonResult> {
  const startedAt = Date.now();
  let branch: QueryBranch | undefined;
  let noChangesToCommit = false;
  try {
    if (!dryRun) ensureCleanGitRepo(projectRoot);
    const result = await runPipeline(query, {
      dryRun,
      // HTTP has no interactive TTY. This endpoint is always equivalent to --yes.
      autoConfirm: true,
      legacyContext: false,
      projectRoot,
      onBeforeWrite: () => {
        branch = createQueryBranch(projectRoot, query);
      },
    }, events, signal);

    const changed = result.filesWritten.length > 0 || result.filesCreated.length > 0;
    let push: CliJsonResult["push"];
    let prUrl: string | undefined;
    if (branch && changed) {
      if (!commitQuery(projectRoot, branch, query, [...result.filesWritten, ...result.filesCreated])) {
        discardEmptyBranch(projectRoot, branch);
        branch = undefined;
        noChangesToCommit = true;
      } else {
        push = pushBranch(projectRoot, branch.name);
        if (push.pushed) prUrl = createDraftPr(projectRoot, query);
      }
    } else if (branch) {
      discardEmptyBranch(projectRoot, branch);
      branch = undefined;
    }

    return {
      query,
      filesWritten: result.filesWritten,
      blastRadiusSize: result.blastRadiusSize,
      blastRadius: result.blastRadius,
      verification: result.verification,
      graphIndexUpdated: result.graphIndexUpdated,
      elapsedMs: result.elapsedMs,
      exitCode: noChangesToCommit ? 1 : 0,
      ...(branch ? { branch: branch.name } : {}),
      ...(push ? { push } : {}),
      ...(prUrl ? { prUrl } : {}),
    };
  } catch (error) {
    if (branch) {
      try {
        discardEmptyBranch(projectRoot, branch);
      } catch {
        // Keep a non-empty branch intact rather than risking user changes.
      }
    }
    if (error instanceof ApiError) throw error;
    if (error instanceof CancelledError) {
      return { query, filesWritten: [], blastRadiusSize: 0, blastRadius: [], verification: [], graphIndexUpdated: false, elapsedMs: Date.now() - startedAt, exitCode: 1 };
    }
    // Match the CLI's --json behavior for unexpected pipeline failures: the
    // response remains machine-readable and signals the failure via exitCode.
    console.error("Pipeline failed:", error instanceof Error ? error.message : String(error));
    return {
      query,
      filesWritten: [],
      blastRadiusSize: 0,
      blastRadius: [],
      verification: [],
      graphIndexUpdated: false,
      elapsedMs: Date.now() - startedAt,
      exitCode: 2,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const projectRoot = requiredTargetProject();
const app = express();
app.use((req, res, next) => {
  const requestId = randomUUID();
  const startedAt = Date.now();
  res.locals.requestId = requestId;
  res.setHeader("x-request-id", requestId);

  res.on("finish", () => {
    const level: LogLevel = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    apiLog(level, "http_request_complete", {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      elapsedMs: Date.now() - startedAt,
    });
  });
  next();
});
app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use(auth);

app.get("/api/status", (_req, res, next) => {
  try {
    res.json(graphStatus(projectRoot));
  } catch (error) {
    next(error);
  }
});

app.post("/api/init", async (_req, res, next) => {
  const startedAt = Date.now();
  apiLog("info", "graph_init_started", { requestId: res.locals.requestId });
  try {
    await runInitGraph(projectRoot);
    const counts = graphCounts(projectRoot);
    apiLog("info", "graph_init_completed", {
      requestId: res.locals.requestId,
      elapsedMs: Date.now() - startedAt,
      ...counts,
    });
    res.json({ success: true, ...counts });
  } catch (error) {
    apiLog("error", "graph_init_failed", {
      requestId: res.locals.requestId,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
});

app.post("/api/query", async (req: Request<object, object, QueryBody>, res, next) => {
  const query = typeof req.body.query === "string" ? req.body.query.trim() : "";
  if (!query) {
    res.status(400).json({ error: "Request body must include a non-empty query string." });
    return;
  }

  const startedAt = Date.now();
  const dryRun = req.body.dryRun === true;
  apiLog("info", "query_started", {
    requestId: res.locals.requestId,
    transport: "http",
    dryRun,
    queryLength: query.length,
  });
  try {
    const result = await executeQuery(query, dryRun, projectRoot);
    apiLog(result.exitCode === 0 ? "info" : "warn", "query_completed", {
      requestId: res.locals.requestId,
      transport: "http",
      elapsedMs: Date.now() - startedAt,
      exitCode: result.exitCode,
      filesWritten: result.filesWritten.length,
      graphIndexUpdated: result.graphIndexUpdated,
      branch: result.branch,
      pushed: result.push?.pushed,
      prCreated: Boolean(result.prUrl),
    });
    res.json(result);
  } catch (error) {
    apiLog("error", "query_failed", {
      requestId: res.locals.requestId,
      transport: "http",
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  apiLog("error", "http_request_failed", { requestId: res.locals.requestId, error: message });
  res.status(error instanceof ApiError ? error.status : 500).json({ error: message });
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (socket: WebSocket, _request: IncomingMessage, context: { query: string; dryRun: boolean }) => {
  const abort = new AbortController();
  const requestId = randomUUID();
  const startedAt = Date.now();
  let completed = false;
  let disconnected = false;
  apiLog("info", "query_started", {
    requestId,
    transport: "websocket",
    dryRun: context.dryRun,
    queryLength: context.query.length,
  });
  const send = (message: StreamMessage) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  socket.on("close", () => {
    if (!completed) {
      disconnected = true;
      apiLog("warn", "query_cancelled", {
        requestId,
        transport: "websocket",
        elapsedMs: Date.now() - startedAt,
        reason: "client_disconnected",
      });
      abort.abort();
    }
  });

  void (async () => {
    try {
      const result = await executeQuery(
        context.query,
        context.dryRun,
        projectRoot,
        streamEvents(send),
        abort.signal
      );
      completed = true;
      if (!disconnected) {
        apiLog(result.exitCode === 0 ? "info" : "warn", "query_completed", {
          requestId,
          transport: "websocket",
          elapsedMs: Date.now() - startedAt,
          exitCode: result.exitCode,
          filesWritten: result.filesWritten.length,
          graphIndexUpdated: result.graphIndexUpdated,
          branch: result.branch,
          pushed: result.push?.pushed,
          prCreated: Boolean(result.prUrl),
        });
      }
      send({ stage: "complete", result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      completed = true;
      apiLog("error", "query_failed", {
        requestId,
        transport: "websocket",
        elapsedMs: Date.now() - startedAt,
        error: message,
      });
      send({ stage: "complete", status: "error", message, result: {
        query: context.query,
        filesWritten: [],
        blastRadiusSize: 0,
        blastRadius: [],
        verification: [],
        graphIndexUpdated: false,
        elapsedMs: 0,
        exitCode: 2,
        error: message,
      } });
    } finally {
      if (socket.readyState === WebSocket.OPEN) socket.close();
    }
  })();
});

server.on("upgrade", (request, socket, head) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (requestUrl.pathname !== "/api/query/stream") {
    apiLog("warn", "websocket_upgrade_rejected", { path: requestUrl.pathname, statusCode: 404 });
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  const expected = process.env.GRAPHYTI_API_TOKEN;
  if (!expected || request.headers.authorization !== `Bearer ${expected}`) {
    apiLog("warn", "websocket_upgrade_rejected", { path: requestUrl.pathname, statusCode: 401 });
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const query = requestUrl.searchParams.get("query")?.trim() ?? "";
  if (!query) {
    apiLog("warn", "websocket_upgrade_rejected", { path: requestUrl.pathname, statusCode: 400 });
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (websocket) => {
    wss.emit("connection", websocket, request, {
      query,
      dryRun: requestUrl.searchParams.get("dryRun") === "true",
    });
  });
});

const port = Number(process.env.PORT ?? 4000);
server.listen(port, () => apiLog("info", "server_started", { port, projectRoot }));
