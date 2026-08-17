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
import { extractIntentWithRetry, applyScopedEdits, scopedCodeGen, validateEditPlan, classifyQueryWithRetry, type EditPlan, type FileEdit, type CreateFile, type Classification, type Step } from "./generate/scopedEdit";
import { verifyBlastRadiusAddressed, type GeneratedFile } from "./verify/verifyChange";
import { reingestFile } from "./graph/incremental";
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
    let classification: Classification;
    try {
      classification = await classifyQueryWithRetry(query ?? "", context);
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
      if (op.op === "create_model") {
        print(`      ${sym.bullet} ${bold("schema")}  ${bold("create_model")} ${op.model}`);
      } else if (op.op === "remove_model") {
        print(`      ${sym.bullet} ${bold("schema")}  ${bold("remove_model")} ${op.model}`);
      } else {
        print(`      ${sym.bullet} ${bold("schema")}  ${op.op} on ${op.model}.${op.fieldName ?? ""}`);
      }
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

  // ── Post-process: inject prisma migrate + generate after schema edits ──
  const hasSchemaEdits = actions.some((a) => a.type === "schema");
  if (hasSchemaEdits) {
    // Generate a migration name from the schema changes
    const schemaOps = actions.filter((a) => a.type === "schema");
    const migrationName = schemaOps
      .map((op) => {
        if (op.type !== "schema") return "";
        const field = op.fieldName ?? op.model;
        switch (op.op) {
          case "add_field": return `add_${field}`;
          case "remove_field": return `remove_${field}`;
          case "rename_field": return `rename_${field}`;
          case "change_type": return `change_${field}`;
          case "create_model": return `create_${op.model}`;
          case "remove_model": return `drop_${op.model}`;
          default: return op.op;
        }
      })
      .join("_")
      .slice(0, 64); // Prisma migration name limit

    // Only inject if not already present
    const hasMigrate = actions.some(
      (a) => a.type === "command" && a.command.includes("prisma migrate")
    );
    const hasGenerate = actions.some(
      (a) => a.type === "command" && a.command.includes("prisma generate")
    );

    if (!hasMigrate) {
      actions.push({
        type: "command",
        command: `npx prisma migrate dev --name ${migrationName}`,
      });
    }
    if (!hasGenerate) {
      actions.push({
        type: "command",
        command: "npx prisma generate",
      });
    }
  }

  // Show what will be applied
  print(`    ${info("Actions")}:`);
  for (const action of actions) {
    if (action.type === "schema") {
      if (action.op === "create_model") {
        print(`      ${sym.bullet} ${bold("schema")}  ${bold("create_model")} ${action.model}`);
      } else if (action.op === "remove_model") {
        print(`      ${sym.bullet} ${bold("schema")}  ${bold("remove_model")} ${action.model}`);
      } else {
        print(`      ${sym.bullet} ${bold("schema")}  ${action.op} on ${action.model}.${action.fieldName ?? ""}`);
      }
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
    op.type === "schema" && (op.op === "remove_field" || op.op === "rename_field" || op.op === "change_type" || op.op === "remove_model");
  const breakingEdits = schemaEdits.filter(isBreaking);

  let blastResults: BlastRadiusResult[] = [];
  let promptInjection = "";
  let breakingFieldNamesPerModel: string[][] = [];
  const llmProcessedFiles = new Set<string>();

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

    // ── Confirmation ───────────────────────────────────────────────
    if (!dryRun && !yes) {
      const readline = await import("readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
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

  // ── 6. Verification ───────────────────────────────────────────────
  let verifiedActions = actions;
  let verifyReport = { addressed: [] as any[], missed: [] as any[], retryPrompt: "" };

  if (blastResults.length > 0 && !dryRun) {
    print(section("Verification"));

    const allAffectedPaths = [...new Set(
      blastResults.flatMap((r) => [
        ...r.affectedRoutes.map((n) => n.filePath),
        ...r.affectedComponents.map((n) => n.filePath),
        ...r.affectedFiles.map((n) => n.filePath),
      ])
    )];

    const planEditedPaths = new Set(
      actions
        .filter((a) => a.type === "file")
        .map((a) => {
          const fe = a as FileEdit;
          const abs = path.isAbsolute(fe.filePath) ? fe.filePath : path.resolve(projectRoot, fe.filePath);
          return path.relative(projectRoot, abs).replace(/\\/g, "/");
        })
    );

    for (const f of llmProcessedFiles) {
      const abs = path.isAbsolute(f) ? f : path.resolve(projectRoot, f);
      planEditedPaths.add(path.relative(projectRoot, abs).replace(/\\/g, "/"));
    }

    const allMissed: any[] = [];
    const allAddressed: any[] = [];

    for (const affectedPath of allAffectedPaths) {
      if (planEditedPaths.has(affectedPath)) {
        allAddressed.push({ filePath: affectedPath, reason: "covered by edit plan" });
      } else {
        const blastEntry = blastResults
          .flatMap((r) => [...r.affectedRoutes, ...r.affectedComponents, ...r.affectedFiles])
          .find((n) => n.filePath === affectedPath);
        allMissed.push({
          filePath: affectedPath,
          reason: blastEntry?.reason ?? "in blast radius but no edit generated",
        });
      }
    }

    verifyReport = {
      addressed: allAddressed,
      missed: allMissed,
      retryPrompt: "",
    };

    if (allMissed.length > 0) {
      printErr(`  ${error("✗")} ${allMissed.length} blast-radius file(s) not addressed:`);
      for (const m of allMissed) {
        printErr(`    ${sym.bullet} ${m.filePath}`);
        printErr(`      ${m.reason}`);
      }
      throw new StepError(
        stepIndex, description,
        `Verification failed: ${allMissed.length} blast-radius file(s) not addressed`,
        opts.cumulativeResult.allWrittenPaths,
        opts.cumulativeResult.allCreatedPaths
      );
    }

    print(`  ${sym.ok} All ${allAddressed.length} blast-radius file(s) addressed`);
    jsonResult.verification = "passed";
    print();
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
