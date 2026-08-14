import * as path from "path";
import { extractAll } from "./index";
import type { GraphEdge, GraphNode } from "./types";

const projectRoot = path.resolve(__dirname, "../../sample-project");
const graph = extractAll(projectRoot);

function groupNodes(nodes: GraphNode[]): Map<string, GraphNode[]> {
  const grouped = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const list = grouped.get(node.kind) ?? [];
    list.push(node);
    grouped.set(node.kind, list);
  }
  return grouped;
}

function groupEdges(edges: GraphEdge[]): Map<string, GraphEdge[]> {
  const grouped = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const list = grouped.get(edge.kind) ?? [];
    list.push(edge);
    grouped.set(edge.kind, list);
  }
  return grouped;
}

console.log(`extractAll(${projectRoot})`);
console.log(`${graph.nodes.length} nodes, ${graph.edges.length} edges\n`);

console.log("=== NODES ===");
for (const [kind, nodes] of groupNodes(graph.nodes)) {
  console.log(`\n[${kind}] (${nodes.length})`);
  for (const node of nodes) {
    const rest = { ...node } as Record<string, unknown>;
    delete rest.id;
    delete rest.kind;
    console.log(`  ${node.id}  ${JSON.stringify(rest)}`);
  }
}

console.log("\n=== EDGES ===");
for (const [kind, edges] of groupEdges(graph.edges)) {
  console.log(`\n[${kind}] (${edges.length})`);
  for (const edge of edges) {
    console.log(`  ${edge.from}  ->  ${edge.to}`);
  }
}
