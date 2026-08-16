#!/usr/bin/env node

import * as path from "path";
import { Command } from "commander";
import ContextGen, { formatLegacyContext } from "./utils/context";
import { codeGen } from "./utils/agent";
import { loadContext } from "./utils/StrAnalyzer";
import { handleAgentOutput } from "./agentPipeline";
import { runInitGraph } from "./cli/init-graph";
import { retrieveContext } from "./generate/retrieveContext";
import { preWriteCheck } from "./generate/preWriteCheck";
import { verifyBlastRadiusAddressed, type GeneratedFile } from "./verify/verifyChange";
import { reingestFile } from "./graph/incremental";
import type { BlastRadiusResult } from "./graph/blastRadius";
import type { PreWriteCheckResult } from "./generate/preWriteCheck";
import {
  accent, success, error, warn, info, sym, bold,
  fmtElapsed, rule, section, summaryBox, row,
  setJsonMode, isJsonMode, print, printErr,
} from "./cli/theme";
import ora from "ora";

const program = new Command();

/** Build an ora spinner — disabled when --json is active. */
function spinner(text: string) {
  return ora({ text, color: "cyan", isEnabled: !isJsonMode() });
}

// ---------------------------------------------------------------------------
// init — FALLBACK ONLY (flat context.json). The real indexer is `init-graph`.
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

    // ── Collect data for --json ────────────────────────────────────────────
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

    // Show a preview of the context (first ~15 lines)
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
    // 2. Code Generation
    // =======================================================================
    print(section("Generation"));
    const genSpin = spinner("Generating changes...");
    genSpin.start();
    const genStart = Date.now();
    let actions = await codeGen(query, context);
    const genElapsed = Date.now() - genStart;

    if (!actions?.length) {
      genSpin.info("No actions generated.");
      return;
    }
    genSpin.succeed(`Code generated ${info(fmtElapsed(genElapsed))}`);
    print(`    ${info(`${actions.length} action(s) returned from model`)}`);
    print();

    // Show what the model will produce
    print(`    ${info("Actions")}:`);
    for (const action of actions) {
      if (action.type === "file") {
        const relPath = path.join(action.directory, action.fileName);
        const lineCount = (action.content || "").split("\n").length;
        print(`      ${sym.bullet} ${bold("file")}  ${relPath} ${info(`(${lineCount} lines)`)}`);
      } else if (action.type === "command") {
        print(`      ${sym.bullet} ${bold("cmd")}   ${action.command}`);
      }
    }
    print();

    // =======================================================================
    // 3. Pre-write Check (schema diff → blast radius → confirmation)
    // =======================================================================
    print(section("Blast Radius"));
    const checkSpin = spinner("Analyzing schema changes...");
    checkSpin.start();
    const checkStart = Date.now();
    const check: PreWriteCheckResult = await preWriteCheck(actions, yes, dryRun, projectRoot, () => checkSpin.stop());
    const checkElapsed = Date.now() - checkStart;

    if (check.blastResults.length > 0) {
      const blastSize = check.blastResults.reduce(
        (sum, r) => sum + r.affectedRoutes.length + r.affectedComponents.length + r.affectedFiles.length,
        0
      );
      jsonResult.blastRadiusSize = blastSize;
      checkSpin.succeed(`Blast radius computed ${info(fmtElapsed(checkElapsed))}`);
    } else {
      checkSpin.succeed(`No schema changes detected ${info(fmtElapsed(checkElapsed))}`);
    }
    print();

    if (!check.confirmed) {
      print(`${info("›")} Aborted. No files written.`);
      return;
    }

    // =======================================================================
    // 4. Re-generate with blast-radius context (if breaking changes found)
    // =======================================================================
    const anyBreaking = check.breakingFieldNamesPerModel.some((f) => f.length > 0);
    if (check.promptInjection) {
      print(section("Re-generation"));
      const reSpin = spinner("Re-generating with blast-radius context...");
      reSpin.start();
      const enrichedContext = context + "\n" + check.promptInjection;
      const enrichedActions = await codeGen(query, enrichedContext);
      if (enrichedActions?.length) actions = enrichedActions;
      reSpin.succeed("Re-generation complete");
      print();
    }

    // =======================================================================
    // 5. Verification — up to 2 passes (1 retry)
    // =======================================================================
    let verifiedActions = actions;
    let verifyReport = { addressed: [] as any[], missed: [] as any[], retryPrompt: "" };

    if (check.blastResults.length > 0 && anyBreaking && !dryRun) {
      print(section("Verification"));
      for (let attempt = 1; attempt <= 2; attempt++) {
        const generatedFiles = actionsToGeneratedFiles(verifiedActions, projectRoot);

        const allMissed: any[] = [];
        const allAddressed: any[] = [];
        const retryParts: string[] = [];

        for (let i = 0; i < check.blastResults.length; i++) {
          const fieldNames = check.breakingFieldNamesPerModel[i] ?? [];
          if (fieldNames.length === 0) continue;
          const r = verifyBlastRadiusAddressed(
            check.blastResults[i],
            fieldNames,
            generatedFiles,
            projectRoot
          );
          allAddressed.push(...r.addressed);
          allMissed.push(...r.missed);
          if (r.retryPrompt) retryParts.push(r.retryPrompt);
        }

        verifyReport = {
          addressed: allAddressed,
          missed: allMissed,
          retryPrompt: retryParts.join("\n"),
        };

        if (verifyReport.missed.length === 0) {
          print(`  ${sym.ok} All ${allAddressed.length} file(s) addressed`);
          jsonResult.verification = "passed";
          break;
        }

        printErr(`  ${error("✗")} Pass ${attempt} — missed ${verifyReport.missed.length} file(s):`);
        for (const m of verifyReport.missed) {
          printErr(`    ${sym.bullet} ${m.filePath}`);
          printErr(`      ${m.reason}`);
        }
        jsonResult.verification = "failed";

        if (attempt === 2) {
          printErr(
            `\n  ${error("✗")} Verification failed after retry. No files written.\n` +
            `  Files needing manual attention:`
          );
          for (const m of verifyReport.missed) {
            printErr(`    ${sym.bullet} ${m.filePath} — ${m.reason}`);
          }
          jsonResult.exitCode = 1;
          process.exit(1);
        }

        print(`  ${warn("!")} Retry (attempt ${attempt + 1}/2) — re-prompting with missed files...`);
        const retryContext = context + "\n" + check.promptInjection + "\n" + verifyReport.retryPrompt;
        const retryActions = await codeGen(query, retryContext);
        if (retryActions?.length) verifiedActions = retryActions;
      }
      print();
    }

    // =======================================================================
    // 6. Write / Dry-run Preview
    //
    // IMPORTANT: The Execution spinner MUST be stopped before handleAgentOutput
    // because that function calls spawnSync with stdio:"inherit" for commands.
    // ora's repaint timer conflicts with the child process's terminal I/O and
    // causes the process to hang. We pass onBeforeCommand so each command also
    // pauses the spinner right before spawnSync.
    // =======================================================================
    print(section(dryRun ? "Preview" : "Execution"));
    const writeSpin = spinner(dryRun ? "Previewing changes..." : "Writing files...");
    writeSpin.start();
    const writeStart = Date.now();

    // Stop the spinner before handleAgentOutput — it runs commands with
    // stdio:"inherit" which conflicts with ora's terminal repaint.
    writeSpin.stop();

    const result = await handleAgentOutput(verifiedActions, {
      dryRun,
      yes,
      onBeforeCommand: () => {
        // Already stopped above, but guard in case future code restarts it
        writeSpin.stop();
      },
    });

    const writeElapsed = Date.now() - writeStart;
    console.log(`    ${sym.ok} ${dryRun ? "Preview" : "Write"} complete ${info(fmtElapsed(writeElapsed))}`);
    print();

    jsonResult.filesWritten = result.writtenPaths.map((p) => path.relative(projectRoot, p));

    if (dryRun) {
      print(rule());
      print(`  ${sym.ok} ${info("[dry-run]")} Re-run without --dry-run to apply changes.`);
      print(rule());
      jsonResult.elapsedMs = Date.now() - startTime;
      if (jsonOut) print(JSON.stringify(jsonResult, null, 2));
      return;
    }

    // =======================================================================
    // 7. Reingest — update the graph index
    // =======================================================================
    if (result.writtenPaths.length > 0) {
      print(section("Graph Index"));
      const idxSpin = spinner("Updating graph index...");
      idxSpin.start();
      const idxStart = Date.now();
      for (const absPath of result.writtenPaths) {
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

    // =======================================================================
    // 8. Summary
    // =======================================================================
    const elapsed = Date.now() - startTime;
    const blastSize =
      check.blastResults.reduce(
        (sum, r) => sum + r.affectedRoutes.length + r.affectedComponents.length + r.affectedFiles.length,
        0
      );

    const blastStatus =
      check.blastResults.length === 0
        ? `${info("—")} no schema changes`
        : blastSize === 0
          ? `${info("—")} 0 downstream files`
          : `${blastSize} downstream file(s)`;

    const verifyStatus =
      verifyReport.missed.length === 0 && blastSize > 0
        ? `${success("✓")} passed`
        : blastSize === 0
          ? `${info("—")} no blast radius`
          : `${error("✗")} failed`;

    const graphStatus = result.writtenPaths.length > 0
      ? `${success("✓")} updated (${result.writtenPaths.length} file(s))`
      : `${info("—")} no changes`;

    print(summaryBox([
      ["Files written",   `${result.writtenPaths.length}`],
      ["Blast radius",    blastStatus],
      ["Verification",    verifyStatus],
      ["Graph index",     graphStatus],
      ["Elapsed",         accent.bold(fmtElapsed(elapsed))],
    ]));

    jsonResult.elapsedMs = elapsed;
    if (jsonOut) print(JSON.stringify(jsonResult, null, 2));
  });

program.parse();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function actionsToGeneratedFiles(actions: any[], projectRoot: string): GeneratedFile[] {
  return actions
    .filter((a) => a.type === "file" && a.directory && a.fileName)
    .map((a) => ({
      path: path.resolve(projectRoot, a.directory, a.fileName),
      content: a.content,
    }));
}
