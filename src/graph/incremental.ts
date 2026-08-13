import * as fs from "fs";
import * as path from "path";
import { extractForFile } from "../extract";
import { toPosix } from "../extract/types";
import {
  adjacencyFromEdges,
  deleteKnowledgeIds,
  loadGraphMap,
  nodeToAppKnowledgeItem,
  saveGraphMap,
  toGraphMapEntry,
  type GraphMap,
  type GraphMapEntry,
} from "./ingest";
import { client, COLLECTION, DATABASE, hydraErrorMessage, waitForIndexed } from "./hydraClient";
import { HydraDBError } from "@hydradb/sdk";

function entriesEqual(a: GraphMapEntry, b: GraphMapEntry): boolean {
  return (
    a.kind === b.kind &&
    a.name === b.name &&
    a.filePath === b.filePath &&
    a.edges.length === b.edges.length &&
    a.edges.every((id, i) => id === b.edges[i])
  );
}

function ownedIds(map: GraphMap, filePath: string): string[] {
  return Object.entries(map)
    .filter(([, entry]) => entry.filePath === filePath)
    .map(([id]) => id);
}

export async function reingestFile(filePath: string, projectRoot: string): Promise<void> {
  const absRoot = path.resolve(projectRoot);
  const absFile = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(absRoot, filePath);
  const rel = toPosix(path.relative(absRoot, absFile));
  if (rel.startsWith("..")) {
    throw new Error(`File is outside project root: ${filePath}`);
  }

  const map = loadGraphMap(absRoot);
  const previousOwned = new Set(ownedIds(map, rel));
  const fileMissing = !fs.existsSync(absFile);

  const extracted = fileMissing ? { nodes: [], edges: [] } : extractForFile(absRoot, absFile);
  const adj = adjacencyFromEdges(extracted.edges);
  const nextOwned = new Set(extracted.nodes.map((n) => n.id));

  const toDelete = [...previousOwned].filter((id) => !nextOwned.has(id));
  const toUpsert = extracted.nodes.filter((node) => {
    const entry = toGraphMapEntry(node, adj.get(node.id) ?? [], extracted.nodes);
    const prev = map[node.id];
    return !prev || !entriesEqual(prev, entry);
  });

  console.log(
    `[reingest] ${rel}: ${toUpsert.length} upsert, ${toDelete.length} delete, ${extracted.nodes.length} current nodes`
  );

  if (toDelete.length > 0) {
    await deleteKnowledgeIds(toDelete);
    for (const id of toDelete) delete map[id];
    for (const entry of Object.values(map)) {
      entry.edges = entry.edges.filter((target) => !toDelete.includes(target));
    }
  }

  const ingestedIds: string[] = [];
  if (toUpsert.length > 0) {
    const items = toUpsert.map((node) =>
      nodeToAppKnowledgeItem(node, adj.get(node.id) ?? [], extracted.nodes)
    );
    let envelope;
    try {
      envelope = await client.context.ingest({
        type: "knowledge",
        database: DATABASE,
        collection: COLLECTION || undefined,
        upsert: "true",
        appKnowledge: JSON.stringify(items),
      });
    } catch (err) {
      const hydraErr = err instanceof HydraDBError ? err : undefined;
      throw new Error(
        hydraErrorMessage("HydraDB context.ingest failed during reingest.", {
          errorCode: hydraErr?.statusCode != null ? String(hydraErr.statusCode) : "INGEST_FAILED",
          errorMessage: hydraErr?.message ?? (err instanceof Error ? err.message : String(err)),
          requestId: hydraErr?.rawResponse?.headers?.get("x-request-id") ?? "unknown",
        })
      );
    }
    if (envelope.error?.code || envelope.success === false) {
      throw new Error(
        hydraErrorMessage("HydraDB context.ingest returned an error during reingest.", {
          errorCode: envelope.error?.code,
          errorMessage: envelope.error?.message,
          requestId: envelope.meta?.requestId,
        })
      );
    }
    const resultIds = (envelope.data?.results ?? []).map((r) => r.id).filter((id): id is string => Boolean(id));
    ingestedIds.push(...(resultIds.length > 0 ? resultIds : items.map((i) => i.id)));
  }

  for (const node of extracted.nodes) {
    map[node.id] = toGraphMapEntry(node, adj.get(node.id) ?? [], extracted.nodes);
  }

  saveGraphMap(absRoot, map);
  if (ingestedIds.length > 0) {
    console.log(`[reingest] waiting for indexing of ${ingestedIds.length} ids`);
    await waitForIndexed(ingestedIds);
  }
  console.log(`[reingest] ${rel} done`);
}
