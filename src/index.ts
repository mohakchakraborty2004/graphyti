#!/usr/bin/env node

import * as path from "path";
import * as fs from "fs";
import { Command } from "commander";
import ContextGen, { formatLegacyContext } from "./utils/context";
import { codeGen } from "./utils/agent";
import { loadContext } from "./utils/StrAnalyzer";
import { handleAgentOutput, StaleEditError, AmbiguousEditError } from "./agentPipeline";
import { runInitGraph } from "./cli/init-graph";
import { retrieveContext } from "./generate/retrieveContext";
import { extractIntentWithRetry, applyScopedEdits, applySchemaEdit, scopedCodeGen, validateEditPlan, classifyQueryWithRetry, type EditPlan, type FileEdit, type CreateFile, type Classification, type Step, type SchemaEdit } from "./generate/scopedEdit";
import { type GeneratedFile } from "./verify/verifyChange";
import { runUnifiedValidation, type UnifiedValidationResult } from "./verify/unifiedValidation";
import { reingestFile } from "./graph/incremental";
import { computeExpectedDelta, type ExpectedDelta } from "./graph/expectedDelta";

import {
  computeBlastRadius,
  formatBlastRadius,
  blastRadiusPromptSection,
  type BlastRadiusResult,
} from "./graph/blastRadius";
import {
  accent, success, error, warn, info, sym, bold,
  fmtElapsed, rule, section, summaryBox, row,
  setJsonMode, isJsonMode, print, printErr,
} from "./cli/theme";
import ora from "ora";

const program = new Command();

function spinner(text: string) {
  return ora({ text, color: "cyan", isEnabled: !isJsonMode() });
}

// ---------------------------------------------------------------------------
// Multi-step orchestration types
// ---------------------------------------------------------------------------

interface StepResult {
  stepIndex: number;
  description: string;
  success: boolean;
  writtenPaths: string[];
  createdPaths: string[];
  error?: string;
}

class StepError extends Error {
  constructor(
    public stepIndex: number,
    public description: string,
    public reason: string,
    public writtenPaths: string[] = [],
    public createdPaths: string[] = []
  ) {
    super(`Step ${stepIndex + 1} (${description}) failed: ${reason}`);
    this.name = "StepError";
  }
}

// ---------------------------------------------------------------------------
// init — FALLBACK ONLY
// ---------------------------------------------------------------------------
program
  .command("init")
  .description("FALLBACK ONLY — write the flat .dbagent/context.json snapshot (use init-graph instead)")
  .action(async () => {
    print(section("Context"));
    const spin = spinner("Initializing project context...");
    spin.start();
    const t0 = Date.now();
    try {
      await ContextGen();
      spin.succeed(`Context gathering complete ${info(fmtElapsed(Date.now() - t0))}`);
    } catch (err) {
      spin.fail("Context initialization failed");
      throw err;
    }
  });

// ---------------------------------------------------------------------------
// init-graph
// ---------------------------------------------------------------------------
program
  .command("init-graph")
  .description("Extract the code graph and ingest it into HydraDB")
  .argument("[projectRoot]", "project to extract (defaults to cwd)", process.cwd())
  .action(async (projectRoot: string) => {
    await runInitGraph(projectRoot);
  });

