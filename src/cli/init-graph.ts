import { extractAll } from "../extract";
import { ingestGraph } from "../graph/ingest";

export async function runInitGraph(projectRoot: string = process.cwd()): Promise<void> {
  console.log(`[init-graph] extracting ${projectRoot}`);
  const { nodes, edges } = extractAll(projectRoot);
  console.log(`[init-graph] extracted ${nodes.length} nodes, ${edges.length} edges`);
  await ingestGraph(nodes, edges, projectRoot);
  console.log("[init-graph] complete");
}
