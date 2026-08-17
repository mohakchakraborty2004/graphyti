/**
 * Pipeline runner — the generation pipeline, decoupled from rendering.
 *
 * Previously this logic lived inside the component and called `setState` at each
 * step, which produced a genuine deadlock: the multi-step confirmation waited on
 * `awaitingConfirmation` by polling a value captured in its own closure, so it
 * never observed the user's answer and always fell through to the 30-second
 * timeout. That is fixed here by inverting the dependency — the runner *asks*
 * for a decision through `events.confirm()` and awaits a real promise that the
 * UI resolves.
 *
 * The runner knows nothing about React or Ink. It reports progress through
 * `PipelineEvents`, which also makes the whole flow testable headlessly.
 */

import path from "path";
import {
  captureConsole,
  decolorize,
  type ConsoleCapture,
} from "./captureConsole";
import type { PermissionRequest, ToolCall, ToolKind } from "../state/types";
import type { StatusKind } from "../theme/tokens";

export interface PipelineOptions {
  dryRun: boolean;
  autoConfirm: boolean;
  legacyContext: boolean;
  projectRoot: string;
}

export interface PipelineEvents {
  /** The agent's own narration. */
  message: (text: string) => void;
  /** Current activity for the status bar. */
  activity: (label: string | null) => void;
  /** A tool call started. Returns an id for later updates. */
  toolStart: (kind: ToolKind, target: string) => string;
  /** A tool call finished or changed state. */
  toolUpdate: (
    id: string,
    patch: { status?: StatusKind; result?: string; error?: string; output?: string; elapsedMs?: number }
  ) => void;
  /** The extracted edit plan. */
  operations: (ops: unknown[]) => void;
  /** A multi-step plan, and progress through it. */
  plan: (
    steps: Array<{ description: string; kind: "structural_edit" | "new_file" }>
  ) => void;
  planProgress: (currentIndex: number, completed: number[], failed: number[]) => void;
  /** Blast radius results. */
  blast: (
    results: Array<{
      modelName: string;
      routes: Array<{ name: string; filePath: string; reason: string }>;
      components: Array<{ name: string; filePath: string; reason: string }>;
      files: Array<{ name: string; filePath: string; reason: string }>;
    }>
  ) => void;
  /** A file diff to display. */
  diff: (filePath: string, patch: string) => void;
  /** Ask the user to approve something. Resolves to their answer. */
  confirm: (request: Omit<PermissionRequest, "id">) => Promise<boolean>;
  /** Captured pipeline logs. */
  logs: (lines: string[]) => void;
  /** Phase transition, for the state machine. */
  state: (state: "thinking" | "planning" | "tool_running") => void;
}

export interface PipelineResult {
  filesWritten: string[];
  filesCreated: string[];
  commands: string[];
  blastRadiusSize: number;
  graphIndexUpdated: boolean;
  elapsedMs: number;
}

/** Raised when the user cancels; the caller renders this as `cancelled`. */
export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new CancelledError();
}

/**
 * Run one query end to end.
 *
 * Every stage: mark activity, run, report. Console output is captured for the
 * whole run and handed over at the end, so pipeline `console.log` calls cannot
 * tear the live frame.
 */
