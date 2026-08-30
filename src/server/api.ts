import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { CancelledError, runPipeline, type PipelineEvents } from "../tui/engine/runPipeline";
import { runInitGraph } from "../cli/init-graph";
import { graphMapPath, loadGraphMap } from "../graph/ingest";

type QueryBody = { query?: unknown; yes?: unknown; dryRun?: unknown };

/** The exact result envelope printed by the CLI's --json mode. */
type CliJsonResult = {
  query: string;
  filesWritten: string[];
  blastRadiusSize: number;
  verification: "skipped";
  graphIndexUpdated: boolean;
  elapsedMs: number;
  exitCode: number;
  branch?: string;
};

class ApiError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
  }
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

function commitQuery(projectRoot: string, branch: QueryBranch, query: string) {
  git(projectRoot, ["add", "-A"]);
  // A generator can target a file but leave it byte-for-byte unchanged. Do not
  // turn that safe no-op into a 500 from `git commit`; the caller will remove
  // the empty branch and return the normal blocked/no-write result instead.
  if (!git(projectRoot, ["status", "--porcelain"])) return false;
  git(projectRoot, ["commit", "-m", `graphyti: ${query.slice(0, 160)}`]);
  return true;
}

const events: PipelineEvents = {
  message: () => {}, activity: () => {}, toolStart: () => "api", toolUpdate: () => {},
  operations: () => {}, plan: () => {}, planProgress: () => {}, blast: () => {}, diff: () => {},
  confirm: async () => true, logs: () => {}, state: () => {},
};

async function executeQuery(query: string, dryRun: boolean, projectRoot: string): Promise<CliJsonResult> {
  const startedAt = Date.now();
  if (!dryRun) ensureCleanGitRepo(projectRoot);
  let branch: QueryBranch | undefined;
  let noChangesToCommit = false;
  try {
    const result = await runPipeline(query, {
      dryRun,
      // HTTP has no interactive TTY. This endpoint is always equivalent to --yes.
      autoConfirm: true,
      legacyContext: false,
      projectRoot,
      onBeforeWrite: () => {
        branch = createQueryBranch(projectRoot, query);
      },
    }, events, new AbortController().signal);

    const changed = result.filesWritten.length > 0 || result.filesCreated.length > 0;
    if (branch && changed) {
      if (!commitQuery(projectRoot, branch, query)) {
        discardEmptyBranch(projectRoot, branch);
        branch = undefined;
        noChangesToCommit = true;
      }
    } else if (branch) {
      discardEmptyBranch(projectRoot, branch);
      branch = undefined;
    }

    return {
      query,
      filesWritten: result.filesWritten,
      blastRadiusSize: result.blastRadiusSize,
      verification: "skipped",
      graphIndexUpdated: result.graphIndexUpdated,
      elapsedMs: result.elapsedMs,
      exitCode: noChangesToCommit ? 1 : 0,
      ...(branch ? { branch: branch.name } : {}),
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
      return { query, filesWritten: [], blastRadiusSize: 0, verification: "skipped", graphIndexUpdated: false, elapsedMs: Date.now() - startedAt, exitCode: 1 };
    }
    // Match the CLI's --json behavior for unexpected pipeline failures: the
    // response remains machine-readable and signals the failure via exitCode.
    console.error("Pipeline failed:", error instanceof Error ? error.message : String(error));
    return { query, filesWritten: [], blastRadiusSize: 0, verification: "skipped", graphIndexUpdated: false, elapsedMs: Date.now() - startedAt, exitCode: 2 };
  }
}

const projectRoot = requiredTargetProject();
const app = express();
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
  try {
    await runInitGraph(projectRoot);
    res.json({ success: true, ...graphCounts(projectRoot) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/query", async (req: Request<object, object, QueryBody>, res, next) => {
  const query = typeof req.body.query === "string" ? req.body.query.trim() : "";
  if (!query) {
    res.status(400).json({ error: "Request body must include a non-empty query string." });
    return;
  }

  try {
    res.json(await executeQuery(query, req.body.dryRun === true, projectRoot));
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("API request failed:", message);
  res.status(error instanceof ApiError ? error.status : 500).json({ error: message });
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`Graphyti API listening on http://127.0.0.1:${port} for ${projectRoot}`));
