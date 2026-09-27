import { extractAll } from "../extract";
import { ingestGraph } from "../graph/ingest";
import { accent, info, fmtElapsed, section, rule, bold, print } from "./theme";
import { configureLogger, logError, logInfo } from "../utils/logger";
import ora from "ora";

export async function runInitGraph(projectRoot: string = process.cwd()): Promise<void> {
  const totalStart = Date.now();
  configureLogger({ projectRoot });
  logInfo("graph.init.start", { projectRoot });

  print(rule());
  print(`  ${bold("graphyti")} ${info("init-graph")}`);
  print(rule());
  print();

  // ── Extract ───────────────────────────────────────────────────────────────
  print(section("Extract"));
  const extractSpin = ora({ text: `Scanning ${accent(projectRoot)}...`, color: "cyan" }).start();
  const extractStart = Date.now();
  const { nodes, edges } = extractAll(projectRoot);
  const extractElapsed = Date.now() - extractStart;
  extractSpin.succeed(`Extracted ${nodes.length} nodes, ${edges.length} edges ${info(fmtElapsed(extractElapsed))}`);
  logInfo("graph.extracted", {
    nodes: nodes.length,
    edges: edges.length,
    elapsedMs: extractElapsed,
  });
  print();

  // ── Ingest ────────────────────────────────────────────────────────────────
  print(section("Ingest"));
  const ingestSpin = ora({ text: "Uploading to HydraDB...", color: "cyan" }).start();
  const ingestStart = Date.now();
  try {
    await ingestGraph(nodes, edges, projectRoot);
  } catch (err) {
    logError("graph.init.failed", {
      nodes: nodes.length,
      elapsedMs: Date.now() - totalStart,
      error: err,
    });
    throw err;
  }
  const ingestElapsed = Date.now() - ingestStart;
  ingestSpin.succeed(`Ingestion complete ${info(fmtElapsed(ingestElapsed))}`);
  logInfo("graph.ingested", { nodes: nodes.length, elapsedMs: ingestElapsed });
  print();

  // ── Summary ───────────────────────────────────────────────────────────────
  logInfo("graph.init.end", { status: "ok", elapsedMs: Date.now() - totalStart });
  print(rule());
  print(`  ${bold("Done")} in ${accent.bold(fmtElapsed(Date.now() - totalStart))}`);
  print(rule());
}