export async function runPipeline(
  query: string,
  options: PipelineOptions,
  events: PipelineEvents,
  signal: AbortSignal
): Promise<PipelineResult> {
  const startedAt = Date.now();
  const capture: ConsoleCapture = captureConsole();

  const result: PipelineResult = {
    filesWritten: [],
    filesCreated: [],
    commands: [],
    blastRadiusSize: 0,
    graphIndexUpdated: false,
    elapsedMs: 0,
  };

  try {
    // ── Context ──────────────────────────────────────────────────────────────
    events.state("thinking");
    events.activity("Retrieving codebase context");
    const contextTool = events.toolStart("search", "codebase context");
    const contextStart = Date.now();

    const context = await loadContextFor(query, options);
    throwIfAborted(signal);

    events.toolUpdate(contextTool, {
      status: "success",
      result: context.label,
      elapsedMs: Date.now() - contextStart,
    });

    // ── Classification ───────────────────────────────────────────────────────
    events.activity("Classifying request");
    const { classifyQueryWithRetry } = await import("../../generate/scopedEdit");
    const classification = await classifyQueryWithRetry(query, context.text);
    throwIfAborted(signal);

    if (classification.decomposable && classification.steps.length > 0) {
      events.state("planning");
      events.plan(classification.steps);
      events.activity("Planning changes");

      if (!options.dryRun && !options.autoConfirm) {
        const approved = await events.confirm({
          title: "Multi-step change",
          consequence: `graphyti will work through ${classification.steps.length} steps in order, writing files as it goes.`,
          question: "Proceed with this plan?",
        });
        throwIfAborted(signal);
        if (!approved) throw new CancelledError();
      }

      const completed: number[] = [];
      const failed: number[] = [];

      for (let i = 0; i < classification.steps.length; i++) {
        throwIfAborted(signal);
        const step = classification.steps[i]!;
        events.planProgress(i, completed, failed);
        events.activity(step.description);

        try {
          await executeStep(step.description, context.text, options, events, signal, result);
          completed.push(i);
        } catch (error) {
          if (error instanceof CancelledError) throw error;
          failed.push(i);
          events.planProgress(i, completed, failed);
          throw error;
        }
      }

      events.planProgress(classification.steps.length, completed, failed);
    } else {
      await executeStep(query, context.text, options, events, signal, result);
    }

    result.elapsedMs = Date.now() - startedAt;
    return result;
  } finally {
    capture.restore();
    const captured = capture.lines().map(decolorize).filter((l) => l.trim().length > 0);
    if (captured.length > 0) events.logs(captured);
    events.activity(null);
  }
}

async function loadContextFor(
  query: string,
  options: PipelineOptions
): Promise<{ text: string; label: string }> {
  const { formatLegacyContext } = await import("../../utils/context");
  const { loadContext } = await import("../../utils/StrAnalyzer");

  if (options.legacyContext) {
    return { text: formatLegacyContext(loadContext()), label: "legacy context" };
  }

  try {
    const { retrieveContext } = await import("../../generate/retrieveContext");
    const retrieved = await retrieveContext(query);
    if (retrieved) return { text: retrieved, label: "graph context" };
  } catch {
    // Fall through to the flat context below — a graph miss is recoverable and
    // should not end the run.
  }

  return { text: formatLegacyContext(loadContext()), label: "fallback context" };
}

