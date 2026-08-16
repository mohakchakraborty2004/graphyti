import { extractAll } from "../extract";
import { ingestGraph } from "../graph/ingest";
import { accent, info, fmtElapsed, section, rule, bold, print } from "./theme";
import ora from "ora";

export async function runInitGraph(projectRoot: string = process.cwd()): Promise<void> {
  const totalStart = Date.now();

  print(rule());
  print(`  ${bold("graphyti")} ${info("init-graph")}`);
  print(rule());
  print();

  // ── Extract ───────────────────────────────────────────────────────────────
  print(section("Extract"));
  const extractSpin = ora({ text: `Scanning ${accent(projectRoot)}...`, color: "cyan" }).start();
  const extractStart = Date.now();
  const { nodes, edges } = extractAll(projectRoot);
  extractSpin.succeed(`Extracted ${nodes.length} nodes, ${edges.length} edges ${info(fmtElapsed(Date.now() - extractStart))}`);
  print();

  // ── Ingest ────────────────────────────────────────────────────────────────
  print(section("Ingest"));
  const ingestSpin = ora({ text: "Uploading to HydraDB...", color: "cyan" }).start();
  const ingestStart = Date.now();
  await ingestGraph(nodes, edges, projectRoot);
  ingestSpin.succeed(`Ingestion complete ${info(fmtElapsed(Date.now() - ingestStart))}`);
  print();

  // ── Summary ───────────────────────────────────────────────────────────────
  print(rule());
  print(`  ${bold("Done")} in ${accent.bold(fmtElapsed(Date.now() - totalStart))}`);
  print(rule());
}
