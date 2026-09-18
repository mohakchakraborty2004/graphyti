import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { Command } from "commander";
import ContextGen, { formatLegacyContext } from "./utils/context";
import { codeGen } from "./utils/agent";
import { loadContext } from "./utils/StrAnalyzer";
import { handleAgentOutput, StaleEditError, AmbiguousEditError } from "./agentPipeline";
import { runInitGraph } from "./cli/init-graph";
import { retrieveContext } from "./generate/retrieveContext";
import { extractIntentWithRetry, applyScopedEdits, applySchemaEdit, classifyQueryWithRetry, type EditPlan } from "./generate/scopedEdit";
import { type GeneratedFile } from "./verify/verifyChange";
import { runUnifiedValidation, type UnifiedValidationResult } from "./verify/unifiedValidation";
import { reingestFile } from "./graph/incremental";
import { resolveProjectPath } from "./utils/paths";
import { regenerateAffectedFile, clampForPrompt } from "./generate/regenerateFile";
import { injectPrismaCommands } from "./utils/prismaCommands";
import {
  analyzeBreakingChanges,
  affectedFilePaths,
  describeBreakingChanges,
  promptInjectionFor,
  schemaEditsOf,
} from "./graph/changeAnalysis";

import { formatBlastRadius } from "./graph/blastRadius";
import {
  accent, success, error, warn, info, sym, bold,
  fmtElapsed, rule, section, summaryBox, row,
  setJsonMode, isJsonMode, print, printErr,
} from "./cli/theme";
import ora from "ora";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getGraphytiPackageJson() {
  const candidates = [
    path.join(__dirname, "package.json"),
    path.join(__dirname, "..", "package.json"),
    path.join(__dirname, "..", "..", "package.json"),
    path.join(process.cwd(), "package.json"),
  ];

  for (const pkgPath of candidates) {
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    if (pkg.name === "graphyti") return pkg;
  }

  throw new Error("Could not find graphyti package.json");
}

const pkg = getGraphytiPackageJson();

const program = new Command();

// Check if arguments were provided (excluding node and script path)
const args = process.argv.slice(2);
const hasArgs = args.length > 0 && !args[0].startsWith("-");
const isHelp = args.includes("--help") || args.includes("-h");
const isTui = !hasArgs && !isHelp;