async function executeStep(
  stepQuery: string,
  context: string,
  options: PipelineOptions,
  events: PipelineEvents,
  signal: AbortSignal,
  result: PipelineResult
): Promise<void> {
  const { projectRoot } = options;

  // ── Intent ─────────────────────────────────────────────────────────────────
  events.state("thinking");
  events.activity("Extracting edit intent");
  const { extractIntentWithRetry } = await import("../../generate/scopedEdit");
  const editPlan = await extractIntentWithRetry(stepQuery, context);
  throwIfAborted(signal);

  if (editPlan.length === 0) {
    events.message("I could not find a concrete change to make for that request.");
    return;
  }

  events.operations(editPlan as unknown[]);

  // ── Generation ─────────────────────────────────────────────────────────────
  events.activity("Generating code");
  const { codeGen } = await import("../../utils/agent");
  const actions = await codeGen(editPlan, stepQuery, context);
  throwIfAborted(signal);

  if (!actions?.length) {
    events.message("The generation step produced no changes.");
    return;
  }

  // ── Blast radius ───────────────────────────────────────────────────────────
  // Only these three schema operations can break existing call sites; adding a
  // field or a model cannot, so they do not warrant a blast-radius pass.
  const breaking = actions.filter(
    (action): action is Extract<(typeof actions)[number], { type: "schema" }> =>
      action.type === "schema" &&
      (action.op === "remove_field" ||
        action.op === "rename_field" ||
        action.op === "change_type")
  );

  if (breaking.length > 0) {
    events.state("tool_running");
    events.activity("Analysing blast radius");
    const blastTool = events.toolStart("analyze", "blast radius");
    const blastStart = Date.now();

    const { computeBlastRadius } = await import("../../graph/blastRadius");
    const modelIds = [...new Set(breaking.map((op) => `model:${op.model}`))];

    const results = await Promise.all(
      modelIds.map((id) => computeBlastRadius(id, projectRoot))
    );
    throwIfAborted(signal);

    const size = results.reduce(
      (sum, r) =>
        sum +
        (r.affectedRoutes?.length ?? 0) +
        (r.affectedComponents?.length ?? 0) +
        (r.affectedFiles?.length ?? 0),
      0
    );
    result.blastRadiusSize += size;

    events.toolUpdate(blastTool, {
      status: size > 0 ? "warning" : "success",
      result: `${size} downstream ${size === 1 ? "item" : "items"}`,
      elapsedMs: Date.now() - blastStart,
    });

    events.blast(
      results.map((r) => ({
        modelName: r.changedNode?.id?.replace(/^model:/, "") ?? r.changedNode?.name ?? "unknown",
        routes: r.affectedRoutes ?? [],
        components: r.affectedComponents ?? [],
        files: r.affectedFiles ?? [],
      }))
    );

    if (size > 0 && !options.dryRun && !options.autoConfirm) {
      const approved = await events.confirm({
        title: "Breaking schema change",
        consequence: `${size} downstream ${size === 1 ? "file" : "files"} reference this model and may stop compiling.`,
        question: "Write these changes anyway?",
        danger: true,
      });
      throwIfAborted(signal);
      if (!approved) throw new CancelledError();
    }
  }

  // ── Write ──────────────────────────────────────────────────────────────────
  events.state("tool_running");
  events.activity(options.dryRun ? "Previewing changes" : "Writing files");

  const { handleAgentOutput } = await import("../../agentPipeline");
  const writeResult = await handleAgentOutput(actions, {
    dryRun: options.dryRun,
    // Command execution asks through our own permission prompt below, so the
    // pipeline's readline-based confirm must never engage: it would read from
    // the same stdin Ink holds in raw mode and hang the app.
    yes: true,
    projectRoot,
  });
  throwIfAborted(signal);

  for (const absolute of writeResult.writtenPaths) {
    const relative = path.relative(projectRoot, absolute);
    result.filesWritten.push(relative);
    const tool = events.toolStart(options.dryRun ? "read" : "edit", relative);
    events.toolUpdate(tool, {
      status: "success",
      result: options.dryRun ? "would change" : "updated",
    });
  }

  for (const absolute of writeResult.createdPaths) {
    const relative = path.relative(projectRoot, absolute);
    result.filesCreated.push(relative);
    const tool = events.toolStart("create", relative);
    events.toolUpdate(tool, { status: "success", result: "created" });
  }

  for (const failure of writeResult.createFailures) {
    const tool = events.toolStart("create", failure.edit.filePath);
    events.toolUpdate(tool, { status: "error", error: failure.error });
  }

  for (const stale of writeResult.staleEdits) {
    const tool = events.toolStart("edit", stale.edit.filePath);
    events.toolUpdate(tool, {
      status: "error",
      error: "file changed since it was read",
    });
  }

  result.commands.push(...writeResult.executedCommands);

  // ── Graph index ────────────────────────────────────────────────────────────
  if (writeResult.writtenPaths.length > 0 && !options.dryRun) {
    events.activity("Updating graph index");
    const indexTool = events.toolStart("index", "graph index");
    const indexStart = Date.now();

    const { reingestFile } = await import("../../graph/incremental");
    let indexed = 0;
    for (const absolute of writeResult.writtenPaths) {
      if (signal.aborted) break;
      try {
        await reingestFile(absolute, projectRoot);
        indexed++;
      } catch {
        // Re-indexing is best-effort: a stale index degrades later context
        // quality but must not fail a run whose files are already written.
      }
    }

    result.graphIndexUpdated = indexed > 0;
    events.toolUpdate(indexTool, {
      status: indexed === writeResult.writtenPaths.length ? "success" : "warning",
      result: `${indexed}/${writeResult.writtenPaths.length} files`,
      elapsedMs: Date.now() - indexStart,
    });
  }
}
