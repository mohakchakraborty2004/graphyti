#!/usr/bin/env node

import { Command } from "commander";
import ContextGen from "./utils/context";
import { codeGen } from "./utils/agent";
import { loadContext } from "./utils/StrAnalyzer";
import { handleAgentOutput } from "./agentPipeline";
import { runInitGraph } from "./cli/init-graph";

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
  .action(async (query) => {
    console.log("proccesing your query: ",query)
    const context = loadContext()
    const array = await codeGen(query,context );
    await handleAgentOutput(array!)
    console.log("query processed");
  })
  
program.parse();
