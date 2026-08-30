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
import fs from "fs";
import { creationDiff, unifiedDiff } from "../core/diff";
import {
  captureConsole,
  decolorize,
  type ConsoleCapture,
} from "./captureConsole";
import type { PermissionRequest, ToolCall, ToolKind } from "../state/types";
import type { StatusKind } from "../theme/tokens";
import type { BlastRadiusResult } from "../../graph/blastRadius";
import type { UnifiedValidationResult } from "../../verify/unifiedValidation";

export interface PipelineOptions {
  dryRun: boolean;
  autoConfirm: boolean;
  legacyContext: boolean;
  projectRoot: string;
  /** Runs after validation and immediately before the first write. */
  onBeforeWrite?: () => void | Promise<void>;
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
  /** Complete enforced/advisory blast-radius reports, one per breaking change. */
  blastRadius: BlastRadiusResult[];
  /** Complete verification reports, one per verification pass. */
  verification: UnifiedValidationResult[];
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
    blastRadius: [],
    verification: [],
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
    // Never throws: a classification timeout used to abort the entire run
    // before any work happened. A failure degrades to a single step instead.
    const { classification, degraded } = await classifyQueryWithRetry(query, context.text);
    if (degraded) {
      events.message(`Could not plan multi-step work (${degraded}) — treating this as a single change.`);
    }
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
    return { text: formatLegacyContext(loadContext(options.projectRoot)), label: "legacy context" };
  }

  try {
    const { retrieveContext } = await import("../../generate/retrieveContext");
    const retrieved = await retrieveContext(query);
    if (retrieved) return { text: retrieved, label: "graph context" };
  } catch {
    // Fall through to the flat context below — a graph miss is recoverable and
    // should not end the run.
  }

  return { text: formatLegacyContext(loadContext(options.projectRoot)), label: "fallback context" };
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

  const { resolveProjectPath } = await import("../../utils/paths");
  const {
    extractIntentWithRetry,
    applyScopedEdits,
    applySchemaEdit,
  } = await import("../../generate/scopedEdit");
  const {
    analyzeBreakingChanges,
    affectedFilePaths,
    describeBreakingChanges,
    promptInjectionFor,
    schemaEditsOf,
  } = await import("../../graph/changeAnalysis");
  const { codeGen } = await import("../../utils/agent");
  const { regenerateAffectedFile } = await import("../../generate/regenerateFile");

  type Plan = import("../../generate/scopedEdit").EditPlan;
  type GenFile = import("../../verify/verifyChange").GeneratedFile;

  const schemaPath = findSchema(projectRoot);
  const schemaSource = schemaPath ? fs.readFileSync(schemaPath, "utf-8") : undefined;

  /** Project-relative paths a plan already covers with a file operation. */
  const editedPaths = (plan: Plan): Set<string> => {
    const paths = new Set<string>();
    for (const op of plan) {
      if (op.type !== "file" && op.type !== "create_file") continue;
      const resolved = resolveProjectPath(op.filePath, projectRoot);
      if (resolved) paths.add(resolved.rel);
    }
    return paths;
  };

  /** Apply every file edit in memory, so verification judges post-edit content. */
  const materialize = (plan: Plan): { files: GenFile[]; unapplied: string[] } => {
    const files: GenFile[] = [];
    const unapplied: string[] = [];
    for (const op of plan) {
      if (op.type === "create_file") {
        const resolved = resolveProjectPath(op.filePath, projectRoot);
        if (resolved) files.push({ path: resolved.abs, content: op.content });
        continue;
      }
      if (op.type !== "file") continue;
      const resolved = resolveProjectPath(op.filePath, projectRoot);
      if (!resolved || !fs.existsSync(resolved.abs)) continue;
      try {
        const current = fs.readFileSync(resolved.abs, "utf-8");
        files.push({
          path: resolved.abs,
          content: applyScopedEdits(current, op.edits, op.filePath),
        });
      } catch (err) {
        // Reported, not dropped: a silently discarded edit makes verification
        // blame the model for ignoring a file when the real cause was an
        // oldText that never matched.
        unapplied.push(
          `${op.filePath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return { files, unapplied };
  };

  /**
   * The schema as it will look after every schema op in the plan.
   *
   * `write: false` keeps this out of the working tree — computing it used to
   * commit the change early, so the write phase then applied the same edit to
   * an already edited file and duplicated an added field.
   */
  const proposeSchema = (plan: Plan): string | undefined => {
    const schemaEdits = schemaEditsOf(plan);
    if (schemaEdits.length === 0 || !schemaPath) return undefined;
    let source = fs.readFileSync(schemaPath, "utf-8");
    for (const edit of schemaEdits) {
      try {
        source = applySchemaEdit(source, edit, schemaPath, projectRoot, { write: false });
      } catch {
        return undefined;
      }
    }
    return source;
  };

  // ── Intent ─────────────────────────────────────────────────────────────────
  events.state("thinking");
  events.activity("Extracting edit intent");
  const editPlan = await extractIntentWithRetry(stepQuery, context, schemaSource);
  throwIfAborted(signal);

  if (editPlan.length === 0) {
    events.message("I could not find a concrete change to make for that request.");
    return;
  }

  events.operations(editPlan as unknown[]);

  // ── Blast radius ───────────────────────────────────────────────────────────
  //
  // Derived from the INTENT so the generation prompt can carry it. Running
  // generation first meant the model never saw which downstream files it was
  // also responsible for, and every one of them had to be patched afterwards.
  events.state("tool_running");
  events.activity("Analysing blast radius");
  const blastTool = events.toolStart("analyze", "blast radius");
  const blastStart = Date.now();

  const changes = await analyzeBreakingChanges(editPlan, projectRoot);
  throwIfAborted(signal);

  const mustChange = affectedFilePaths(changes);
  const promptInjection = changes.length > 0 ? promptInjectionFor(changes) : "";
  result.blastRadiusSize += mustChange.length;
  result.blastRadius.push(...changes.map(({ blastRadius }) => blastRadius));

  if (changes.length === 0) {
    events.toolUpdate(blastTool, {
      status: "success",
      result: "no breaking schema change",
      elapsedMs: Date.now() - blastStart,
    });
  } else {
    events.toolUpdate(blastTool, {
      status: mustChange.length > 0 ? "warning" : "success",
      result: `${mustChange.length} downstream ${mustChange.length === 1 ? "file" : "files"}`,
      elapsedMs: Date.now() - blastStart,
    });

    events.blast(
      changes.map(({ blastRadius }) => ({
        modelName: blastRadius.changedNode.name,
        routes: blastRadius.affectedRoutes,
        components: blastRadius.affectedComponents,
        files: blastRadius.affectedFiles,
      }))
    );

    if (mustChange.length > 0 && !options.dryRun && !options.autoConfirm) {
      const approved = await events.confirm({
        title: "Breaking schema change",
        consequence: `${mustChange.length} downstream ${mustChange.length === 1 ? "file references" : "files reference"} this and must change with it.`,
        question: "Write these changes anyway?",
        danger: true,
      });
      throwIfAborted(signal);
      if (!approved) throw new CancelledError();
    }
  }

  // ── Generation ─────────────────────────────────────────────────────────────
  events.state("thinking");
  events.activity("Generating code");
  const actions = await codeGen(editPlan, stepQuery, context + promptInjection);
  throwIfAborted(signal);

  if (!actions?.length) {
    events.message("The generation step produced no changes.");
    return;
  }

  // ── Re-generation for uncovered blast-radius files ────────────────────────
  if (mustChange.length > 0 && !options.dryRun) {
    const covered = editedPaths(actions);
    const uncovered = mustChange.filter((p) => !covered.has(p));

    if (uncovered.length > 0) {
      events.state("tool_running");
      events.activity(`Generating edits for ${uncovered.length} affected file(s)`);
      const reGenTool = events.toolStart("edit", `${uncovered.length} affected file(s)`);
      const reGenStart = Date.now();

      const schemaChange = describeBreakingChanges(changes);
      const oldFields = [...new Set(changes.flatMap((c) => c.breakingFieldNames))];
      const referenceMode = changes.some((c) => c.referenceMode === "model") ? "model" : "field";
      let added = 0;

      for (const filePath of uncovered) {
        throwIfAborted(signal);
        const absPath = path.resolve(projectRoot, filePath);
        if (!fs.existsSync(absPath)) continue;

        try {
          const outcome = await regenerateAffectedFile({
            filePath,
            currentContent: fs.readFileSync(absPath, "utf-8"),
            schemaChange,
            oldFields,
            referenceMode,
            context: context + "\n" + promptInjection,
          });
          if (outcome.edit) {
            actions.push(outcome.edit);
            added++;
          } else {
            events.message(`Could not update ${filePath}: ${outcome.reason}`);
          }
        } catch (err) {
          events.message(
            `Could not update ${filePath}: ${err instanceof Error ? err.message : err}`
          );
        }
      }

      events.toolUpdate(reGenTool, {
        status: added === uncovered.length ? "success" : "warning",
        result: `${added}/${uncovered.length} affected file(s) updated`,
        elapsedMs: Date.now() - reGenStart,
      });
    }
  }

  // ── Structural Verification ────────────────────────────────────────────────
  let verifiedActions: Plan = actions;

  if (changes.length > 0 && !options.dryRun) {
    events.state("tool_running");
    events.activity("Running structural verification");
    const verifyTool = events.toolStart("analyze", "structural verification");
    const verifyStart = Date.now();

    const { runUnifiedValidation } = await import("../../verify/unifiedValidation");
    const proposedSchemaSource = proposeSchema(actions);

    const firstPass = materialize(actions);
    for (const problem of firstPass.unapplied) {
      events.message(`Edit could not be applied — ${problem}`);
    }

    let unifiedResult: import("../../verify/unifiedValidation").UnifiedValidationResult;
    try {
      unifiedResult = await runUnifiedValidation({
        changes,
        generatedFiles: firstPass.files,
        projectRoot,
        proposedSchemaSource,
      });
    } catch (err) {
      events.toolUpdate(verifyTool, {
        status: "error",
        error: `structural validation crashed: ${err instanceof Error ? err.message : err}`,
        elapsedMs: Date.now() - verifyStart,
      });
      throwIfAborted(signal);
      throw new CancelledError();
    }

    const verifyElapsed = Date.now() - verifyStart;
    result.verification.push(unifiedResult);
    events.toolUpdate(verifyTool, {
      status: unifiedResult.overallPassed ? "success" : "error",
      result: unifiedResult.summary,
      elapsedMs: verifyElapsed,
    });

    if (!unifiedResult.overallPassed && unifiedResult.localCheck.missed > 0) {
      events.activity(`Retrying for ${unifiedResult.localCheck.missed} missed file(s)`);
      const retryTool = events.toolStart("edit", "retry missed files");
      const retryStart = Date.now();

      const missedPaths = unifiedResult.localCheck.report.missed.map((m) => m.filePath);
      let retryActions: Plan = [];

      // Retry each missed file individually. The file is already known, so the
      // model gets one narrow question with the file in front of it, and the
      // answer is checked against the verifier's own predicate before it is
      // accepted — a retry that returns here is guaranteed to verify.
      const schemaChange = describeBreakingChanges(changes);
      const oldFields = [...new Set(changes.flatMap((c) => c.breakingFieldNames))];
      const referenceMode = changes.some((c) => c.referenceMode === "model") ? "model" : "field";

      for (const filePath of missedPaths) {
        throwIfAborted(signal);
        const absPath = path.resolve(projectRoot, filePath);
        if (!fs.existsSync(absPath)) continue;
        try {
          const outcome = await regenerateAffectedFile({
            filePath,
            currentContent: fs.readFileSync(absPath, "utf-8"),
            schemaChange,
            oldFields,
            referenceMode,
            context: context + "\n" + promptInjection,
          });
          if (outcome.edit) retryActions.push(outcome.edit);
          else events.message(`Retry could not fix ${filePath}: ${outcome.reason}`);
        } catch (err) {
          events.message(
            `Retry could not fix ${filePath}: ${err instanceof Error ? err.message : err}`
          );
        }
      }

      if (retryActions.length === 0) {
        events.toolUpdate(retryTool, {
          status: "error",
          error: "retry produced no usable edits",
          elapsedMs: Date.now() - retryStart,
        });
        throwIfAborted(signal);
        throw new CancelledError();
      }

      const merged: Plan = actions.filter((a) => {
        if (a.type !== "file") return true;
        const resolved = resolveProjectPath(a.filePath, projectRoot);
        return !resolved || !missedPaths.includes(resolved.rel);
      });
      merged.push(...retryActions);

      const retryResult = await runUnifiedValidation({
        changes,
        generatedFiles: materialize(merged).files,
        projectRoot,
        proposedSchemaSource,
        skipGraphCheck: true,
      });
      result.verification.push(retryResult);

      if (retryResult.localCheck.missed > 0) {
        events.toolUpdate(retryTool, {
          status: "error",
          error: `retry still missed ${retryResult.localCheck.missed} file(s): ${retryResult.localCheck.report.missed
            .map((m) => m.filePath)
            .join(", ")}`,
          elapsedMs: Date.now() - retryStart,
        });
        throwIfAborted(signal);
        throw new CancelledError();
      }

      verifiedActions = merged;
      events.toolUpdate(retryTool, {
        status: "success",
        result: `retry succeeded — all ${retryResult.localCheck.addressed} file(s) verified`,
        elapsedMs: Date.now() - retryStart,
      });
    } else if (!unifiedResult.overallPassed) {
      events.toolUpdate(verifyTool, {
        status: "error",
        error: unifiedResult.resolutionReason,
        elapsedMs: verifyElapsed,
      });
      throwIfAborted(signal);
      throw new CancelledError();
    }
  }

  // ── Write ──────────────────────────────────────────────────────────────────
  events.state("tool_running");
  events.activity(options.dryRun ? "Previewing changes" : "Writing files");

  // Callers such as the HTTP API can establish a safe write boundary here.
  // This is deliberately after verification, so a rejected plan never creates
  // external state such as an empty git branch.
  if (!options.dryRun) await options.onBeforeWrite?.();

  // Snapshot every file the plan targets before anything is written, so the diff
  // shown to the user is the real before/after rather than a re-derivation. The
  // pipeline logs its own diffs to stdout, but those are pre-coloured strings
  // that cannot enter the line model.
  const targets = collectTargets(verifiedActions, projectRoot);
  const before = snapshotFiles(targets);

  const { handleAgentOutput } = await import("../../agentPipeline");
  const writeResult = await handleAgentOutput(verifiedActions, {
    dryRun: options.dryRun,
    // Command execution asks through our own permission prompt, so the pipeline's
    // readline-based confirm must never engage: it would read from the same stdin
    // Ink holds in raw mode and hang the app.
    yes: true,
    projectRoot,
  });
  throwIfAborted(signal);

  if (options.dryRun) {
    // Nothing was written, so project the result in memory to preview it.
    for (const preview of await previewDiffs(verifiedActions, before, projectRoot)) {
      events.diff(preview.relativePath, preview.patch);
    }
  } else {
    for (const absolute of writeResult.writtenPaths) {
      const patch = diffAgainstDisk(absolute, before.get(absolute) ?? null);
      if (patch) events.diff(path.relative(projectRoot, absolute), patch);
    }
    for (const absolute of writeResult.createdPaths) {
      const patch = diffAgainstDisk(absolute, null);
      if (patch) events.diff(path.relative(projectRoot, absolute), patch);
    }
  }

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

  // A failed schema edit aborts the whole write, so nothing reached disk. Say
  // so plainly rather than letting the run look like a success with no files.
  for (const failure of writeResult.schemaFailures) {
    const tool = events.toolStart("edit", `schema: ${failure.edit.op} on ${failure.edit.model}`);
    events.toolUpdate(tool, { status: "error", error: failure.error });
  }
  if (writeResult.schemaFailures.length > 0) {
    events.message(
      `The schema change could not be applied, so nothing was written. Your working tree is unchanged.`
    );
    throw new CancelledError();
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

// ── Diff support ─────────────────────────────────────────────────────────────

type Action = { type?: string; filePath?: string; model?: string };

/** Absolute paths the plan may touch, so they can be snapshotted up front. */
function collectTargets(actions: readonly Action[], projectRoot: string): string[] {
  const paths = new Set<string>();

  for (const action of actions) {
    if (action.type === "file" || action.type === "create_file") {
      if (!action.filePath) continue;
      paths.add(
        path.isAbsolute(action.filePath)
          ? action.filePath
          : path.resolve(projectRoot, action.filePath)
      );
    } else if (action.type === "schema") {
      const schema = findSchema(projectRoot);
      if (schema) paths.add(schema);
    }
  }

  return [...paths];
}

function findSchema(projectRoot: string): string | null {
  for (const candidate of [
    path.join(projectRoot, "prisma", "schema.prisma"),
    path.join(projectRoot, "schema.prisma"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Contents keyed by absolute path; `null` means the file did not exist. */
function snapshotFiles(paths: string[]): Map<string, string | null> {
  const snapshot = new Map<string, string | null>();
  for (const target of paths) {
    try {
      snapshot.set(target, fs.existsSync(target) ? fs.readFileSync(target, "utf-8") : null);
    } catch {
      snapshot.set(target, null);
    }
  }
  return snapshot;
}

function diffAgainstDisk(absolute: string, before: string | null): string | null {
  let after: string;
  try {
    after = fs.readFileSync(absolute, "utf-8");
  } catch {
    return null;
  }

  const patch = before === null ? creationDiff(after) : unifiedDiff(before, after);
  return patch.length > 0 ? patch : null;
}

/**
 * Project a dry run's changes in memory so they can be previewed.
 *
 * `handleAgentOutput` writes nothing in dry-run mode, so there is no "after" on
 * disk to diff against; the same pure edit functions the writer uses are applied
 * here instead. Failures are skipped rather than raised — a preview that cannot
 * be computed is a missing preview, not a failed run.
 */
async function previewDiffs(
  actions: readonly Action[],
  before: Map<string, string | null>,
  projectRoot: string
): Promise<Array<{ relativePath: string; patch: string }>> {
  const { applyScopedEdits, applySchemaEdit } = await import("../../generate/scopedEdit");
  const out: Array<{ relativePath: string; patch: string }> = [];

  for (const action of actions) {
    try {
      if (action.type === "file") {
        const edit = action as unknown as { filePath: string; edits: never };
        const absolute = path.isAbsolute(edit.filePath)
          ? edit.filePath
          : path.resolve(projectRoot, edit.filePath);
        const original = before.get(absolute) ?? null;
        if (original === null) continue;

        const projected = applyScopedEdits(original, edit.edits, edit.filePath);
        const patch = unifiedDiff(original, projected);
        if (patch) out.push({ relativePath: path.relative(projectRoot, absolute), patch });
      } else if (action.type === "create_file") {
        const create = action as unknown as { filePath: string; content: string };
        out.push({
          relativePath: create.filePath,
          patch: creationDiff(create.content),
        });
      } else if (action.type === "schema") {
        const schema = findSchema(projectRoot);
        if (!schema) continue;
        const original = before.get(schema) ?? null;
        if (original === null) continue;

        const projected = applySchemaEdit(original, action as never, schema, projectRoot);
        const patch = unifiedDiff(original, projected);
        if (patch) out.push({ relativePath: path.relative(projectRoot, schema), patch });
      }
    } catch {
      // A preview that cannot be computed is skipped; the write path reports the
      // same failure properly, with a real error block.
      continue;
    }
  }

  return out;
}
