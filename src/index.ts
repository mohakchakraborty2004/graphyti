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
import { extractIntentWithRetry, applyScopedEdits, scopedCodeGen, validateEditPlan, type EditPlan, type FileEdit } from "./generate/scopedEdit";
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

const program = new Command();

function spinner(text: string) {
  return ora({ text, color: "cyan", isEnabled: !isJsonMode() });
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
    // 2. Intent Extraction
    // =======================================================================
    print(section("Intent"));
    const intentSpin = spinner("Extracting edit intent...");
    intentSpin.start();
    const intentStart = Date.now();
    let editPlan: EditPlan;
    try {
      // Read schema.prisma if it exists so the LLM can reference exact field names
      const schemaPath = findSchemaPath(projectRoot);
      const schemaSource = schemaPath ? fs.readFileSync(schemaPath, "utf-8") : undefined;
      editPlan = await extractIntentWithRetry(query, context, schemaSource);
    } catch (err) {
      intentSpin.fail("Intent extraction failed");
      throw err;
    }
    const intentElapsed = Date.now() - intentStart;
    if (editPlan.length === 0) {
      intentSpin.info("No operations extracted.");
      return;
    }
    intentSpin.succeed(`Intent extracted ${info(fmtElapsed(intentElapsed))}`);
    print(`    ${info(`${editPlan.length} operation(s) extracted`)}`);
    print();

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
      }
    }
    print();

    // =======================================================================
    // 3. Code Generation (fill in actual code for file edits)
    // =======================================================================
    print(section("Generation"));
    const genSpin = spinner("Generating changes...");
    genSpin.start();
    const genStart = Date.now();
    let actions = await codeGen(editPlan, query, context);
    const genElapsed = Date.now() - genStart;

    if (!actions?.length) {
      genSpin.info("No actions generated.");
      return;
    }
    genSpin.succeed(`Code generated ${info(fmtElapsed(genElapsed))}`);
    print(`    ${info(`${actions.length} action(s) returned from model`)}`);
    print();

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
      }
    }
    print();

    // =======================================================================
    // 4. Blast Radius (for schema edits with breaking changes)
    // =======================================================================
    const schemaEdits = actions.filter((a) => a.type === "schema");
    const isBreaking = (op: typeof schemaEdits[number]) =>
      op.type === "schema" && (op.op === "remove_field" || op.op === "rename_field" || op.op === "change_type");
    const breakingEdits = schemaEdits.filter(isBreaking);

    let blastResults: BlastRadiusResult[] = [];
    let promptInjection = "";
    let breakingFieldNamesPerModel: string[][] = [];

    // Track files the LLM successfully reviewed (even if no edits needed)
    const llmProcessedFiles = new Set<string>();

    if (breakingEdits.length > 0) {
      print(section("Blast Radius"));
      const checkSpin = spinner("Analyzing schema changes...");
      checkSpin.start();
      const checkStart = Date.now();

      // Print breaking changes
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

      // Print additive changes
      const additiveEdits = schemaEdits.filter(
        (op) => op.type === "schema" && op.op === "add_field"
      );
      for (const op of additiveEdits) {
        if (op.type !== "schema") continue;
        print(`    ${info("+")} ${op.model}.${op.fieldName} ${info("(additive)")}`);
      }

      // Compute blast radius per breaking model
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

      // ── Confirmation ───────────────────────────────────────────────────
      if (!dryRun && !yes) {
        const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout });
        const confirmed = await new Promise<boolean>((resolve) => {
          rl.question(`${warn("!")} Proceed with write? [y/N] `, (answer: string) => {
            rl.close();
            resolve(answer.trim().toLowerCase().startsWith("y"));
          });
        });
        if (!confirmed) {
          print(`  ${warn("!")} Write aborted by user.`);
          jsonResult.exitCode = 1;
          if (jsonOut) print(JSON.stringify(jsonResult, null, 2));
          process.exit(1);
        }
      }

      // ── Re-generate for blast-radius-affected files ──────────────────
      // Collect all affected file paths from blast results
      const affectedFilePaths = [...new Set(
        blastResults.flatMap((r) => [
          ...r.affectedRoutes.map((n) => n.filePath),
          ...r.affectedComponents.map((n) => n.filePath),
          ...r.affectedFiles.map((n) => n.filePath),
        ])
      )];

      // Determine which affected files aren't already covered by FileEdit entries
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

        // Build a description of the schema operation for context
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

        // Generate edits for each uncovered file individually (more reliable than batching)
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
      // Additive-only or no schema changes
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

    // =======================================================================
    // 5. Verification — check ALL blast radius files are covered
    //
    // For every file the blast radius flagged as affected, verify that
    // the EditPlan includes a FileEdit for it. Missing = verification
    // failed, write is blocked.
    // =======================================================================
    let verifiedActions = actions;
    let verifyReport = { addressed: [] as any[], missed: [] as any[], retryPrompt: "" };

    if (blastResults.length > 0 && !dryRun) {
      print(section("Verification"));

      // Collect all affected file paths from blast results
      const allAffectedPaths = [...new Set(
        blastResults.flatMap((r) => [
          ...r.affectedRoutes.map((n) => n.filePath),
          ...r.affectedComponents.map((n) => n.filePath),
          ...r.affectedFiles.map((n) => n.filePath),
        ])
      )];

      // Build a set of file paths that have FileEdit entries in the plan
      const planEditedPaths = new Set(
        actions
          .filter((a) => a.type === "file")
          .map((a) => {
            const fe = a as FileEdit;
            const abs = path.isAbsolute(fe.filePath) ? fe.filePath : path.resolve(projectRoot, fe.filePath);
            return path.relative(projectRoot, abs).replace(/\\/g, "/");
          })
      );

      // Also mark files the LLM reviewed and determined don't need changes
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
          // Find the reason from blast results
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
        jsonResult.verification = "failed";
        printErr(
          `\n  ${error("✗")} Verification failed. No files written.\n` +
          `  Files needing manual attention:`
        );
        for (const m of allMissed) {
          printErr(`    ${sym.bullet} ${m.filePath} — ${m.reason}`);
        }
        jsonResult.exitCode = 1;
        if (jsonOut) print(JSON.stringify(jsonResult, null, 2));
        process.exit(1);
      }

      print(`  ${sym.ok} All ${allAddressed.length} blast-radius file(s) addressed`);
      jsonResult.verification = "passed";
      print();
    }

    // =======================================================================
    // 6. Write / Dry-run Preview
    // =======================================================================
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

    // ── Handle stale edits (one retry then fail) ────────────────────────
    if (result.staleEdits.length > 0 && !dryRun) {
      print(section("Retrying stale edits"));
      const retrySpin = spinner("Retrying with current file content...");
      retrySpin.start();

      const failedPaths: string[] = [];
      for (const { edit, error: editError } of result.staleEdits) {
        // Feed current file content back for one retry
        const absPath = path.isAbsolute(edit.filePath)
          ? edit.filePath
          : path.resolve(projectRoot, edit.filePath);

        if (!fs.existsSync(absPath)) {
          failedPaths.push(edit.filePath);
          continue;
        }

        const currentContent = fs.readFileSync(absPath, "utf-8");
        // Build a retry prompt that tells the LLM the current file state
        const retryQuery = `${query}\n\nFILE ${edit.filePath} CURRENT CONTENT:\n\`\`\`\n${currentContent}\n\`\`\`\n\nYour previous oldText didn't match. Provide corrected oldText/newText pairs for ONLY the changes you need to make to this file. Make the minimal change necessary.`;

        try {
          // Re-extract and re-generate for just this file
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
        printErr(`  No files were written for these operations.`);
        jsonResult.exitCode = 1;
      } else {
        print(`  ${sym.ok} All stale edits retried successfully`);
      }
      print();
    }

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
    const blastSize = blastResults.reduce(
      (sum, r) => sum + r.affectedRoutes.length + r.affectedComponents.length + r.affectedFiles.length,
      0
    );

    const blastStatus =
      blastResults.length === 0
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
