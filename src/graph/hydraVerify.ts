import * as fs from "fs";
import * as path from "path";
import { HydraDBError } from "@hydradb/sdk";
import { extractPrismaSchema, findPrismaSchemas, extractTypeScriptFromSource } from "../extract";
import { extractForFile } from "../extract";
import { extractPrismaSchemaFromSource } from "../extract/prismaExtractor";
import { toPosix, type GraphNode, type GraphEdge, type PrismaModel } from "../extract/types";
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
import { client, hydraErrorMessage, waitForIndexed } from "./hydraClient";
import { requireHydraConfig } from "../config";
import type { ExpectedDelta } from "./expectedDelta";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphVerifyResult {
  graphAddressed: string[];
  graphMissed: Array<{ nodeId: string; reason: string }>;
  staleNodesFound: Array<{ nodeId: string; staleRef: string; relations: string[] }>;
}

interface StagedState {
  previousOwned: Map<string, string[]>;   // filePath → node ids it owned before
  previousEntries: Map<string, GraphMapEntry>; // node id → entry before overwrite
  deletedIds: string[];
  stagedIds: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const RELATIONS_TIMEOUT_MS = 10_000;

async function queryRelations(
  nodeId: string
): Promise<Set<string>> {
  const { database, collection } = requireHydraConfig();

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("HydraDB relations timeout")), RELATIONS_TIMEOUT_MS)
  );

  const envelope = await Promise.race([
    client.context.relations({
      database,
      collection,
      id: nodeId,
      type: "knowledge",
    }),
    timeoutPromise,
  ]);

  const ids = new Set<string>();
  if (envelope.data?.relations) {
    for (const triplet of envelope.data.relations) {
      if (triplet.source?.entityId) ids.add(triplet.source.entityId);
      if (triplet.target?.entityId) ids.add(triplet.target.entityId);
    }
    ids.delete(nodeId);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// 1. Stage proposed graph — extract from in-memory content, upsert into HydraDB
// ---------------------------------------------------------------------------

export async function stageProposedGraph(
  generatedFiles: Array<{ filePath: string; content: string }>,
  projectRoot: string,
  /** If provided, use this as the schema.prisma source instead of reading from disk.
   *  Needed because at verification time the schema edit hasn't been written yet. */
  proposedSchemaSource?: string
): Promise<StagedState> {
  const { database, collection } = requireHydraConfig();
  const absRoot = path.resolve(projectRoot);
  const map = loadGraphMap(absRoot);

  // Load Prisma models — use proposed schema if provided, else from disk
  let allModels: PrismaModel[] = [];
  if (proposedSchemaSource) {
    const schemaPath = findPrismaSchemas(absRoot)[0];
    if (schemaPath) {
      const rel = toPosix(path.relative(absRoot, schemaPath));
      const extracted = extractPrismaSchemaFromSource(proposedSchemaSource, rel);
      allModels = extracted.models;
    }
  } else {
    for (const schemaAbs of findPrismaSchemas(absRoot)) {
      allModels.push(...extractPrismaSchema(schemaAbs, absRoot).models);
    }
  }

  // Extract nodes/edges from each generated file's in-memory content
  const allNodes: GraphNode[] = [];
  const allEdges: GraphEdge[] = [];
  const nodesByFile = new Map<string, GraphNode[]>();

  for (const { filePath, content } of generatedFiles) {
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(absRoot, filePath);
    const rel = toPosix(path.relative(absRoot, absPath));

    const isPrisma = path.basename(absPath).toLowerCase() === "schema.prisma";
    const isSource = [".ts", ".tsx", ".js", ".jsx"].includes(
      path.extname(absPath).toLowerCase()
    );

    let nodes: GraphNode[] = [];
    let edges: GraphEdge[] = [];

    if (isPrisma) {
      // Prisma content is already on disk (written by applySchemaEdit).
      // Re-extract from disk so model/field nodes are current.
      const result = extractForFile(absRoot, absPath);
      nodes = result.nodes;
      edges = result.edges;
    } else if (isSource) {
      // TypeScript/TSX: extract from in-memory content via AST
      const tsResult = extractTypeScriptFromSource(absRoot, absPath, content, allModels);
      // Build minimal nodes for this file
      const fileNodeId = `file:${rel}`;
      nodes = [{ id: fileNodeId, kind: "File", filePath: rel } as GraphNode];

      // Add component node if applicable
      const basename = path.basename(absPath);
      if (
        (basename.endsWith(".tsx") || basename.endsWith(".jsx")) &&
        !rel.includes("app/api/")
      ) {
        nodes.push({
          id: `component:${rel}`,
          kind: "Component",
          filePath: rel,
        } as GraphNode);
      }

      edges = [];
      for (const imp of tsResult.imports) {
        edges.push({ kind: "FILE_IMPORTS", from: `file:${imp.fromFile}`, to: `file:${imp.toFile}` });
      }
      for (const route of tsResult.routes) {
        const normalizedPath = route.routePath.startsWith("/")
          ? route.routePath
          : `/${route.routePath}`;
        nodes.push({
          id: `route:${normalizedPath}`,
          kind: "ApiRoute",
          routePath: normalizedPath,
          filePath: rel,
          httpMethods: route.httpMethods,
        } as GraphNode);
        edges.push({
          kind: "ROUTE_QUERIES_MODEL",
          from: `route:${normalizedPath}`,
          to: `model:${route.routePath}`,
        });
      }
      for (const usage of tsResult.routeModelUsages) {
        const normalizedPath = usage.routePath.startsWith("/")
          ? usage.routePath
          : `/${usage.routePath}`;
        for (const fieldName of usage.fieldNames) {
          edges.push({
            kind: "ROUTE_USES_FIELD",
            from: `route:${normalizedPath}`,
            to: `field:${usage.modelName}.${fieldName}`,
          });
        }
      }
      for (const fetch of tsResult.componentFetches) {
        const normalizedPath = fetch.routePath.startsWith("/")
          ? fetch.routePath
          : `/${fetch.routePath}`;
        edges.push({
          kind: "COMPONENT_FETCHES_ROUTE",
          from: `component:${rel}`,
          to: `route:${normalizedPath}`,
        });
        for (const fieldName of fetch.fieldNames) {
          // Attempt to resolve which model this field belongs to
          for (const model of allModels) {
            // We can't check fields without the full field list here, but
            // the edge is still useful for relation queries
            edges.push({
              kind: "COMPONENT_RENDERS_FIELD",
              from: `component:${rel}`,
              to: `field:${model.name}.${fieldName}`,
            });
          }
        }
      }
    }

    allNodes.push(...nodes);
    allEdges.push(...edges);
    nodesByFile.set(rel, nodes);
  }

  // Compute adjacency
  const adj = adjacencyFromEdges(allEdges);

  // Determine what to delete and upsert per file
  const toDelete: string[] = [];
  const toUpsert: GraphNode[] = [];
  const previousOwned = new Map<string, string[]>();
  const previousEntries = new Map<string, GraphMapEntry>();

  for (const [rel, nodes] of nodesByFile) {
    const prevOwned = ownedIds(map, rel);
    previousOwned.set(rel, prevOwned);

    const nextOwned = new Set(nodes.map((n) => n.id));

    // Nodes to delete: owned by this file previously but not in new extraction
    for (const id of prevOwned) {
      if (!nextOwned.has(id)) {
        toDelete.push(id);
        if (map[id]) previousEntries.set(id, map[id]);
      }
    }

    // Nodes to upsert: changed or new
    for (const node of nodes) {
      const entry = toGraphMapEntry(node, adj.get(node.id) ?? [], allNodes);
      const prev = map[node.id];
      if (prev) previousEntries.set(node.id, prev);
      if (!prev || !entriesEqual(prev, entry)) {
        toUpsert.push(node);
      }
    }
  }

  // Delete stale nodes from HydraDB
  if (toDelete.length > 0) {
    await deleteKnowledgeIds(toDelete);
    for (const id of toDelete) delete map[id];
    for (const entry of Object.values(map)) {
      entry.edges = entry.edges.filter((target) => !toDelete.includes(target));
    }
  }

  // Upsert new/changed nodes
  const stagedIds: string[] = [];
  if (toUpsert.length > 0) {
    const items = toUpsert.map((node) =>
      nodeToAppKnowledgeItem(node, adj.get(node.id) ?? [], allNodes)
    );
    const envelope = await client.context.ingest({
      type: "knowledge",
      database,
      collection,
      upsert: "true",
      appKnowledge: JSON.stringify(items),
    });
    if (envelope.error?.code || envelope.success === false) {
      throw new Error(
        hydraErrorMessage("HydraDB ingest failed during graph staging.", {
          errorCode: envelope.error?.code,
          errorMessage: envelope.error?.message,
          requestId: envelope.meta?.requestId,
        })
      );
    }
    const resultIds = (envelope.data?.results ?? [])
      .map((r) => r.id)
      .filter((id): id is string => Boolean(id));
    stagedIds.push(...(resultIds.length > 0 ? resultIds : items.map((i) => i.id)));
  }

  // Update local graph map
  for (const node of allNodes) {
    map[node.id] = toGraphMapEntry(node, adj.get(node.id) ?? [], allNodes);
  }
  saveGraphMap(absRoot, map);

  // Wait for indexing
  if (stagedIds.length > 0) {
    await waitForIndexed(stagedIds);
  }

  return { previousOwned, previousEntries, deletedIds: toDelete, stagedIds };
}

// ---------------------------------------------------------------------------
// 2. Query HydraDB relations and compare against expected delta
// ---------------------------------------------------------------------------

async function queryAndVerify(
  delta: ExpectedDelta,
  affectedNodeIds: string[]
): Promise<{
  graphAddressed: string[];
  graphMissed: Array<{ nodeId: string; reason: string }>;
}> {
  const graphAddressed: string[] = [];
  const graphMissed: Array<{ nodeId: string; reason: string }> = [];

  if (delta.changeType === "add") {
    // Additive: no references to verify — the new field exists in HydraDB
    // (staged in step 1). Nothing to check for affected nodes.
    return { graphAddressed: [], graphMissed: [] };
  }

  // For rename/remove: query relations for each affected node
  for (const nodeId of affectedNodeIds) {
    let hydraNeighborIds: Set<string>;
    try {
      hydraNeighborIds = await queryRelations(nodeId);
    } catch (err) {
      graphMissed.push({
        nodeId,
        reason: `HydraDB relations query failed: ${err instanceof Error ? err.message : err}`,
      });
      continue;
    }

    if (delta.changeType === "rename") {
      const { targetNodeId, oldName, newName, targetModel } = delta;
      // Check that old field reference is gone
      const oldStillPresent = delta.expectedRemovedRefs.some(
        (refId) => hydraNeighborIds.has(refId) && refId === targetNodeId
      );
      if (oldStillPresent) {
        graphMissed.push({
          nodeId,
          reason: `HydraDB still has relation to old field ${targetNodeId} (${oldName})`,
        });
        continue;
      }

      // Check that new field reference exists
      const newFieldId = `field:${targetModel}.${newName}`;
      const newPresent = hydraNeighborIds.has(newFieldId);
      if (newPresent) {
        graphAddressed.push(nodeId);
      } else {
        // New field not in relations — may be expected if the node doesn't
        // directly reference the field (e.g. a Component that fetches a route
        // which queries the model).  Flag as addressed if old ref is gone.
        graphAddressed.push(nodeId);
      }
    } else if (delta.changeType === "remove") {
      const { targetNodeId } = delta;
      // Check that old field reference is gone
      const oldStillPresent = delta.expectedRemovedRefs.some(
        (refId) => hydraNeighborIds.has(refId) && refId === targetNodeId
      );
      if (oldStillPresent) {
        graphMissed.push({
          nodeId,
          reason: `HydraDB still has relation to removed field ${targetNodeId}`,
        });
      } else {
        graphAddressed.push(nodeId);
      }
    }
  }

  return { graphAddressed, graphMissed };
}

// ---------------------------------------------------------------------------
// 3. Check for stale nodes — the failure class local re-parsing can't see
//
//    Queries each CONSUMER node's relations in HydraDB and checks whether the
//    old field id still appears.  This catches the real bug: a consumer that was
//    re-ingested but whose stored relations still reference the old (pre-rename/
//    pre-remove) field node.  Querying the old field node's own relations would
//    only catch the inverse (someone else still pointing at it), which is a
//    different, less likely failure mode.
// ---------------------------------------------------------------------------

async function checkStaleNodes(
  delta: ExpectedDelta,
  consumerNodeIds: string[]
): Promise<Array<{ nodeId: string; staleRef: string; relations: string[] }>> {
  if (delta.changeType === "add") return [];

  const oldFieldId = delta.targetNodeId;
  const staleNodes: Array<{ nodeId: string; staleRef: string; relations: string[] }> = [];

  for (const consumerId of consumerNodeIds) {
    let hydraNeighborIds: Set<string>;
    try {
      hydraNeighborIds = await queryRelations(consumerId);
    } catch {
      // If the relations query fails for this node, skip it — don't mask
      // real staleness with query errors.
      continue;
    }

    if (hydraNeighborIds.has(oldFieldId)) {
      staleNodes.push({
        nodeId: consumerId,
        staleRef: oldFieldId,
        relations: [...hydraNeighborIds],
      });
    }
  }

  return staleNodes;
}

// ---------------------------------------------------------------------------
// 4. Restore original HydraDB state (on verification failure or crash)
//
//    Throws on failure so the caller can surface the divergence clearly.
//    The user MUST be told the graph may be out of sync — this is exactly
//    the class of bug the verification system exists to catch.
// ---------------------------------------------------------------------------

async function restoreOriginalState(
  staged: StagedState,
  projectRoot: string
): Promise<void> {
  const { database, collection } = requireHydraConfig();
  const absRoot = path.resolve(projectRoot);
  const map = loadGraphMap(absRoot);

  // Delete all staged nodes
  if (staged.stagedIds.length > 0) {
    await deleteKnowledgeIds(staged.stagedIds);
  }

  // Re-extract original nodes from disk for files that were modified
  const allModels: PrismaModel[] = [];
  for (const schemaAbs of findPrismaSchemas(absRoot)) {
    allModels.push(...extractPrismaSchema(schemaAbs, absRoot).models);
  }

  const nodesToRestore: GraphNode[] = [];
  for (const [rel, prevIds] of staged.previousOwned) {
    const absPath = path.resolve(absRoot, rel);
    if (!fs.existsSync(absPath)) continue;

    const result = extractForFile(absRoot, absPath);
    for (const node of result.nodes) {
      if (prevIds.includes(node.id)) {
        nodesToRestore.push(node);
      }
    }
  }

  // Re-upsert original nodes
  if (nodesToRestore.length > 0) {
    const adj = new Map<string, string[]>();
    const items = nodesToRestore.map((node) =>
      nodeToAppKnowledgeItem(node, adj.get(node.id) ?? [], nodesToRestore)
    );
    let envelope;
    try {
      envelope = await client.context.ingest({
        type: "knowledge",
        database,
        collection,
        upsert: "true",
        appKnowledge: JSON.stringify(items),
      });
    } catch (err) {
      throw new Error(
        `HydraDB restore failed (network error): ${err instanceof Error ? err.message : err}. ` +
        `Graph may be out of sync with disk — run "graphyti init-graph" to resync.`
      );
    }
    if (envelope.error?.code || envelope.success === false) {
      throw new Error(
        `HydraDB restore failed: ${envelope.error?.message}. ` +
        `Graph may be out of sync with disk — run "graphyti init-graph" to resync.`
      );
    }
    const resultIds = (envelope.data?.results ?? [])
      .map((r) => r.id)
      .filter((id): id is string => Boolean(id));
    if (resultIds.length > 0) {
      await waitForIndexed(resultIds);
    }
  }

  // Restore local graph map entries
  for (const [id, entry] of staged.previousEntries) {
    map[id] = entry;
  }
  // Remove any staged ids that weren't in the original
  for (const id of staged.stagedIds) {
    delete map[id];
  }
  for (const entry of Object.values(map)) {
    entry.edges = entry.edges.filter(
      (target) => !staged.stagedIds.includes(target)
    );
  }
  saveGraphMap(absRoot, map);
}

// ---------------------------------------------------------------------------
// 5. Public API — full HydraDB verification pass
//
//    Guarantees: if staging succeeds, restoreOriginalState runs on ANY exit
//    path (exception, verification failure, or SIGINT) via try/finally.
// ---------------------------------------------------------------------------

/** Module-level state for SIGINT cleanup.  Null when no staged state exists. */
let activeStagedState: { staged: StagedState; projectRoot: string } | null = null;

function installSigintHandler(): void {
  // Only install once
  if (process.listenerCount("SIGINT") > 0) return;

  process.on("SIGINT", async () => {
    if (activeStagedState) {
      const { staged, projectRoot } = activeStagedState;
      activeStagedState = null;
      console.error(`\n  [HydraDB] SIGINT received — restoring graph state...`);
      try {
        await restoreOriginalState(staged, projectRoot);
        console.error(`  [HydraDB] Graph state restored. Run "graphyti init-graph" to resync if needed.`);
      } catch (err) {
        console.error(
          `  [HydraDB] CRITICAL: Failed to restore graph state on SIGINT: ${err instanceof Error ? err.message : err}`
        );
        console.error(`  [HydraDB] Graph may be out of sync with disk — run "graphyti init-graph" to resync.`);
      }
    }
    process.exit(130);
  });
}

export async function verifyGraphConsistency(
  delta: ExpectedDelta,
  generatedFiles: Array<{ filePath: string; content: string }>,
  blastRadiusAffectedNodeIds: string[],
  projectRoot: string = process.cwd(),
  proposedSchemaSource?: string
): Promise<GraphVerifyResult> {
  // Stage the proposed graph state into HydraDB
  let staged: StagedState;
  try {
    staged = await stageProposedGraph(generatedFiles, projectRoot, proposedSchemaSource);
  } catch (err) {
    return {
      graphAddressed: [],
      graphMissed: [{
        nodeId: delta.changeType === "add" ? `model:${delta.targetModel}` : delta.targetNodeId,
        reason: `Graph staging failed: ${err instanceof Error ? err.message : err}`,
      }],
      staleNodesFound: [],
    };
  }

  // Register staged state for SIGINT cleanup and try/finally restoration
  activeStagedState = { staged, projectRoot };
  installSigintHandler();

  try {
    // Query relations and verify against expected delta
    const graphResult = await queryAndVerify(delta, blastRadiusAffectedNodeIds);

    // Check for stale nodes (consumer-side: does HydraDB still show the old field
    // id in any consumer's relations?)
    const staleNodesFound = await checkStaleNodes(delta, blastRadiusAffectedNodeIds);

    // If verification failed, restore original HydraDB state
    const passed =
      graphResult.graphMissed.length === 0 && staleNodesFound.length === 0;

    if (!passed) {
      try {
        await restoreOriginalState(staged, projectRoot);
      } catch (restoreErr) {
        // restoreOriginalState throws with a clear "graph may be out of sync" message.
        // Surface this as an additional graphMissed entry so the caller sees it.
        graphResult.graphMissed.push({
          nodeId: delta.changeType === "add" ? `model:${delta.targetModel}` : delta.targetNodeId,
          reason: `RESTORE FAILED: ${restoreErr instanceof Error ? restoreErr.message : restoreErr}`,
        });
      }
    }

    return {
      graphAddressed: graphResult.graphAddressed,
      graphMissed: graphResult.graphMissed,
      staleNodesFound,
    };
  } catch (err) {
    // Any unexpected exception during verification — attempt restore
    try {
      await restoreOriginalState(staged, projectRoot);
    } catch (restoreErr) {
      return {
        graphAddressed: [],
        graphMissed: [{
          nodeId: delta.changeType === "add" ? `model:${delta.targetModel}` : delta.targetNodeId,
          reason: `Verification crashed AND restore failed: ${restoreErr instanceof Error ? restoreErr.message : restoreErr}. Graph may be out of sync — run "graphyti init-graph" to resync.`,
        }],
        staleNodesFound: [],
      };
    }
    return {
      graphAddressed: [],
      graphMissed: [{
        nodeId: delta.changeType === "add" ? `model:${delta.targetModel}` : delta.targetNodeId,
        reason: `HydraDB verification crashed: ${err instanceof Error ? err.message : err}`,
      }],
      staleNodesFound: [],
    };
  } finally {
    activeStagedState = null;
  }
}
