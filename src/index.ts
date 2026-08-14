#!/usr/bin/env node

import { Command } from "commander";
import ContextGen, { formatLegacyContext } from "./utils/context";
import { codeGen } from "./utils/agent";
import { loadContext } from "./utils/StrAnalyzer";
import { handleAgentOutput } from "./agentPipeline";
import { runInitGraph } from "./cli/init-graph";
import { retrieveContext } from "./generate/retrieveContext";
import { preWriteCheck } from "./generate/preWriteCheck";

const program = new Command();

program
  .command("init")
  .description("Analyze and store the initial context of the Next.js project")
  .action(async () => {
    console.log("Initializing project context...");
    await ContextGen();
    console.log("Context gathering complete ✅");
  });

program
  .command("init-graph")
  .description("Extract the code graph and ingest it into HydraDB")
  .argument("[projectRoot]", "project to extract (defaults to cwd)", process.cwd())
  .action(async (projectRoot: string) => {
    await runInitGraph(projectRoot);
  });

program
  .argument('<query>', 'natural language request')
  .option('--legacy-context', 'Force the old context.json path (safety net if HydraDB is unreachable during demo)')
  .option('--dry-run', 'Show blast radius and generated code without writing any files')
  .option('--yes', 'Skip the blast-radius confirmation prompt and auto-confirm all writes')
  .action(async (query, options) => {
    console.log("proccesing your query: ", query);

    const dryRun: boolean = options.dryRun ?? false;
    const yes: boolean = options.yes ?? false;

    // -------------------------------------------------------------------------
    // 1. Retrieve context
    // -------------------------------------------------------------------------
    let context: string;
    if (options.legacyContext) {
      console.log("⚠️  --legacy-context: falling back to .dbagent/context.json");
      context = formatLegacyContext(loadContext()); // [SUPERSEDED by graph-grounded retrieval — kept as demo safety net]
    } else {
      context = (await retrieveContext(query)) ?? (() => {
        console.warn("⚠️  HydraDB retrieval returned null — falling back to .dbagent/context.json");
        return formatLegacyContext(loadContext()); // [SUPERSEDED — fallback only]
      })();
    }

    // Runtime contract guard
    if (typeof context !== "string") {
      throw new Error(
        `[context contract] expected string, got ${typeof context} — check the ${
          options.legacyContext ? "--legacy-context" : "HydraDB retrieval"
        } branch`
      );
    }

    // -------------------------------------------------------------------------
    // 2. First codeGen pass — produce an initial set of actions
    // -------------------------------------------------------------------------
    let actions = await codeGen(query, context);
    if (!actions?.length) {
      console.log("No actions generated.");
      return;
    }

    // -------------------------------------------------------------------------
    // 3. Pre-write check — blast radius analysis + optional user confirmation
    // -------------------------------------------------------------------------
    const check = await preWriteCheck(actions, yes, dryRun);

    if (!check.confirmed) {
      // User aborted at the y/n prompt
      console.log("Aborted. No files written.");
      return;
    }

    // -------------------------------------------------------------------------
    // 4. If blast radius found downstream dependents, re-run codeGen with the
    //    enriched prompt so the LLM also updates those files
    // -------------------------------------------------------------------------
    if (check.promptInjection) {
      console.log("\n🔄 Re-generating with blast-radius context injected into prompt...");
      const enrichedContext = context + "\n" + check.promptInjection;
      const enrichedActions = await codeGen(query, enrichedContext);
      if (enrichedActions?.length) {
        actions = enrichedActions;
      }
    }

    // -------------------------------------------------------------------------
    // 5. Write (or preview under --dry-run)
    // -------------------------------------------------------------------------
    await handleAgentOutput(actions, { dryRun });
    console.log("query processed");
  });

program.parse();