function spinner(text: string) {
  // `isEnabled` overrides ora's own TTY detection rather than adding to it, so
  // passing it unconditionally made every redirected run — a log file, a pipe,
  // CI — replay one spinner frame per tick as a separate line, burying the real
  // output under thousands of them. Re-apply the TTY test here.
  return ora({
    text,
    color: "cyan",
    isEnabled: !isJsonMode() && Boolean(process.stdout.isTTY),
  });
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
  public writtenPaths: string[];
  public createdPaths: string[];

  constructor(
    public stepIndex: number,
    public description: string,
    public reason: string,
    writtenPaths: readonly string[] = [],
    createdPaths: readonly string[] = []
  ) {
    super(`Step ${stepIndex + 1} (${description}) failed: ${reason}`);
    this.name = "StepError";
    // A failed step must carry a snapshot. The multi-step accumulator is
    // mutable. Retaining its array instance made the old catch path append the
    // accumulator to itself and duplicate every prior write in the summary.
    this.writtenPaths = [...writtenPaths];
    this.createdPaths = [...createdPaths];
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
// TUI mode — launch when no arguments provided
// ---------------------------------------------------------------------------
if (isTui) {
  (async () => {
    const { launchTui } = await import("./tui");
    const dryRun = args.includes("--dry-run");
    const autoConfirm = args.includes("--yes");
    const legacyContext = args.includes("--legacy-context");

    await launchTui({ dryRun, autoConfirm, legacyContext });
    process.exit(0);
  })();
} else {
  // ---------------------------------------------------------------------------
  // default command — code generation
  // ---------------------------------------------------------------------------
  program
    .argument("[query]", "natural language request")
    .option("--legacy-context", "FALLBACK ONLY — force the old flat .dbagent/context.json path instead of the graph")
    .option("--dry-run", "Show blast radius and generated code without writing any files")
    .option("--yes", "Skip the blast-radius and command confirmation prompts and auto-confirm all writes")
    .option("--json", "Output machine-readable JSON (no spinners, no ANSI)")
    .action(async (query: string | undefined, options: Record<string, boolean>) => {
    if (!query) {
      program.help();
    }
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
    print(`  ${bold("graphyti")} ${info("v" + pkg.version)}`);
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
        context = (await retrieveContext(query ?? "")) ?? (() => {
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
    // Never throws — classification is an optimisation, and a timeout on it
    // used to kill the whole run before a single file was touched.
    const { classification, degraded } = await classifyQueryWithRetry(query ?? "", context);
    const classElapsed = Date.now() - classStart;
    if (degraded) {
      classSpin.warn(`Classification unavailable — treating as a single step ${info(fmtElapsed(classElapsed))}`);
      print(`    ${info(degraded)}`);
    } else {
      classSpin.succeed(`Classified ${info(fmtElapsed(classElapsed))}`);
    }

    if (!classification.decomposable) {
      // Single-step: proceed exactly as before — no overhead
      print(`    ${info("Single-step operation detected")}`);
      print();

      // Run the full pipeline for this single step
      const stepResult = await runStep({
        stepIndex: 0,
        description: query ?? "",
        query: query ?? "",
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
      const readline = await import("readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
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
          // A StepError carries CUMULATIVE totals — everything earlier steps
          // wrote plus whatever this one managed before failing. Replace the
          // accumulator rather than append those totals; appending used to
          // count every earlier write twice. Copy out defensively in case a
          // third-party caller constructs a legacy, aliased StepError.
          const written = [...new Set(err.writtenPaths)];
          const created = [...new Set(err.createdPaths)];

          stepResults.push({
            stepIndex: err.stepIndex,
            description: err.description,
            success: false,
            writtenPaths: written,
            createdPaths: created,
            error: err.reason,
          });

          allWrittenPaths.length = 0;
          allWrittenPaths.push(...written);
          allCreatedPaths.length = 0;
          allCreatedPaths.push(...created);

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
} // end else (hasArgs)

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
  const { stepIndex, description, query, context, projectRoot, dryRun, yes } = opts;
  const stepLabel = `Step ${stepIndex + 1}: ${description}`;

  const fail = (reason: string) =>
    new StepError(
      stepIndex,
      description,
      reason,
      opts.cumulativeResult.allWrittenPaths,
      opts.cumulativeResult.allCreatedPaths
    );

  const noChange = (): StepResult => ({
    stepIndex,
    description,
    success: true,
    writtenPaths: [],
    createdPaths: [],
  });

  print(section(`[${stepLabel}]`));

  const schemaPath = findSchemaPath(projectRoot);
  const schemaSource = schemaPath ? fs.readFileSync(schemaPath, "utf-8") : undefined;

  // ── 3. Intent Extraction ──────────────────────────────────────────
  print(section("Intent"));
  const intentSpin = spinner("Extracting edit intent...");
  intentSpin.start();
  const intentStart = Date.now();
  let editPlan: EditPlan;
  try {
    editPlan = await extractIntentWithRetry(query, context, schemaSource);
  } catch (err) {
    intentSpin.fail("Intent extraction failed");
    throw fail(`Intent extraction failed: ${err instanceof Error ? err.message : err}`);
  }
  const intentElapsed = Date.now() - intentStart;
  if (editPlan.length === 0) {
    intentSpin.info("No operations extracted.");
    return noChange();
  }
  intentSpin.succeed(`Intent extracted ${info(fmtElapsed(intentElapsed))}`);
  print(`    ${info(`${editPlan.length} operation(s) extracted`)}`);
  print(`    ${info("Operations")}:`);
  printOperations(editPlan);
  print();

  // ── 4. Blast Radius ───────────────────────────────────────────────
  //
  // Computed from the INTENT, not from the generated actions, so the model can
  // be told which files it must also fix before it writes a line of code. The
  // previous order ran generation first and then built the prompt injection
  // that generation was supposed to receive, so the main pass never saw the
  // blast radius and every downstream file had to be patched by a second pass.
  const changes = await analyzeBreakingChanges(editPlan, projectRoot);
  const mustChange = affectedFilePaths(changes);
  let promptInjection = "";

  if (changes.length > 0) {
    print(section("Blast Radius"));
    const blastSpin = spinner("Analyzing schema changes...");
    blastSpin.start();
    const blastStart = Date.now();

    print(`\n  ${warn("!")} ${bold("Breaking changes:")}`);
    for (const { edit } of changes) {
      if (edit.op === "remove_field") {
        print(`    ${error("−")} ${edit.model}.${edit.fieldName} ${error("removed")}`);
      } else if (edit.op === "rename_field") {
        print(`    ${error("−")} ${edit.model}.${edit.fieldName} ${info(`→ ${edit.newFieldName}`)}`);
      } else if (edit.op === "change_type") {
        print(`    ${error("−")} ${edit.model}.${edit.fieldName} ${info(`${edit.fieldType} → ${edit.newFieldType}`)}`);
      } else if (edit.op === "remove_model") {
        print(`    ${error("−")} model ${edit.model} ${error("removed")}`);
      }
    }

    for (const change of changes) {
      print();
      print(formatBlastRadius(change.blastRadius));
    }

    promptInjection = promptInjectionFor(changes);
    blastSpin.succeed(`Blast radius computed ${info(fmtElapsed(Date.now() - blastStart))}`);
    print();
    print(`    ${bold(String(mustChange.length))} file(s) must change alongside the schema`);
    print();

    if (!dryRun && !yes) {
      const readline = await import("readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const confirmed = await new Promise<boolean>((resolve) => {
        rl.question(`${warn("!")} Proceed with write? [y/N] `, (answer: string) => {
          rl.close();
          resolve(answer.trim().toLowerCase().startsWith("y"));
        });
      });
      if (!confirmed) throw fail("Write aborted by user.");
    }
  } else {
    const additive = schemaEditsOf(editPlan).filter((op) => op.op === "add_field");
    if (additive.length > 0) {
      print(section("Blast Radius"));
      for (const op of additive) {
        print(`    ${info("+")} ${op.model}.${op.fieldName} ${info("(additive — no blast radius)")}`);
      }
      print();
    }
  }

  // ── 5. Code Generation ────────────────────────────────────────────
  print(section("Generation"));
  const genSpin = spinner("Generating changes...");
  genSpin.start();
  const genStart = Date.now();
  const actions = await codeGen(editPlan, query, context + promptInjection);
  const genElapsed = Date.now() - genStart;

  if (!actions?.length) {
    genSpin.info("No actions generated.");
    return noChange();
  }
  genSpin.succeed(`Code generated ${info(fmtElapsed(genElapsed))}`);
  print(`    ${info(`${actions.length} action(s) returned from model`)}`);

  // ── Post-process: new-file edits (the model may return non-empty oldText) ──
  for (const action of actions) {
    if (action.type !== "file") continue;
    const resolved = resolveProjectPath(action.filePath, projectRoot);
    if (!resolved || fs.existsSync(resolved.abs)) continue;
    const fullContent = action.edits.map((e) => e.newText).join("\n");
    action.edits = [{ filePath: action.filePath, oldText: "", newText: fullContent }];
  }

  injectPrismaCommands(actions);

  print(`    ${info("Actions")}:`);
  printOperations(actions);
  print();

  // ── 6. Re-generation for uncovered blast-radius files ─────────────
  if (mustChange.length > 0 && !dryRun) {
    const covered = editedPaths(actions, projectRoot);
    const uncovered = mustChange.filter((p) => !covered.has(p));

    if (uncovered.length > 0) {
      print(section("Re-generation"));
      const reSpin = spinner(`Generating edits for ${uncovered.length} affected file(s)...`);
      reSpin.start();
      const reStart = Date.now();
      const schemaChange = describeBreakingChanges(changes);
      const oldFields = [...new Set(changes.flatMap((c) => c.breakingFieldNames))];
      const referenceMode = changes.some((c) => c.referenceMode === "model") ? "model" : "field";
      const outcomes: string[] = [];
      let added = 0;

      for (const filePath of uncovered) {
        const abs = path.resolve(projectRoot, filePath);
        if (!fs.existsSync(abs)) continue;

        const result = await regenerateAffectedFile({
          filePath,
          currentContent: fs.readFileSync(abs, "utf-8"),
          schemaChange,
          oldFields,
          referenceMode,
          context: context + "\n" + promptInjection,
        });

        if (result.edit) {
          actions.push(result.edit);
          added++;
          outcomes.push(`    ${sym.ok} ${filePath} ${info(`(${result.strategy})`)}`);
        } else {
          outcomes.push(`    ${warn("!")} ${filePath} — ${result.reason}`);
        }
      }

      const reElapsed = Date.now() - reStart;
      if (added > 0) {
        reSpin.succeed(`Re-generation complete ${info(fmtElapsed(reElapsed))}`);
      } else {
        reSpin.info(`No additional file edits generated ${info(fmtElapsed(reElapsed))}`);
      }
      for (const line of outcomes) print(line);
      print();
    }
  }

  // ── 7. Structural Verification ────────────────────────────────────
  let verifiedActions: EditPlan = actions;

  if (changes.length > 0 && !dryRun) {
    print(section("Structural Verification"));

    const { files: generatedFiles, unapplied } = materialize(actions, projectRoot);
    const proposedSchemaSource = proposeSchema(actions, projectRoot);

    if (unapplied.length > 0) {
      printErr(`  ${warn("!")} ${unapplied.length} edit(s) could not be applied:`);
      for (const u of unapplied) printErr(`    ${sym.bullet} ${u.filePath} — ${u.reason}`);
    }

    const verifySpin = spinner("Running unified structural validation...");
    verifySpin.start();
    const verifyStart = Date.now();

    let unifiedResult: UnifiedValidationResult;
    try {
      unifiedResult = await runUnifiedValidation({
        changes,
        generatedFiles,
        projectRoot,
        proposedSchemaSource,
      });
    } catch (err) {
      verifySpin.fail("Structural verification crashed");
      throw fail(`Structural validation crashed: ${err instanceof Error ? err.message : err}`);
    }

    const verifyElapsed = Date.now() - verifyStart;
    if (unifiedResult.overallPassed) {
      verifySpin.succeed(`Structural verification passed ${info(fmtElapsed(verifyElapsed))}`);
    } else {
      verifySpin.fail(`Structural verification failed ${info(fmtElapsed(verifyElapsed))}`);
    }
    reportValidation(unifiedResult);

    // ── 7b. One retry for files the first pass missed ───────────────
    if (!unifiedResult.overallPassed && unifiedResult.localCheck.missed > 0) {
      print();
      print(`  ${warn("!")} Attempting one retry to fix ${unifiedResult.localCheck.missed} missed file(s)...`);
      const retrySpin = spinner("Re-generating for missed files...");
      retrySpin.start();
      const retryStart = Date.now();

      const missedPaths = unifiedResult.localCheck.report.missed.map((m) => m.filePath);
      const schemaChange = describeBreakingChanges(changes);
      const oldFields = [...new Set(changes.flatMap((c) => c.breakingFieldNames))];
      const referenceMode = changes.some((c) => c.referenceMode === "model") ? "model" : "field";
      const retryActions: EditPlan = [];
      const retryNotes: string[] = [];

      // Retry each missed file individually rather than re-running the whole
      // plan. The file is already known, so the model is asked one narrow
      // question with the file in front of it, and the answer is checked before
      // it is accepted.
      for (const filePath of missedPaths) {
        const abs = path.resolve(projectRoot, filePath);
        if (!fs.existsSync(abs)) continue;
        try {
          const outcome = await regenerateAffectedFile({
            filePath,
            currentContent: fs.readFileSync(abs, "utf-8"),
            schemaChange,
            oldFields,
            referenceMode,
            context: context + "\n" + promptInjection,
          });
          if (outcome.edit) {
            retryActions.push(outcome.edit);
            retryNotes.push(`    ${sym.ok} ${filePath} ${info(`(${outcome.strategy})`)}`);
          } else {
            retryNotes.push(`    ${warn("!")} ${filePath} — ${outcome.reason}`);
          }
        } catch (err) {
          retryNotes.push(
            `    ${warn("!")} ${filePath} — ${err instanceof Error ? err.message : err}`
          );
        }
      }

      // Stop the spinner before printing: ora redraws its own line, so anything
      // printed while it is live can be overwritten — which silently ate the
      // one note that mattered.
      retrySpin.stop();
      for (const note of retryNotes) print(note);

      if (retryActions.length === 0) {
        retrySpin.fail("Retry produced no usable edits");
        print();
        throw fail(
          `Verification failed: retry produced no edits for ${unifiedResult.localCheck.missed} missed file(s)`
        );
      }

      // Merge: first-pass actions minus the file edits for missed paths, plus
      // everything the retry produced. Then re-verify the union.
      const merged: EditPlan = actions.filter((a) => {
        if (a.type !== "file") return true;
        const resolved = resolveProjectPath(a.filePath, projectRoot);
        return !resolved || !missedPaths.includes(resolved.rel);
      });
      merged.push(...retryActions);

      const retryResult = await runUnifiedValidation({
        changes,
        generatedFiles: materialize(merged, projectRoot).files,
        projectRoot,
        proposedSchemaSource,
        skipGraphCheck: true,
      });

      const retryElapsed = Date.now() - retryStart;

      if (retryResult.localCheck.missed > 0) {
        retrySpin.fail(`Retry failed ${info(fmtElapsed(retryElapsed))}`);
        printErr(`\n  ${error("✗")} Retry still missed ${retryResult.localCheck.missed} file(s):`);
        for (const m of retryResult.localCheck.report.missed) {
          printErr(`    ${sym.bullet} ${m.filePath}`);
          printErr(`      ${m.reason}`);
        }
        print();
        throw fail(
          `Verification failed after retry: ${retryResult.localCheck.missed} file(s) still not addressed`
        );
      }

      retrySpin.succeed(`Retry succeeded ${info(fmtElapsed(retryElapsed))}`);
      print(`  ${sym.ok} All ${retryResult.localCheck.addressed} blast-radius file(s) now addressed`);
      verifiedActions = merged;
      print();
    } else if (!unifiedResult.overallPassed) {
      print();
      throw fail(`Structural verification failed: ${unifiedResult.resolutionReason}`);
    }

    print();
  }

  // ── 8. Write ──────────────────────────────────────────────────────
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

  console.log(
    `    ${sym.ok} ${dryRun ? "Preview" : "Write"} complete ${info(fmtElapsed(Date.now() - writeStart))}`
  );
  print();

  // ── Handle schema failures ────────────────────────────────────────
  // Reported before anything else: a failed schema edit aborts the whole write,
  // so there is nothing on disk and nothing else worth reporting.
  if (result.schemaFailures.length > 0) {
    printErr(`\n  ${error("✗")} ${result.schemaFailures.length} schema edit(s) failed:`);
    for (const { edit, error: msg } of result.schemaFailures) {
      printErr(`    ${sym.bullet} ${edit.op} on ${edit.model}.${edit.fieldName ?? ""} — ${msg}`);
    }
    throw fail(
      `${result.schemaFailures.length} schema edit(s) failed — nothing was written`
    );
  }

  // ── Handle stale edits ────────────────────────────────────────────
  if (result.staleEdits.length > 0 && !dryRun) {
    print(section("Retrying stale edits"));
    const staleSpin = spinner("Retrying with current file content...");
    staleSpin.start();

    const failedPaths: string[] = [];
    for (const { edit } of result.staleEdits) {
      const resolved = resolveProjectPath(edit.filePath, projectRoot);
      if (!resolved || !fs.existsSync(resolved.abs)) {
        failedPaths.push(edit.filePath);
        continue;
      }

      const currentContent = fs.readFileSync(resolved.abs, "utf-8");
      const retryQuery =
        `${query}\n\nYour previous oldText for ${resolved.rel} did not match the file. ` +
        `Provide corrected, minimal oldText/newText pairs for ONLY that file.\n\n` +
        `FILE ${resolved.rel} CURRENT CONTENT:\n\`\`\`\n${clampForPrompt(currentContent)}\n\`\`\``;

      try {
        // schemaSource is passed here too: without it the retry has no view of
        // the models and readily proposes a text edit on schema.prisma, which is
        // rejected and burns the single retry this path gets.
        const retryPlan = await extractIntentWithRetry(retryQuery, context, schemaSource);
        const retryActions = await codeGen(retryPlan, retryQuery, context);
        if (!retryActions?.length) {
          failedPaths.push(resolved.rel);
          continue;
        }
        const retryResult = await handleAgentOutput(retryActions, {
          dryRun: false,
          yes: true,
          projectRoot,
        });
        if (retryResult.staleEdits.length > 0) {
          failedPaths.push(resolved.rel);
        } else {
          result.writtenPaths.push(...retryResult.writtenPaths);
          result.createdPaths.push(...retryResult.createdPaths);
        }
      } catch {
        failedPaths.push(resolved.rel);
      }
    }

    staleSpin.stop();
    if (failedPaths.length > 0) {
      printErr(`\n  ${error("✗")} Stale edit retry failed for ${failedPaths.length} file(s):`);
      for (const p of failedPaths) printErr(`    ${sym.bullet} ${p}`);
      throw new StepError(
        stepIndex,
        description,
        `Stale edit retry failed for ${failedPaths.length} file(s)`,
        [...opts.cumulativeResult.allWrittenPaths, ...result.writtenPaths],
        [...opts.cumulativeResult.allCreatedPaths, ...result.createdPaths]
      );
    }
    print(`  ${sym.ok} All stale edits retried successfully`);
    print();
  }

  // ── Handle create-file failures ──────────────────────────────────
  if (result.createFailures.length > 0) {
    printErr(`\n  ${error("✗")} ${result.createFailures.length} create-file operation(s) failed:`);
    for (const { edit, error: msg } of result.createFailures) {
      printErr(`    ${sym.bullet} ${edit.filePath} — ${msg}`);
    }
    throw new StepError(
      stepIndex,
      description,
      `${result.createFailures.length} create-file operation(s) failed`,
      [...opts.cumulativeResult.allWrittenPaths, ...result.writtenPaths],
      [...opts.cumulativeResult.allCreatedPaths, ...result.createdPaths]
    );
  }

  if (dryRun) return noChange();

  // ── 9. Reingest ───────────────────────────────────────────────────
  const allPaths = [...new Set([...result.writtenPaths, ...result.createdPaths])];
  if (allPaths.length > 0) {
    print(section("Graph Index"));
    const idxSpin = spinner("Updating graph index...");
    idxSpin.start();
    const idxStart = Date.now();
    for (const absPath of allPaths) {
      try {
        await reingestFile(absPath, projectRoot);
      } catch (err) {
        printErr(
          `  ${warn("!")} reingest failed for ${absPath}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
    idxSpin.succeed(`Graph index updated ${info(fmtElapsed(Date.now() - idxStart))}`);
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

// ---------------------------------------------------------------------------
// runStep helpers
// ---------------------------------------------------------------------------

function printOperations(plan: EditPlan): void {
  for (const op of plan) {
    if (op.type === "schema") {
      if (op.op === "create_model") {
        print(`      ${sym.bullet} ${bold("schema")}  ${bold("create_model")} ${op.model}`);
      } else if (op.op === "remove_model") {
        print(`      ${sym.bullet} ${bold("schema")}  ${bold("remove_model")} ${op.model}`);
      } else {
        print(`      ${sym.bullet} ${bold("schema")}  ${op.op} on ${op.model}.${op.fieldName ?? ""}`);
      }
    } else if (op.type === "file") {
      const n = op.edits.length;
      print(`      ${sym.bullet} ${bold("file")}    ${op.filePath} ${info(`(${n} edit${n > 1 ? "s" : ""})`)}`);
    } else if (op.type === "command") {
      print(`      ${sym.bullet} ${bold("cmd")}     ${op.command}`);
    } else if (op.type === "create_file") {
      print(`      ${sym.bullet} ${bold("create")}  ${op.filePath} ${info(`— ${op.reason}`)}`);
    }
  }
}

/** Project-relative paths already covered by a file operation in this plan. */
function editedPaths(plan: EditPlan, projectRoot: string): Set<string> {
  const paths = new Set<string>();
  for (const op of plan) {
    if (op.type !== "file" && op.type !== "create_file") continue;
    const resolved = resolveProjectPath(op.filePath, projectRoot);
    if (resolved) paths.add(resolved.rel);
  }
  return paths;
}

/**
 * Apply every file edit in memory, so verification judges post-edit content.
 *
 * Edits that will not apply are reported rather than dropped. Dropping them
 * silently made verification blame the model for ignoring a file when the real
 * cause was an `oldText` that never matched — two very different problems with
 * identical output.
 */
function materialize(
  plan: EditPlan,
  projectRoot: string
): { files: GeneratedFile[]; unapplied: Array<{ filePath: string; reason: string }> } {
  const files: GeneratedFile[] = [];
  const unapplied: Array<{ filePath: string; reason: string }> = [];

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
      unapplied.push({
        filePath: resolved.rel,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { files, unapplied };
}

/**
 * The schema as it will look after every schema op in the plan.
 *
 * `write: false` matters: this used to commit the change to disk during
 * verification, so the write phase then applied the same edit to an already
 * edited file — harmless for a rename, but it appends a second copy of an
 * added field.
 */
function proposeSchema(plan: EditPlan, projectRoot: string): string | undefined {
  const schemaEdits = schemaEditsOf(plan);
  if (schemaEdits.length === 0) return undefined;
  const schemaPath = findSchemaPath(projectRoot);
  if (!schemaPath) return undefined;

  let source = fs.readFileSync(schemaPath, "utf-8");
  for (const edit of schemaEdits) {
    try {
      source = applySchemaEdit(source, edit, schemaPath, projectRoot, { write: false });
    } catch {
      return undefined;
    }
  }
  return source;
}

/** Print both validation layers distinctly, as two independent checks. */
function reportValidation(result: UnifiedValidationResult): void {
  const totalAffected = result.localCheck.addressed + result.localCheck.missed;
  const localStatus = result.localCheck.missed === 0 ? success("PASSED") : error("FAILED");

  let graphLine: string;
  if (result.graphCheckSkipped) {
    graphLine = `  Graph structural check: ${info("SKIPPED")}`;
  } else {
    const graphStatus =
      result.graphCheck.staleNodesFound > 0 || result.graphCheck.missed > 0
          ? warn("PASSED (with warnings)")
          : success("PASSED");
    graphLine = `  Graph structural check: ${graphStatus} (${result.graphCheck.addressed} relations confirmed, ${result.graphCheck.staleNodesFound} stale nodes)`;
  }

  print(
    `  Local structural check: ${localStatus} (${result.localCheck.addressed}/${totalAffected} files verified)`
  );
  print(graphLine);

  if (result.localCheck.missed > 0) {
    printErr(`\n  ${error("✗")} Local check — missed files:`);
    for (const m of result.localCheck.report.missed) {
      printErr(`    ${sym.bullet} ${m.filePath}`);
      printErr(`      ${m.reason}`);
    }
  }

  if (!result.graphCheckSkipped && result.graphCheck.staleNodesFound > 0) {
    printErr(
      `\n  ${warn("!")} Graph check — stale relations in HydraDB (not blocking; disk is correct):`
    );
    for (const stale of result.graphCheck.report.staleNodesFound) {
      printErr(`    ${sym.bullet} ${stale.nodeId} — still references ${stale.staleRef}`);
    }
    printErr(`    ${info("Run 'graphyti init-graph' to resync the graph.")}`);
  }

  if (
    !result.graphCheckSkipped &&
    result.graphCheck.missed > 0 &&
    result.graphCheck.staleNodesFound === 0
  ) {
    print(
      `\n  ${warn("!")} Graph check — ${result.graphCheck.missed} relation(s) differ (likely inferred, not blocking):`
    );
    for (const miss of result.graphCheck.report.graphMissed) {
      print(`    ${sym.bullet} ${miss.nodeId}: ${miss.reason}`);
    }
  }

  print(`  ${info("Resolution")}: ${result.resolutionReason}`);
}
