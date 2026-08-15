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

const program = new Command();

// ---------------------------------------------------------------------------
// init — FALLBACK ONLY (flat context.json). The real indexer is `init-graph`.
// ---------------------------------------------------------------------------
program
  .command("init")
  .description("FALLBACK ONLY — write the flat .dbagent/context.json snapshot (use init-graph instead)")
  .action(async () => {
    console.log("Initializing project context...");
    await ContextGen();
    console.log("Context gathering complete ✅");
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
  .option("--legacy-context", "FALLBACK ONLY — force the old flat .dbagent/context.json path instead of the graph (safety net if HydraDB is unreachable during the demo)")
  .option("--dry-run", "Show blast radius and generated code without writing any files")
  .option("--yes", "Skip the blast-radius and command confirmation prompts and auto-confirm all writes")
  .action(async (query: string, options: Record<string, boolean>) => {
    const dryRun = options.dryRun ?? false;
    const yes    = options.yes    ?? false;
    const projectRoot = process.cwd();
    const startTime = Date.now();

    console.log("Processing your query:", query);

    // -----------------------------------------------------------------------
    // 1. Retrieve context
    //
    // The graph is the only real path: retrieveContext() queries HydraDB with
    // graph_context enabled (see generate/retrieveContext.ts). The flat
    // .dbagent/context.json branches below are FALLBACK ONLY — kept solely as a
    // demo safety net for when HydraDB is unreachable. They produce a flat file
    // listing with no relations, so blast radius and verification degrade to
    // nothing useful. Do not build new features on them.
    // -----------------------------------------------------------------------
    let context: string;
    if (options.legacyContext) {
      console.log("⚠️  --legacy-context: falling back to .dbagent/context.json (no graph, no blast radius)");
      context = formatLegacyContext(loadContext()); // FALLBACK ONLY — superseded by the graph
    } else {
      context = (await retrieveContext(query)) ?? (() => {
        console.warn("⚠️  HydraDB retrieval returned null — falling back to .dbagent/context.json");
        return formatLegacyContext(loadContext()); // FALLBACK ONLY — superseded by the graph
      })();
    }

    if (typeof context !== "string") {
      throw new Error(
        `[context contract] expected string, got ${typeof context} — check the ${
          options.legacyContext ? "--legacy-context" : "HydraDB retrieval"
        } branch`
      );
    }

    // -----------------------------------------------------------------------
    // 2. First codeGen pass
    // -----------------------------------------------------------------------
    console.log("\n🤖 Generating code...");
    let actions = await codeGen(query, context);
    if (!actions?.length) {
      console.log("No actions generated.");
      return;
    }

    // -----------------------------------------------------------------------
    // 3. Pre-write check: schema diff → blast radius → confirmation
    // -----------------------------------------------------------------------
    const check: PreWriteCheckResult = await preWriteCheck(actions, yes, dryRun, projectRoot);

    if (!check.confirmed) {
      console.log("Aborted. No files written.");
      return;
    }

    // -----------------------------------------------------------------------
    // 4. Re-generate with blast-radius context if breaking changes were found
    // -----------------------------------------------------------------------
    if (check.promptInjection) {
      console.log("\n🔄 Re-generating with blast-radius context injected into prompt...");
      const enrichedContext = context + "\n" + check.promptInjection;
      const enrichedActions = await codeGen(query, enrichedContext);
      if (enrichedActions?.length) actions = enrichedActions;
    }

    // Use the breaking field names surfaced directly from the schema diff —
    // only the fields that were actually removed/renamed, nothing else.
    // This replaces the previous heuristic that scraped reason strings and
    // incorrectly included unchanged relation fields like "author".
    const anyBreaking = check.breakingFieldNamesPerModel.some((f) => f.length > 0);

    // -----------------------------------------------------------------------
    // 6. Verify blast radius addressed — up to 2 passes (1 retry)
    // -----------------------------------------------------------------------
    let verifiedActions = actions;
    let verifyReport = { addressed: [] as any[], missed: [] as any[], retryPrompt: "" };

    if (check.blastResults.length > 0 && anyBreaking && !dryRun) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        // Build the generatedFiles list from current actions
        const generatedFiles = actionsToGeneratedFiles(verifiedActions, projectRoot);

        // Verify each blast-radius model independently with its own field names.
        // Merging all field names into one list caused false positives: e.g.
        // a route that legitimately still references "author" (unchanged relation)
        // was flagged because "author" appeared in Post's breaking list.
        const allMissed: any[] = [];
        const allAddressed: any[] = [];
        const retryParts: string[] = [];

        for (let i = 0; i < check.blastResults.length; i++) {
          const fieldNames = check.breakingFieldNamesPerModel[i] ?? [];
          if (fieldNames.length === 0) continue; // no breaking changes for this model
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

        if (verifyReport.missed.length === 0) break; // all addressed — proceed

        console.log(`\n❌ Verification pass ${attempt} — missed ${verifyReport.missed.length} file(s):`);
        for (const m of verifyReport.missed) {
          console.log(`   • ${m.filePath}`);
          console.log(`     ${m.reason}`);
        }

        if (attempt === 2) {
          // Second miss — hard stop, never write partial state
          console.error(
            "\n🛑 Verification failed after retry. No files written.\n" +
            "   The following files need manual attention:"
          );
          for (const m of verifyReport.missed) {
            console.error(`   • ${m.filePath} — ${m.reason}`);
          }
          process.exit(1);
        }

        // attempt === 1: retry with missed list appended to prompt
        console.log(`\n🔄 Retry pass (attempt ${attempt + 1}/2) — re-prompting with missed files...`);
        const retryContext = context + "\n" + check.promptInjection + "\n" + verifyReport.retryPrompt;
        const retryActions = await codeGen(query, retryContext);
        if (retryActions?.length) verifiedActions = retryActions;
      }
    }

    // -----------------------------------------------------------------------
    // 7. Write to disk (or preview under --dry-run)
    // -----------------------------------------------------------------------
    const result = await handleAgentOutput(verifiedActions, { dryRun, yes });

    if (dryRun) return;

    // -----------------------------------------------------------------------
    // 8. Reingest every changed file so the graph stays current
    // -----------------------------------------------------------------------
    if (result.writtenPaths.length > 0) {
      console.log("\n🔗 Updating graph index...");
      for (const absPath of result.writtenPaths) {
        try {
          await reingestFile(absPath, projectRoot);
        } catch (err) {
          console.warn(`  ⚠️  reingest failed for ${absPath}:`, err instanceof Error ? err.message : err);
        }
      }
    }

    // -----------------------------------------------------------------------
    // 9. CLI summary — the money shot
    // -----------------------------------------------------------------------
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const blastSize =
      check.blastResults.reduce(
        (sum, r) => sum + r.affectedRoutes.length + r.affectedComponents.length + r.affectedFiles.length,
        0
      );

    console.log("\n" + "═".repeat(60));
    console.log("✅  Run complete");
    console.log("═".repeat(60));
    console.log(`  Query         : ${query}`);
    console.log(`  Files written : ${result.writtenPaths.length}`);

    if (result.writtenPaths.length > 0) {
      for (const p of result.writtenPaths) {
        console.log(`    • ${path.relative(projectRoot, p)}`);
      }
    }

    if (blastSize > 0) {
      console.log(`  Blast radius  : ${blastSize} downstream file(s) identified`);
      if (check.blastResults.length > 0) {
        const br = check.blastResults[0];
        if (br.affectedRoutes.length)     console.log(`    routes     : ${br.affectedRoutes.map((n) => n.name).join(", ")}`);
        if (br.affectedComponents.length) console.log(`    components : ${br.affectedComponents.map((n) => n.name).join(", ")}`);
        if (br.affectedFiles.length)      console.log(`    files      : ${br.affectedFiles.map((n) => n.name).join(", ")}`);
      }
    }

    if (verifyReport.addressed.length > 0 || verifyReport.missed.length === 0 && blastSize > 0) {
      console.log(`  Verification  : ✅ passed — all ${blastSize} blast-radius file(s) addressed`);
    }

    if (result.writtenPaths.length > 0) {
      console.log(`  Graph index   : updated (${result.writtenPaths.length} file(s) reingested)`);
    }

    console.log(`  Elapsed       : ${elapsed}s`);
    console.log("═".repeat(60) + "\n");
  });

program.parse();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert codeGen actions to GeneratedFile list for the verifier.
 * Only file-type actions are included.
 */
function actionsToGeneratedFiles(actions: any[], projectRoot: string): GeneratedFile[] {
  return actions
    .filter((a) => a.type === "file" && a.directory && a.fileName)
    .map((a) => ({
      path: path.resolve(projectRoot, a.directory, a.fileName),
      content: a.content,
    }));
}

// end of file