// ---------------------------------------------------------------------------
// default command — code generation
// ---------------------------------------------------------------------------
program
  .argument("<query>", "natural language request")
  .option("--legacy-context", "FALLBACK ONLY — force the old flat .dbagent/context.json path instead of the graph")
  .option("--dry-run", "Show blast radius and generated code without writing any files")
  .option("--yes", "Skip the blast-radius and command confirmation prompts and auto-confirm all writes")
  .option("--json", "Output machine-readable JSON (no spinners, no ANSI)")
  .action(async (query: string, options: Record<string, boolean>) => {
    const dryRun = options.dryRun ?? false;
    const yes    = options.yes    ?? false;
    const jsonOut = options.json ?? false;
    const projectRoot = process.cwd();
    const startTime = Date.now();

    if (jsonOut) setJsonMode(true);

    const jsonResult: Record<string, any> = {
      query,
      filesWritten: [],
      blastRadiusSize: 0,
      verification: "skipped",
      graphIndexUpdated: false,
      elapsedMs: 0,
      exitCode: 0,
    };

    try {

    // ── Header ─────────────────────────────────────────────────────────────
    print(rule());
    print(`  ${bold("graphyti")} ${info("v" + require("../package.json").version)}`);
    print(rule());
    print(row("Query", accent(query)));
    if (dryRun) print(row("Mode", info("dry-run")));
    print();

    // =======================================================================
    // 1. Context
    // =======================================================================
    print(section("Context"));
    let context: string;
    const ctxSpin = spinner("Retrieving codebase context...");
    ctxSpin.start();
    const ctxStart = Date.now();

    if (options.legacyContext) {
      ctxSpin.warn("--legacy-context: falling back to .dbagent/context.json");
      context = formatLegacyContext(loadContext());
    } else {
      try {
        context = (await retrieveContext(query)) ?? (() => {
          ctxSpin.warn("HydraDB retrieval returned null — falling back to .dbagent/context.json");
          return formatLegacyContext(loadContext());
        })();
      } catch (err) {
        ctxSpin.fail("Context retrieval failed");
        throw err;
      }
    }

    const ctxElapsed = Date.now() - ctxStart;
    if (ctxElapsed > 2000) {
      ctxSpin.succeed(`Context retrieved ${info(fmtElapsed(ctxElapsed))}`);
    } else {
      ctxSpin.succeed("Context retrieved");
    }
    print();

    if (typeof context !== "string") {
      throw new Error(
        `[context contract] expected string, got ${typeof context} — check the ${
          options.legacyContext ? "--legacy-context" : "HydraDB retrieval"
        } branch`
      );
    }

    const ctxPreview = context.split("\n").slice(0, 15);
    const ctxLineCount = context.split("\n").length;
    print(`    ${info("Context preview")} ${info(`(${ctxLineCount} lines)`)}:`);
    for (const line of ctxPreview) {
      print(`      ${info("│")} ${line}`);
    }
    if (ctxLineCount > 15) {
      print(`      ${info("│")} ${info(`... (${ctxLineCount - 15} more lines)`)}`);
    }
    print();

    // =======================================================================
    // 2. Classification — detect single-step vs. multi-step
    // =======================================================================
    print(section("Classification"));
    const classSpin = spinner("Classifying query...");
    classSpin.start();
    const classStart = Date.now();
    let classification: Classification;
    try {
      classification = await classifyQueryWithRetry(query, context);
    } catch (err) {
      classSpin.fail("Classification failed");
      throw err;
    }
    const classElapsed = Date.now() - classStart;
    classSpin.succeed(`Classified ${info(fmtElapsed(classElapsed))}`);

    if (!classification.decomposable) {
      // Single-step: proceed exactly as before — no overhead
      print(`    ${info("Single-step operation detected")}`);
      print();

      // Run the full pipeline for this single step
      const stepResult = await runStep({
        stepIndex: 0,
        description: query,
        query,
        context,
        projectRoot,
        dryRun,
        yes,
        jsonOut,
        cumulativeResult: { allWrittenPaths: [], allCreatedPaths: [] },
      });

      jsonResult.filesWritten = stepResult.writtenPaths.map((p) => path.relative(projectRoot, p));
      jsonResult.elapsedMs = Date.now() - startTime;
      if (jsonOut) print(JSON.stringify(jsonResult, null, 2));
      return;
    }

    // Multi-step: print the full plan and require confirmation
    print(`    ${warn("Multi-step operation detected")} (${classification.steps.length} steps)`);
    print();
    print(`    ${bold("Planned steps")}:`);
    for (let i = 0; i < classification.steps.length; i++) {
      const step = classification.steps[i];
      const kindLabel = step.kind === "new_file" ? bold("new_file") : bold("structural_edit");
      print(`      ${info(`${i + 1}.`)} ${kindLabel}  ${step.description}`);
    }
    print();

    if (!dryRun && !yes) {
      const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout });
      const confirmed = await new Promise<boolean>((resolve) => {
        rl.question(`  Proceed with all ${classification.steps.length} steps? (y/N) `, (answer: string) => {
          rl.close();
          resolve(answer.trim().toLowerCase().startsWith("y"));
        });
      });
      if (!confirmed) {
        print(`  ${warn("!")} Plan rejected by user.`);
        jsonResult.exitCode = 1;
        if (jsonOut) print(JSON.stringify(jsonResult, null, 2));
        process.exit(1);
      }
    }
    print();

    // ── Execute each step sequentially ────────────────────────────────
    const multiStepStart = Date.now();
    const stepResults: StepResult[] = [];
    const allWrittenPaths: string[] = [];
    const allCreatedPaths: string[] = [];
    let stoppedEarly = false;

    for (let i = 0; i < classification.steps.length; i++) {
      const step = classification.steps[i];
      const stepQuery = step.description;

      // Re-retrieve context before each step so the graph sees prior steps' writes
      let stepContext: string;
      try {
        const freshCtx = await retrieveContext(stepQuery);
        stepContext = freshCtx ?? context; // fall back to initial context if retrieval fails
      } catch {
        stepContext = context; // fall back on error
      }

      try {
        const result = await runStep({
          stepIndex: i,
          description: step.description,
          query: stepQuery,
          context: stepContext,
          projectRoot,
          dryRun,
          yes,
          jsonOut,
          cumulativeResult: { allWrittenPaths, allCreatedPaths },
        });

        stepResults.push(result);
        allWrittenPaths.push(...result.writtenPaths);
        allCreatedPaths.push(...result.createdPaths);

        print(`  ${sym.ok} Step ${i + 1}/${classification.steps.length} complete`);
        print();
      } catch (err) {
        if (err instanceof StepError) {
          stepResults.push({
            stepIndex: err.stepIndex,
            description: err.description,
            success: false,
            writtenPaths: err.writtenPaths,
            createdPaths: err.createdPaths,
            error: err.reason,
          });
          allWrittenPaths.push(...err.writtenPaths);
          allCreatedPaths.push(...err.createdPaths);

          printErr(`\n  ${error("✗")} Step ${i + 1}/${classification.steps.length} FAILED: ${err.reason}`);
          printErr(`  ${warn("!")} Stopping — remaining steps may depend on this step's output.`);
          printErr(`  ${info("Note:")} Files written by earlier steps remain on disk (atomic per-step, not atomic across plan).`);
          stoppedEarly = true;
          break;
        }
        throw err;
      }
    }

    // ── Multi-step summary ──────────────────────────────────────────
    const multiElapsed = Date.now() - multiStepStart;
    const completed = stepResults.filter((r) => r.success).length;
    const failed = stepResults.filter((r) => !r.success).length;
    const skipped = classification.steps.length - stepResults.length;

    print(section("Multi-step Summary"));
    print(summaryBox([
      ["Steps planned",  `${classification.steps.length}`],
      ["Steps completed", `${success(`${completed}`)}`],
      ["Steps failed",   failed > 0 ? `${error(`${failed}`)}` : `${info("0")}`],
      ["Steps skipped",  skipped > 0 ? `${warn(`${skipped}`)}` : `${info("0")}`],
      ["Files written",  `${allWrittenPaths.length}`],
      ["New files",      `${allCreatedPaths.length}`],
      ["Elapsed",        accent.bold(fmtElapsed(multiElapsed))],
    ]));

    if (stoppedEarly) {
      jsonResult.exitCode = 1;
    }
    jsonResult.filesWritten = allWrittenPaths.map((p) => path.relative(projectRoot, p));
    jsonResult.elapsedMs = Date.now() - startTime;
    if (jsonOut) print(JSON.stringify(jsonResult, null, 2));
    return;

    } catch (err) {
      // ── StepError: expected/handled failure (verification block, write failure, etc.) ──
      if (err instanceof StepError) {
        print();
        print(section("Failed"));
        print(summaryBox([
          ["Step", `${err.stepIndex + 1}: ${err.description}`],
          ["Reason", error(err.reason)],
          ["Files written", info(`${err.writtenPaths.length}`)],
          ["Files created", info(`${err.createdPaths.length}`)],
          ["Elapsed", accent.bold(fmtElapsed(Date.now() - startTime))],
        ]));
        if (err.writtenPaths.length === 0 && err.createdPaths.length === 0) {
          print(`  ${sym.ok} Nothing was written to disk — operation fully rolled back`);
        }
        jsonResult.exitCode = 1;
        jsonResult.filesWritten = err.writtenPaths.map((p) => path.relative(projectRoot, p));
        jsonResult.elapsedMs = Date.now() - startTime;
        if (jsonOut) print(JSON.stringify(jsonResult, null, 2));
        process.exitCode = 1;
        return;
      }

      // ── Unexpected crash: genuine internal error ──
      print();
      print(section("Unexpected Error"));
      print(summaryBox([
        ["Error", error(err instanceof Error ? err.message : String(err))],
        ["Elapsed", accent.bold(fmtElapsed(Date.now() - startTime))],
      ]));
      print(`  ${warn("!")} This is an unexpected internal error, not a verification block.`);
      print(`  ${info("Stack")}: ${err instanceof Error ? err.stack : "N/A"}`);
      jsonResult.exitCode = 2;
      jsonResult.elapsedMs = Date.now() - startTime;
      if (jsonOut) print(JSON.stringify(jsonResult, null, 2));
      process.exitCode = 2;
      return;
    }
  });

