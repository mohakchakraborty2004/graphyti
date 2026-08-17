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
import type { ExpectedDelta } from "../../graph/expectedDelta";

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
  // Schema operations that can break existing call sites: removing or renaming
  // fields, changing types, and removing models entirely.
  const breaking = actions.filter(
    (action): action is Extract<(typeof actions)[number], { type: "schema" }> =>
      action.type === "schema" &&
      (action.op === "remove_field" ||
        action.op === "rename_field" ||
        action.op === "change_type" ||
        action.op === "remove_model")
  );

  let blastResults: BlastRadiusResult[] = [];
  let breakingFieldNames: string[] = [];
  let expectedDeltas: ExpectedDelta[] = [];

  if (breaking.length > 0) {
    events.state("tool_running");
    events.activity("Analysing blast radius");
    const blastTool = events.toolStart("analyze", "blast radius");
    const blastStart = Date.now();

    const { computeBlastRadius } = await import("../../graph/blastRadius");
    const modelIds = [...new Set(breaking.map((op) => `model:${op.model}`))];

    blastResults = await Promise.all(
      modelIds.map((id) => computeBlastRadius(id, projectRoot))
    );
    throwIfAborted(signal);

    const size = blastResults.reduce(
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
      blastResults.map((r) => ({
        modelName: r.changedNode?.id?.replace(/^model:/, "") ?? r.changedNode?.name ?? "unknown",
        routes: r.affectedRoutes ?? [],
        components: r.affectedComponents ?? [],
        files: r.affectedFiles ?? [],
      }))
    );

    // Collect breaking field names per model for verification
    breakingFieldNames = breaking
      .filter((op): op is Extract<typeof op, { type: "schema" }> => op.type === "schema")
      .map((op) => op.fieldName ?? "")
      .filter(Boolean);

    // Compute expected structural deltas for graph verification
    const { computeExpectedDelta } = await import("../../graph/expectedDelta");
    expectedDeltas = breaking
      .filter((op): op is import("../../generate/scopedEdit").SchemaEdit => op.type === "schema")
      .map((op) => {
        const blast = blastResults.find(
          (br) => br.changedNode.id === `model:${op.model}`
        );
        return computeExpectedDelta(
          op,
          blast ?? {
            changedNode: { id: `model:${op.model}`, name: op.model, kind: "PrismaModel", filePath: "" },
            affectedRoutes: [],
            affectedComponents: [],
            affectedFiles: [],
          },
          projectRoot
        );
      });

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

    // ── Re-generate for blast-radius-affected files ──────────────────
    if (size > 0 && !options.dryRun) {
      const affectedFilePaths = [...new Set(
        blastResults.flatMap((r) => [
          ...r.affectedRoutes.map((n) => n.filePath),
          ...r.affectedComponents.map((n) => n.filePath),
          ...r.affectedFiles.map((n) => n.filePath),
        ])
      )];

      const existingEditedPaths = new Set(
        actions
          .filter((a) => a.type === "file")
          .map((a) => {
            const fe = a as { filePath: string };
            const abs = path.isAbsolute(fe.filePath) ? fe.filePath : path.resolve(projectRoot, fe.filePath);
            return path.relative(projectRoot, abs).replace(/\\/g, "/");
          })
      );
      const uncoveredPaths = affectedFilePaths.filter((p) => !existingEditedPaths.has(p));

      if (uncoveredPaths.length > 0) {
        events.state("tool_running");
        events.activity(`Generating edits for ${uncoveredPaths.length} affected file(s)`);
        const reGenTool = events.toolStart("edit", `${uncoveredPaths.length} affected file(s)`);
        const reGenStart = Date.now();

        const { scopedCodeGen, validateEditPlan } = await import("../../generate/scopedEdit");

        const schemaOpDesc = breaking
          .map((op) => {
            if (op.type !== "schema") return "";
            if (op.op === "rename_field") return `${op.model}.${op.fieldName} was renamed to ${op.newFieldName}`;
            if (op.op === "remove_field") return `${op.model}.${op.fieldName} was removed`;
            if (op.op === "change_type") return `${op.model}.${op.fieldName} type changed from ${op.fieldType} to ${op.newFieldType}`;
            if (op.op === "remove_model") return `model ${op.model} was removed`;
            return "";
          })
          .filter(Boolean)
          .join("; ");

        for (const filePath of uncoveredPaths) {
          const absPath = path.isAbsolute(filePath)
            ? filePath
            : path.resolve(projectRoot, filePath);
          if (!fs.existsSync(absPath)) continue;
          const content = fs.readFileSync(absPath, "utf-8");
          const lines = content.split("\n");
          const snippet = lines.slice(0, 80).join("\n") + (lines.length > 80 ? `\n... (${lines.length - 80} more lines)` : "");

          const singleQuery =
            `The schema had this change: ${schemaOpDesc}.\n` +
            `Update the file "${filePath}" to stay consistent with this schema change.\n` +
            `Produce MINIMAL oldText/newText edits. oldText must be a verbatim snippet (2-5 lines) from the file.\n` +
            `Do NOT modify anything unrelated to the schema change. Return ONLY file edits.\n` +
            `If the file does not need any changes, return an empty edits array [].`;

          const singlePlan: import("../../generate/scopedEdit").EditPlan = [{
            type: "file",
            filePath,
            edits: [{ filePath, oldText: "", newText: "" }],
          }];

          try {
            const fileActions = await scopedCodeGen(singleQuery, context, singlePlan, 60_000);
            const check = validateEditPlan(fileActions);
            if (check.ok) {
              for (const action of check.plan) {
                if (action.type === "file" && action.edits.some((e) => e.oldText !== "")) {
                  actions.push(action as typeof actions[number]);
                }
              }
            }
          } catch {
            // LLM errors during re-generation are non-fatal
          }
        }

        events.toolUpdate(reGenTool, {
          status: "success",
          result: `re-generated for ${uncoveredPaths.length} file(s)`,
          elapsedMs: Date.now() - reGenStart,
        });
      }
    }
  }

  // ── Structural Verification ────────────────────────────────────────────────
  let verifiedActions = actions;

  if (blastResults.length > 0 && !options.dryRun) {
    events.state("tool_running");
    events.activity("Running structural verification");
    const verifyTool = events.toolStart("analyze", "structural verification");
    const verifyStart = Date.now();

    const { runUnifiedValidation } = await import("../../verify/unifiedValidation");
    const { applyScopedEdits, applySchemaEdit } = await import("../../generate/scopedEdit");

    // Collect all affected node IDs for graph check
    const allAffectedNodeIds = [
      ...blastResults.flatMap((r) => [
        ...r.affectedRoutes.map((n) => n.id),
        ...r.affectedComponents.map((n) => n.id),
        ...r.affectedFiles.map((n) => n.id),
      ]),
    ];

    // Build generatedFiles for validation
    const generatedFilesForValidation: import("../../verify/verifyChange").GeneratedFile[] = [];
    for (const action of actions) {
      if (action.type !== "file") continue;
      const fe = action as { filePath: string; edits: Array<{ oldText: string; newText: string }> };
      const absPath = path.isAbsolute(fe.filePath)
        ? fe.filePath
        : path.resolve(projectRoot, fe.filePath);
      if (!fs.existsSync(absPath)) continue;
      try {
        const current = fs.readFileSync(absPath, "utf-8");
        const content = applyScopedEdits(current, fe.edits, fe.filePath);
        generatedFilesForValidation.push({ path: absPath, content });
      } catch {
        // If edits can't be applied, skip this file
      }
    }

    // Build proposed schema source for graph check
    const schemaEdit = actions.find((a): a is import("../../generate/scopedEdit").SchemaEdit => a.type === "schema");
    let proposedSchemaSource: string | undefined;
    if (schemaEdit) {
      const schema = findSchema(projectRoot);
      if (schema) {
        const currentSchema = fs.readFileSync(schema, "utf-8");
        try {
          proposedSchemaSource = applySchemaEdit(currentSchema, schemaEdit, schema, projectRoot);
        } catch {
          // Could not compute proposed schema — non-fatal
        }
      }
    }

    let unifiedResult: import("../../verify/unifiedValidation").UnifiedValidationResult;
    try {
      unifiedResult = await runUnifiedValidation({
        blastRadius: blastResults[0],
        breakingFieldNames,
        generatedFiles: generatedFilesForValidation,
        expectedDeltas,
        blastRadiusAffectedNodeIds: allAffectedNodeIds,
        projectRoot,
        proposedSchemaSource,
      });
    } catch (err) {
      unifiedResult = {
        localCheck: { addressed: 0, missed: 0, report: { addressed: [], missed: [], retryPrompt: "" } },
        graphCheck: { addressed: 0, missed: 1, staleNodesFound: 0, report: { graphAddressed: [], graphMissed: [{ nodeId: "unknown", reason: err instanceof Error ? err.message : String(err) }], staleNodesFound: [] } },
        graphCheckSkipped: false,
        overallPassed: false,
        summary: `Structural validation FAILED: ${err instanceof Error ? err.message : err}`,
        resolutionReason: `ERROR: ${err instanceof Error ? err.message : err}`,
      };
    }

    const verifyElapsed = Date.now() - verifyStart;

    events.toolUpdate(verifyTool, {
      status: unifiedResult.overallPassed ? "success" : "error",
      result: unifiedResult.summary,
      elapsedMs: verifyElapsed,
    });

    // ── Retry mechanism: if local check failed, re-prompt once ──────
    if (!unifiedResult.overallPassed && unifiedResult.localCheck.missed > 0) {
      const retryPrompt = unifiedResult.localCheck.report.retryPrompt;
      if (retryPrompt) {
        events.activity(`Retrying for ${unifiedResult.localCheck.missed} missed file(s)`);
        const retryTool = events.toolStart("edit", "retry missed files");
        const retryStart = Date.now();

        const { extractIntentWithRetry } = await import("../../generate/scopedEdit");
        const { codeGen } = await import("../../utils/agent");

        const retryQuery = stepQuery + retryPrompt;

        try {
          const retryPlan = await extractIntentWithRetry(retryQuery, context);
          const retryActions = await codeGen(retryPlan, retryQuery, context);

          if (retryActions?.length) {
            // Build generated files for retry verification
            const retryGeneratedFiles: import("../../verify/verifyChange").GeneratedFile[] = [...generatedFilesForValidation];
            for (const action of retryActions) {
              if (action.type !== "file") continue;
              const fe = action as { filePath: string; edits: Array<{ oldText: string; newText: string }> };
              const absPath = path.isAbsolute(fe.filePath)
                ? fe.filePath
                : path.resolve(projectRoot, fe.filePath);
              if (!fs.existsSync(absPath)) continue;
              try {
                const current = fs.readFileSync(absPath, "utf-8");
                const content = applyScopedEdits(current, fe.edits, fe.filePath);
                const rel = path.relative(projectRoot, absPath).replace(/\\/g, "/");
                const existingIdx = retryGeneratedFiles.findIndex((f) => {
                  const fRel = path.relative(projectRoot, f.path).replace(/\\/g, "/");
                  return fRel === rel;
                });
                if (existingIdx >= 0) {
                  retryGeneratedFiles[existingIdx] = { path: absPath, content };
                } else {
                  retryGeneratedFiles.push({ path: absPath, content });
                }
              } catch {
                // If edits can't be applied, skip this file
              }
            }

            // Re-run local verification with retry results
            const retryResult = await runUnifiedValidation({
              blastRadius: blastResults[0],
              breakingFieldNames,
              generatedFiles: retryGeneratedFiles,
              expectedDeltas: [],
              blastRadiusAffectedNodeIds: allAffectedNodeIds,
              projectRoot,
              proposedSchemaSource,
            });

            if (retryResult.localCheck.missed === 0) {
              // Retry succeeded — merge first-pass + retry actions
              const missedFilePaths = new Set(
                unifiedResult.localCheck.report.missed.map((m) => m.filePath)
              );
              const mergedActions = actions.filter((a) => {
                if (a.type !== "file") return true;
                const fe = a as { filePath: string };
                const abs = path.isAbsolute(fe.filePath)
                  ? fe.filePath
                  : path.resolve(projectRoot, fe.filePath);
                const rel = path.relative(projectRoot, abs).replace(/\\/g, "/");
                return !missedFilePaths.has(rel);
              });
              mergedActions.push(...retryActions);
              verifiedActions = mergedActions;

              events.toolUpdate(retryTool, {
                status: "success",
                result: `retry succeeded — all ${retryResult.localCheck.addressed + retryResult.localCheck.missed} files verified`,
                elapsedMs: Date.now() - retryStart,
              });
            } else {
              // Retry still failed — block
              events.toolUpdate(retryTool, {
                status: "error",
                error: `retry still missed ${retryResult.localCheck.missed} file(s)`,
                elapsedMs: Date.now() - retryStart,
              });
              throwIfAborted(signal);
              throw new CancelledError();
            }
          } else {
            events.toolUpdate(retryTool, {
              status: "error",
              error: "retry returned no actions",
              elapsedMs: Date.now() - retryStart,
            });
            throwIfAborted(signal);
            throw new CancelledError();
          }
        } catch (err) {
          if (err instanceof CancelledError) throw err;
          events.toolUpdate(retryTool, {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
            elapsedMs: Date.now() - retryStart,
          });
          throwIfAborted(signal);
          throw new CancelledError();
        }
      } else {
        // No retry prompt available — block
        events.toolUpdate(verifyTool, {
          status: "error",
          error: unifiedResult.resolutionReason,
          elapsedMs: verifyElapsed,
        });
        throwIfAborted(signal);
        throw new CancelledError();
      }
    } else if (!unifiedResult.overallPassed) {
      // Failed but no missed files (e.g. stale nodes) — block
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