program.parse();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findSchemaPath(projectRoot: string): string | null {
  const candidates = [
    path.join(projectRoot, "prisma", "schema.prisma"),
    path.join(projectRoot, "schema.prisma"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function planToGeneratedFiles(plan: EditPlan, projectRoot: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const item of plan) {
    if (item.type === "file") {
      const absPath = path.isAbsolute(item.filePath)
        ? item.filePath
        : path.resolve(projectRoot, item.filePath);
      if (fs.existsSync(absPath)) {
        const current = fs.readFileSync(absPath, "utf-8");
        try {
          const content = applyScopedEdits(current, item.edits, item.filePath);
          files.push({ path: absPath, content });
        } catch {
          // If edits can't be applied, skip this file for verification
        }
      }
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// runStep — execute the single-operation pipeline for one step
//
// Runs: intent extraction → generation → blast radius → verification → write
// → graph reingestion. Uses the step's description as the query.
//
// Throws StepError on failure instead of process.exit(1).
// ---------------------------------------------------------------------------

interface StepOptions {
  stepIndex: number;
  description: string;
  query: string;       // the step description, used as the LLM query
  context: string;     // codebase context (retrieved per-step for freshness)
  projectRoot: string;
  dryRun: boolean;
  yes: boolean;
  jsonOut: boolean;
  cumulativeResult: {
    allWrittenPaths: string[];
    allCreatedPaths: string[];
  };
}

async function runStep(opts: StepOptions): Promise<StepResult> {
  const { stepIndex, description, query, context, projectRoot, dryRun, yes, jsonOut } = opts;
  const stepLabel = `Step ${stepIndex + 1}: ${description}`;

  const jsonResult: Record<string, any> = {
    query,
    filesWritten: [],
    blastRadiusSize: 0,
    verification: "skipped",
    graphIndexUpdated: false,
  };

  print(section(`[${stepLabel}]`));

  // ── 3. Intent Extraction ──────────────────────────────────────────
  print(section("Intent"));
  const intentSpin = spinner("Extracting edit intent...");
  intentSpin.start();
  const intentStart = Date.now();
  let editPlan: EditPlan;
  try {
    const schemaPath = findSchemaPath(projectRoot);
    const schemaSource = schemaPath ? fs.readFileSync(schemaPath, "utf-8") : undefined;
    editPlan = await extractIntentWithRetry(query, context, schemaSource);
  } catch (err) {
    intentSpin.fail("Intent extraction failed");
    throw new StepError(stepIndex, description, `Intent extraction failed: ${err instanceof Error ? err.message : err}`);
  }
  const intentElapsed = Date.now() - intentStart;
  if (editPlan.length === 0) {
    intentSpin.info("No operations extracted.");
    return {
      stepIndex,
      description,
      success: true,
      writtenPaths: [],
      createdPaths: [],
    };
  }
  intentSpin.succeed(`Intent extracted ${info(fmtElapsed(intentElapsed))}`);
  print(`    ${info(`${editPlan.length} operation(s) extracted`)}`);

  // Show extracted operations
  print(`    ${info("Operations")}:`);
  for (const op of editPlan) {
    if (op.type === "schema") {
      print(`      ${sym.bullet} ${bold("schema")}  ${op.op} on ${op.model}.${op.fieldName ?? ""}`);
    } else if (op.type === "file") {
      const editCount = op.edits.length;
      print(`      ${sym.bullet} ${bold("file")}    ${op.filePath} ${info(`(${editCount} edit${editCount > 1 ? "s" : ""})`)}`);
    } else if (op.type === "command") {
      print(`      ${sym.bullet} ${bold("cmd")}     ${op.command}`);
    } else if (op.type === "create_file") {
      print(`      ${sym.bullet} ${bold("create")}  ${op.filePath} ${info(`— ${op.reason}`)}`);
    }
  }
  print();

  // ── 4. Code Generation ────────────────────────────────────────────
  print(section("Generation"));
  const genSpin = spinner("Generating changes...");
  genSpin.start();
  const genStart = Date.now();
  let actions = await codeGen(editPlan, query, context);
  const genElapsed = Date.now() - genStart;

  if (!actions?.length) {
    genSpin.info("No actions generated.");
    return {
      stepIndex,
      description,
      success: true,
      writtenPaths: [],
      createdPaths: [],
    };
  }
  genSpin.succeed(`Code generated ${info(fmtElapsed(genElapsed))}`);
  print(`    ${info(`${actions.length} action(s) returned from model`)}`);

  // ── Post-process: fix new-file edits (LLM may return non-empty oldText) ──
  for (const action of actions) {
    if (action.type !== "file") continue;
    const absPath = path.isAbsolute(action.filePath)
      ? action.filePath
      : path.resolve(projectRoot, action.filePath);
    if (fs.existsSync(absPath)) continue; // file exists, leave edits as-is

    // File doesn't exist — treat as new file creation
    // Merge all newText into a single content, use empty oldText
    const fullContent = action.edits.map((e) => e.newText).join("\n");
    action.edits = [{ filePath: action.filePath, oldText: "", newText: fullContent }];
  }

  // Show what will be applied
  print(`    ${info("Actions")}:`);
  for (const action of actions) {
    if (action.type === "schema") {
      print(`      ${sym.bullet} ${bold("schema")}  ${action.op} on ${action.model}.${action.fieldName ?? ""}`);
    } else if (action.type === "file") {
      const editCount = action.edits.length;
      print(`      ${sym.bullet} ${bold("file")}    ${action.filePath} ${info(`(${editCount} edit${editCount > 1 ? "s" : ""})`)}`);
    } else if (action.type === "command") {
      print(`      ${sym.bullet} ${bold("cmd")}     ${action.command}`);
    } else if (action.type === "create_file") {
      print(`      ${sym.bullet} ${bold("create")}  ${action.filePath} ${info(`— ${action.reason}`)}`);
    }
  }
  print();

  // ── 5. Blast Radius ───────────────────────────────────────────────
  const schemaEdits = actions.filter((a) => a.type === "schema");
  const isBreaking = (op: typeof schemaEdits[number]) =>
    op.type === "schema" && (op.op === "remove_field" || op.op === "rename_field" || op.op === "change_type");
  const breakingEdits = schemaEdits.filter(isBreaking);

  let blastResults: BlastRadiusResult[] = [];
  let promptInjection = "";
  let breakingFieldNamesPerModel: string[][] = [];
  const llmProcessedFiles = new Set<string>();
  let expectedDeltas: ExpectedDelta[] = [];

  if (breakingEdits.length > 0) {
    print(section("Blast Radius"));
    const checkSpin = spinner("Analyzing schema changes...");
    checkSpin.start();
    const checkStart = Date.now();

    print(`\n  ${warn("!")} ${bold("Breaking changes:")}`);
    for (const op of breakingEdits) {
      if (op.type !== "schema") continue;
      if (op.op === "remove_field") {
        print(`    ${error("−")} ${op.model}.${op.fieldName} ${error("removed")}`);
      } else if (op.op === "rename_field") {
        print(`    ${error("−")} ${op.model}.${op.fieldName} ${info(`→ ${op.newFieldName}`)}`);
      } else if (op.op === "change_type") {
        print(`    ${error("−")} ${op.model}.${op.fieldName} ${info(`${op.fieldType} → ${op.newFieldType}`)}`);
      }
    }

    const additiveEdits = schemaEdits.filter(
      (op) => op.type === "schema" && op.op === "add_field"
    );
    for (const op of additiveEdits) {
      if (op.type !== "schema") continue;
      print(`    ${info("+")} ${op.model}.${op.fieldName} ${info("(additive)")}`);
    }

    const modelIds = [...new Set(breakingEdits.map((op) => `model:${op.type === "schema" ? op.model : ""}`))];
    blastResults = await Promise.all(
      modelIds.map((id) => computeBlastRadius(id, projectRoot))
    );

    for (const result of blastResults) {
      print();
      print(formatBlastRadius(result));
    }

    promptInjection = blastResults
      .map(blastRadiusPromptSection)
      .filter(Boolean)
      .join("\n");

    breakingFieldNamesPerModel = blastResults.map((br) => {
      const modelName = br.changedNode.id.replace(/^model:/, "");
      return breakingEdits
        .filter((op) => op.type === "schema" && op.model === modelName)
        .map((op) => (op.type === "schema" ? op.fieldName : ""))
        .filter(Boolean) as string[];
    });

    const checkElapsed = Date.now() - checkStart;
    const blastSize = blastResults.reduce(
      (sum, r) => sum + r.affectedRoutes.length + r.affectedComponents.length + r.affectedFiles.length,
      0
    );
    jsonResult.blastRadiusSize = blastSize;
    checkSpin.succeed(`Blast radius computed ${info(fmtElapsed(checkElapsed))}`);
    print();

    // ── Expected structural delta (for HydraDB verification) ───────
    expectedDeltas = breakingEdits
      .filter((op): op is SchemaEdit => op.type === "schema")
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

    // ── Confirmation ───────────────────────────────────────────────
    if (!dryRun && !yes) {
      const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout });
      const confirmed = await new Promise<boolean>((resolve) => {
        rl.question(`${warn("!")} Proceed with write? [y/N] `, (answer: string) => {
          rl.close();
          resolve(answer.trim().toLowerCase().startsWith("y"));
        });
      });
      if (!confirmed) {
        throw new StepError(stepIndex, description, "Write aborted by user.");
      }
    }

    // ── Re-generate for blast-radius-affected files ────────────────
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
          const fe = a as FileEdit;
          const abs = path.isAbsolute(fe.filePath) ? fe.filePath : path.resolve(projectRoot, fe.filePath);
          return path.relative(projectRoot, abs).replace(/\\/g, "/");
        })
    );
    const uncoveredPaths = affectedFilePaths.filter((p) => !existingEditedPaths.has(p));

    if (uncoveredPaths.length > 0 && !dryRun) {
      print(section("Re-generation"));
      const reSpin = spinner(`Generating edits for ${uncoveredPaths.length} affected file(s)...`);
      reSpin.start();
      const reStart = Date.now();

      const schemaOpDesc = breakingEdits
        .map((op) => {
          if (op.type !== "schema") return "";
          if (op.op === "rename_field") return `${op.model}.${op.fieldName} was renamed to ${op.newFieldName}`;
          if (op.op === "remove_field") return `${op.model}.${op.fieldName} was removed`;
          if (op.op === "change_type") return `${op.model}.${op.fieldName} type changed from ${op.fieldType} to ${op.newFieldType}`;
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

        const singlePlan: EditPlan = [{
          type: "file",
          filePath,
          edits: [{ filePath, oldText: "", newText: "" }],
        }];

        const singleContext =
          context + "\n" + promptInjection +
          `\n\nFile content (${filePath}, ${lines.length} lines):\n\`\`\`\n${snippet}\n\`\`\``;

        try {
          const fileActions = await scopedCodeGen(singleQuery, singleContext, singlePlan, 60_000);
          const check = validateEditPlan(fileActions);
          if (check.ok) {
            llmProcessedFiles.add(filePath);
            for (const action of check.plan) {
              if (action.type === "file" && action.edits.some((e) => e.oldText !== "")) {
                actions.push(action as FileEdit);
              }
            }
          } else {
            print(`    ${warn("!")} [${filePath}] validation failed: ${check.reason}`);
          }
        } catch (err: any) {
          print(`    ${warn("!")} [${filePath}] LLM error: ${err?.message || err}`);
        }
      }

      const reElapsed = Date.now() - reStart;
      const addedCount = actions.filter((a) => a.type === "file" && !existingEditedPaths.has(
        path.relative(projectRoot, path.isAbsolute((a as FileEdit).filePath) ? (a as FileEdit).filePath : path.resolve(projectRoot, (a as FileEdit).filePath)).replace(/\\/g, "/")
      )).length;
      if (addedCount > 0) {
        reSpin.succeed(`Re-generation complete ${info(fmtElapsed(reElapsed))}`);
        print(`    ${info(`${addedCount} file edit(s) generated for affected files`)}`);
      } else {
        reSpin.info(`No additional file edits generated ${info(fmtElapsed(reElapsed))}`);
      }
      print();
    }
  } else {
    const additiveEdits = schemaEdits.filter(
      (op) => op.type === "schema" && op.op === "add_field"
    );
    if (additiveEdits.length > 0) {
      print(section("Blast Radius"));
      for (const op of additiveEdits) {
        if (op.type !== "schema") continue;
        print(`    ${info("+")} ${op.model}.${op.fieldName} ${info("(additive — no blast radius)")}`);
      }
      print();
    }
  }

  // ── 6. Unified Structural Verification ─────────────────────────────
  let verifiedActions = actions;

  if (blastResults.length > 0 && !dryRun) {
    print(section("Structural Verification"));

    // Collect all affected node IDs for graph check
    const allAffectedNodeIds = [
      ...blastResults.flatMap((r) => [
        ...r.affectedRoutes.map((n) => n.id),
        ...r.affectedComponents.map((n) => n.id),
        ...r.affectedFiles.map((n) => n.id),
      ]),
    ];

    // Build generatedFiles for both checks
    const generatedFilesForValidation: GeneratedFile[] = [];
    for (const action of actions) {
      if (action.type !== "file") continue;
      const fe = action as FileEdit;
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
    const schemaEdit = actions.find((a): a is SchemaEdit => a.type === "schema");
    let proposedSchemaSource: string | undefined;
    if (schemaEdit) {
      const schemaPath = findSchemaPath(projectRoot);
      if (schemaPath) {
        const currentSchema = fs.readFileSync(schemaPath, "utf-8");
        try {
          proposedSchemaSource = applySchemaEdit(currentSchema, schemaEdit, schemaPath, projectRoot);
        } catch {
          print(`  ${warn("!")} Could not compute proposed schema for graph verification`);
        }
      }
    }

    const verifySpin = spinner("Running unified structural validation...");
    verifySpin.start();
    const verifyStart = Date.now();

    let unifiedResult: UnifiedValidationResult;
    try {
      unifiedResult = await runUnifiedValidation({
        blastRadius: blastResults[0],
        breakingFieldNames: breakingFieldNamesPerModel.flat(),
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

    if (unifiedResult.overallPassed) {
      verifySpin.succeed(`Structural verification passed ${info(fmtElapsed(verifyElapsed))}`);
    } else {
      verifySpin.fail(`Structural verification failed ${info(fmtElapsed(verifyElapsed))}`);
    }

    // Display both checks distinctly
    const totalAffected = unifiedResult.localCheck.addressed + unifiedResult.localCheck.missed;
    const localStatus = unifiedResult.localCheck.missed === 0 ? success("PASSED") : error("FAILED");

    // Graph check line: show SKIPPED when it was short-circuited, otherwise show real result
    let graphLine: string;
    if (unifiedResult.graphCheckSkipped) {
      graphLine = `  Graph structural check: ${info("SKIPPED")} (local check failed first)`;
    } else {
      const graphStatus = unifiedResult.graphCheck.staleNodesFound > 0
        ? error("FAILED (stale nodes)")
        : unifiedResult.graphCheck.missed > 0
          ? warn("PASSED (with warnings)")
          : success("PASSED");
      graphLine = `  Graph structural check: ${graphStatus} (${unifiedResult.graphCheck.addressed} relations confirmed, ${unifiedResult.graphCheck.staleNodesFound} stale nodes)`;
    }

    print(`  Local structural check: ${localStatus} (${unifiedResult.localCheck.addressed}/${totalAffected} files verified)`);
    print(graphLine);

    if (unifiedResult.localCheck.missed > 0) {
      printErr(`\n  ${error("✗")} Local check — missed files:`);
      for (const m of unifiedResult.localCheck.report.missed) {
        printErr(`    ${sym.bullet} ${m.filePath}`);
        printErr(`      ${m.reason}`);
      }
    }

    if (!unifiedResult.graphCheckSkipped && unifiedResult.graphCheck.staleNodesFound > 0) {
      printErr(`\n  ${error("✗")} Graph check — stale nodes (invisible to local re-parsing):`);
      for (const stale of unifiedResult.graphCheck.report.staleNodesFound) {
        printErr(`    ${sym.bullet} ${stale.nodeId} — still references stale node ${stale.staleRef}`);
      }
    }

    if (!unifiedResult.graphCheckSkipped && unifiedResult.graphCheck.missed > 0 && unifiedResult.graphCheck.staleNodesFound === 0) {
      print(`\n  ${warn("!")} Graph check — ${unifiedResult.graphCheck.missed} relation(s) differ (likely inferred, not blocking):`);
      for (const miss of unifiedResult.graphCheck.report.graphMissed) {
        print(`    ${sym.bullet} ${miss.nodeId}: ${miss.reason}`);
      }
    }

    print(`  ${info("Resolution")}: ${unifiedResult.resolutionReason}`);

    // ── 6b. Retry mechanism: if local check failed, re-prompt once ──
    if (!unifiedResult.overallPassed && unifiedResult.localCheck.missed > 0) {
      const retryPrompt = unifiedResult.localCheck.report.retryPrompt;
      if (retryPrompt) {
        print();
        print(`  ${warn("!")} Attempting one retry to fix ${unifiedResult.localCheck.missed} missed file(s)...`);
        const retrySpin = spinner("Re-generating for missed files...");
        retrySpin.start();
        const retryStart = Date.now();

        // Build the retry query with missed files appended
        const retryQuery = query + retryPrompt;

        try {
          const retryPlan = await extractIntentWithRetry(retryQuery, context);
          const retryActions = await codeGen(retryPlan, retryQuery, context);

          if (retryActions?.length) {
            // Build generated files for retry verification: first-pass verified + retry-generated
            // This ensures the retry check sees the union, not just the retry output
            const retryGeneratedFiles: GeneratedFile[] = [...generatedFilesForValidation];
            for (const action of retryActions) {
              if (action.type !== "file") continue;
              const fe = action as FileEdit;
              const absPath = path.isAbsolute(fe.filePath)
                ? fe.filePath
                : path.resolve(projectRoot, fe.filePath);
              if (!fs.existsSync(absPath)) continue;
              try {
                const current = fs.readFileSync(absPath, "utf-8");
                const content = applyScopedEdits(current, fe.edits, fe.filePath);
                // Replace or add the file entry (retry overrides first-pass for same path)
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

            // Re-run local verification with the retry results
            const retryResult = await runUnifiedValidation({
              blastRadius: blastResults[0],
              breakingFieldNames: breakingFieldNamesPerModel.flat(),
              generatedFiles: retryGeneratedFiles,
              expectedDeltas: [],  // Skip graph check on retry — only re-check local
              blastRadiusAffectedNodeIds: allAffectedNodeIds,
              projectRoot,
              proposedSchemaSource,
            });

            const retryElapsed = Date.now() - retryStart;

            if (retryResult.localCheck.missed === 0) {
              // Retry succeeded — merge: keep first-pass verified edits + retry edits for missed files
              retrySpin.succeed(`Retry succeeded ${info(fmtElapsed(retryElapsed))}`);
              print(`  ${sym.ok} All ${retryResult.localCheck.addressed + retryResult.localCheck.missed} blast-radius files now addressed`);

              // Collect the file paths that were missed in the first pass (now fixed by retry)
              const missedFilePaths = new Set(
                unifiedResult.localCheck.report.missed.map((m) => m.filePath)
              );

              // Start with all first-pass actions that are NOT file edits for missed paths
              const mergedActions = actions.filter((a) => {
                if (a.type !== "file") return true; // keep schema, command, create_file
                const fe = a as FileEdit;
                const abs = path.isAbsolute(fe.filePath)
                  ? fe.filePath
                  : path.resolve(projectRoot, fe.filePath);
                const rel = path.relative(projectRoot, abs).replace(/\\/g, "/");
                return !missedFilePaths.has(rel); // keep only if NOT in missed list
              });

              // Add all retry actions (they cover the missed files)
              mergedActions.push(...retryActions);

              verifiedActions = mergedActions;
              jsonResult.verification = "passed (after retry)";
              print();
            } else {
              // Retry still failed — hard block
              retrySpin.fail(`Retry failed ${info(fmtElapsed(retryElapsed))}`);
              printErr(`\n  ${error("✗")} Retry still missed ${retryResult.localCheck.missed} file(s):`);
              for (const m of retryResult.localCheck.report.missed) {
                printErr(`    ${sym.bullet} ${m.filePath}`);
                printErr(`      ${m.reason}`);
              }
              print();
              throw new StepError(
                stepIndex, description,
                `Verification failed after retry: ${retryResult.localCheck.missed} file(s) still not addressed`,
                opts.cumulativeResult.allWrittenPaths,
                opts.cumulativeResult.allCreatedPaths
              );
            }
          } else {
            // Retry returned no actions
            retrySpin.fail("Retry returned no actions");
            print();
            throw new StepError(
              stepIndex, description,
              `Verification failed: retry returned no actions for ${unifiedResult.localCheck.missed} missed file(s)`,
              opts.cumulativeResult.allWrittenPaths,
              opts.cumulativeResult.allCreatedPaths
            );
          }
        } catch (err) {
          if (err instanceof StepError) throw err;
          retrySpin.fail(`Retry error: ${err instanceof Error ? err.message : err}`);
          print();
          throw new StepError(
            stepIndex, description,
            `Verification retry failed: ${err instanceof Error ? err.message : err}`,
            opts.cumulativeResult.allWrittenPaths,
            opts.cumulativeResult.allCreatedPaths
          );
        }
      } else {
        // No retry prompt available — hard block
        print();
        throw new StepError(
          stepIndex, description,
          `Structural verification failed: ${unifiedResult.resolutionReason}`,
          opts.cumulativeResult.allWrittenPaths,
          opts.cumulativeResult.allCreatedPaths
        );
      }
    } else if (!unifiedResult.overallPassed) {
      // Failed but no missed files (e.g. stale nodes) — hard block
      print();
      throw new StepError(
        stepIndex, description,
        `Structural verification failed: ${unifiedResult.resolutionReason}`,
        opts.cumulativeResult.allWrittenPaths,
        opts.cumulativeResult.allCreatedPaths
      );
    }

    print();
    jsonResult.verification = "passed";
  }

  // ── 7. Write ──────────────────────────────────────────────────────
  print(section(dryRun ? "Preview" : "Execution"));
  const writeSpin = spinner(dryRun ? "Previewing changes..." : "Writing files...");
  writeSpin.start();
  const writeStart = Date.now();
  writeSpin.stop();

  const result = await handleAgentOutput(verifiedActions, {
    dryRun,
    yes,
    projectRoot,
    onBeforeCommand: () => { writeSpin.stop(); },
  });

  const writeElapsed = Date.now() - writeStart;
  console.log(`    ${sym.ok} ${dryRun ? "Preview" : "Write"} complete ${info(fmtElapsed(writeElapsed))}`);
  print();

  jsonResult.filesWritten = result.writtenPaths.map((p) => path.relative(projectRoot, p));

  // ── Handle stale edits ────────────────────────────────────────────
  if (result.staleEdits.length > 0 && !dryRun) {
    print(section("Retrying stale edits"));
    const retrySpin = spinner("Retrying with current file content...");
    retrySpin.start();

    const failedPaths: string[] = [];
    for (const { edit, error: editError } of result.staleEdits) {
      const absPath = path.isAbsolute(edit.filePath)
        ? edit.filePath
        : path.resolve(projectRoot, edit.filePath);

      if (!fs.existsSync(absPath)) {
        failedPaths.push(edit.filePath);
        continue;
      }

      const currentContent = fs.readFileSync(absPath, "utf-8");
      const retryQuery = `${query}\n\nFILE ${edit.filePath} CURRENT CONTENT:\n\`\`\`\n${currentContent}\n\`\`\`\n\nYour previous oldText didn't match. Provide corrected oldText/newText pairs for ONLY the changes you need to make to this file. Make the minimal change necessary.`;

      try {
        const retryPlan = await extractIntentWithRetry(retryQuery, context);
        const retryActions = await codeGen(retryPlan, retryQuery, context);
        if (retryActions?.length) {
          const retryResult = await handleAgentOutput(retryActions, {
            dryRun: false,
            yes: true,
            projectRoot,
          });
          if (retryResult.staleEdits.length > 0) {
            failedPaths.push(edit.filePath);
          }
        } else {
          failedPaths.push(edit.filePath);
        }
      } catch {
        failedPaths.push(edit.filePath);
      }
    }

    retrySpin.stop();
    if (failedPaths.length > 0) {
      printErr(
        `\n  ${error("✗")} Stale edit retry failed for ${failedPaths.length} file(s):`
      );
      for (const p of failedPaths) {
        printErr(`    ${sym.bullet} ${p}`);
      }
      throw new StepError(
        stepIndex, description,
        `Stale edit retry failed for ${failedPaths.length} file(s)`,
        [...opts.cumulativeResult.allWrittenPaths, ...result.writtenPaths],
        [...opts.cumulativeResult.allCreatedPaths, ...result.createdPaths]
      );
    } else {
      print(`  ${sym.ok} All stale edits retried successfully`);
    }
    print();
  }

  // ── Handle create-file failures ──────────────────────────────────
  if (result.createFailures.length > 0) {
    printErr(
      `\n  ${error("✗")} ${result.createFailures.length} create-file operation(s) failed:`
    );
    for (const { edit, error: msg } of result.createFailures) {
      printErr(`    ${sym.bullet} ${edit.filePath} — ${msg}`);
    }
    throw new StepError(
      stepIndex, description,
      `${result.createFailures.length} create-file operation(s) failed`,
      [...opts.cumulativeResult.allWrittenPaths, ...result.writtenPaths],
      [...opts.cumulativeResult.allCreatedPaths, ...result.createdPaths]
    );
  }

  if (dryRun) {
    return {
      stepIndex,
      description,
      success: true,
      writtenPaths: [],
      createdPaths: [],
    };
  }

  // ── 8. Reingest ───────────────────────────────────────────────────
  if (result.writtenPaths.length > 0 || result.createdPaths.length > 0) {
    print(section("Graph Index"));
    const idxSpin = spinner("Updating graph index...");
    idxSpin.start();
    const idxStart = Date.now();
    const allPaths = [...result.writtenPaths, ...result.createdPaths];
    for (const absPath of allPaths) {
      try {
        await reingestFile(absPath, projectRoot);
      } catch (err) {
        printErr(`  ${warn("!")} reingest failed for ${absPath}:`, err instanceof Error ? err.message : err);
      }
    }
    idxSpin.succeed(`Graph index updated ${info(fmtElapsed(Date.now() - idxStart))}`);
    jsonResult.graphIndexUpdated = true;
    print();
  }

  return {
    stepIndex,
    description,
    success: true,
    writtenPaths: result.writtenPaths,
    createdPaths: result.createdPaths,
  };
}
