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
  /**
   * True when the staged graph had not finished indexing before we queried it.
   *
   * A stale-node finding is only trustworthy once HydraDB has re-indexed what
   * we just staged. While ids sit in its queue, "the old field is still in the
   * relations" and "the new relations have not landed yet" are indistinguishable
   * — so the caller must downgrade findings to warnings rather than block a
   * correct write on a remote queue.
   */
  indexPending: boolean;
}

interface StagedState {
  previousOwned: Map<string, string[]>;   // filePath → node ids it owned before
  previousEntries: Map<string, GraphMapEntry>; // node id → entry before overwrite
  deletedIds: string[];
  stagedIds: string[];
  /** Ids still queued in HydraDB when staging gave up waiting. */
  pendingIds: string[];
  /** When staging began, epoch ms — the reference point for relation freshness. */
  stagedAt: number;
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

/**
 * The relation endpoints HydraDB reports for a node, as comparable strings.
 *
 * HydraDB identifies each endpoint by a content-hash `entityId` plus a
 * lowercased display `name` and, for ingested documents, an `identifier`. This
 * function used to collect only the `entityId`s, so the returned set could
 * never contain a graphyti node id such as `field:User.phone` — every downstream
 * `has(...)` was false by construction and the entire graph check passed
 * unconditionally. Collect the names and identifiers, lowercased, and the
 * comparison becomes real.
 */
interface RelationRefs {
  /** Every endpoint name/identifier, lowercased. */
  names: Set<string>;
  /** Newest relation timestamp per endpoint name, epoch ms; 0 when unknown. */
  seenAt: Map<string, number>;
}

async function queryRelationRefs(nodeId: string): Promise<RelationRefs> {
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

  const names = new Set<string>();
  const seenAt = new Map<string, number>();

  if (envelope.data?.relations) {
    for (const triplet of envelope.data.relations) {
      const stamps = (triplet.relations ?? [])
        .map((r) => (r.timestamp ? Date.parse(r.timestamp) : NaN))
        .filter((n) => Number.isFinite(n));
      const newest = stamps.length > 0 ? Math.max(...stamps) : 0;

      for (const side of [triplet.source, triplet.target]) {
        if (!side) continue;
        for (const label of [side.name, side.identifier]) {
          if (!label) continue;
          const key = label.trim().toLowerCase();
          names.add(key);
          seenAt.set(key, Math.max(seenAt.get(key) ?? 0, newest));
        }
      }
    }
    names.delete(nodeId.trim().toLowerCase());
  }
  return { names, seenAt };
}

/**
 * Forms in which HydraDB may echo back a reference to `Model.field`.
 *
 * `strict` are graphyti-shaped ids that only appear because we ingested them —
 * a hit is hard evidence of a stale relation, safe to block on. `loose` adds
 * the bare concept name HydraDB's own extraction invents; a hit there is
 * suggestive but ambiguous (`id`, `status`, `title` are common words), so it is
 * reported as a warning and never blocks.
 */
function fieldRefForms(model: string, field: string): { strict: string[]; loose: string[] } {
  return {
    strict: [`field:${model}.${field}`.toLowerCase(), `${model}.${field}`.toLowerCase()],
    loose: [field.toLowerCase()],
  };
}

function fieldRefFormsFor(delta: ExpectedDelta): { strict: string[]; loose: string[] } {
  if (delta.changeType === "add") return { strict: [], loose: [] };
  const field = delta.targetNodeId.replace(/^field:/, "").split(".").slice(1).join(".");
  return fieldRefForms(delta.targetModel, field);
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
  // Recorded before the upsert so any relation written after this point is
  // demonstrably a re-derivation of what we staged.
  const stagedAt = Date.now();

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

  // Wait for indexing. A remote stall must not abort verification outright —
  // it downgrades the confidence of the stale-node check instead, which the
  // caller reads off `indexPending`.
  const pendingIds =
    stagedIds.length > 0
      ? await waitForIndexed(stagedIds, { throwOnTimeout: false })
      : [];

  return { previousOwned, previousEntries, deletedIds: toDelete, stagedIds, pendingIds, stagedAt };
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

  const { strict, loose } = fieldRefFormsFor(delta);
  const oldLabel = delta.changeType === "rename" ? delta.oldName : delta.targetNodeId;

  // For rename/remove: query relations for each affected node.
  for (const nodeId of affectedNodeIds) {
    let refs: RelationRefs;
    try {
      refs = await queryRelationRefs(nodeId);
    } catch (err) {
      graphMissed.push({
        nodeId,
        reason: `HydraDB relations query failed: ${err instanceof Error ? err.message : err}`,
      });
      continue;
    }

    // The old reference must be gone from this consumer's stored relations.
    // Strict hits are reported by checkStaleNodes, which blocks; here we also
    // surface the ambiguous bare-name form as a non-blocking warning.
    const hit = [...strict, ...loose].find((form) => refs.names.has(form));
    if (hit) {
      graphMissed.push({
        nodeId,
        reason: `HydraDB relations still mention "${hit}" for the ${
          delta.changeType === "rename" ? "renamed" : "removed"
        } field ${oldLabel}`,
      });
      continue;
    }

    graphAddressed.push(nodeId);
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
//
//    Findings are split: `stale` is blocking, `inconclusive` is a warning for
//    nodes where HydraDB simply has not re-derived relations yet.
// ---------------------------------------------------------------------------

interface StaleCheckResult {
  stale: Array<{ nodeId: string; staleRef: string; relations: string[] }>;
  inconclusive: Array<{ nodeId: string; reason: string }>;
}

async function checkStaleNodes(
  delta: ExpectedDelta,
  consumerNodeIds: string[],
  /** When the proposed graph was staged, epoch ms. */
  stagedAt: number
): Promise<StaleCheckResult> {
  if (delta.changeType === "add") return { stale: [], inconclusive: [] };

  const { strict } = fieldRefFormsFor(delta);
  if (strict.length === 0) return { stale: [], inconclusive: [] };

  const stale: Array<{ nodeId: string; staleRef: string; relations: string[] }> = [];
  const inconclusive: Array<{ nodeId: string; reason: string }> = [];

  for (const consumerId of consumerNodeIds) {
    let refs: RelationRefs;
    try {
      refs = await queryRelationRefs(consumerId);
    } catch {
      // If the relations query fails for this node, skip it — don't mask
      // real staleness with query errors.
      continue;
    }

    // Only the graphyti-shaped forms count. A bare concept name is the product
    // of HydraDB's own extraction and far too common a word to block a write on.
    const staleRef = strict.find((form) => refs.names.has(form));
    if (!staleRef) continue;

    // The old reference is present — but that alone does not make it stale.
    // HydraDB re-derives relations asynchronously and `indexingStatus:
    // completed` does not mean that has happened yet, so blocking on presence
    // alone fails correct writes on remote extraction lag.
    //
    // The discriminator is the timestamp on the relation carrying the old
    // field. Relations are written in per-extraction batches sharing one
    // timestamp, so:
    //   - old ref stamped BEFORE we staged  → left over from the previous
    //     extraction, not yet superseded — in flight, not stale.
    //   - old ref stamped AFTER we staged   → HydraDB re-extracted from the new
    //     content and still emitted the dead reference — genuinely stale.
    //
    // The replacement field's presence is deliberately NOT used as proof: the
    // new relation routinely lands before the old one is purged, so mid-flight
    // both are visible and treating that as stale blocks every correct rename.
    const staleSeenAt = refs.seenAt.get(staleRef) ?? 0;
    const reExtractedSinceStaging = staleSeenAt > 0 && staleSeenAt >= stagedAt - CLOCK_SKEW_MS;

    if (reExtractedSinceStaging) {
      stale.push({ nodeId: consumerId, staleRef, relations: [...refs.names] });
    } else {
      const when = staleSeenAt > 0 ? new Date(staleSeenAt).toISOString() : "unknown";
      inconclusive.push({
        nodeId: consumerId,
        reason: `HydraDB still lists ${staleRef} (relation written ${when}, before this change was staged) — its relations have not been re-derived yet, so this is lag rather than staleness`,
      });
    }
  }

  return { stale, inconclusive };
}

/**
 * Tolerance when comparing HydraDB relation timestamps against our own clock.
 *
 * The timestamps have second granularity and come from a different machine, so
 * some slack is needed — but it must stay far below the gap between extraction
 * batches. At two minutes it swallowed the very distinction it exists to draw:
 * a batch written shortly before staging read as "written after staging", and
 * every rename was reported as leaving a stale node behind.
 */
const CLOCK_SKEW_MS = 5_000;

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
      await waitForIndexed(resultIds, { throwOnTimeout: false });
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
      indexPending: false,
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
    const staleCheck = await checkStaleNodes(delta, blastRadiusAffectedNodeIds, staged.stagedAt);
    const staleNodesFound = staleCheck.stale;
    graphResult.graphMissed.push(...staleCheck.inconclusive);

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
      indexPending: staged.pendingIds.length > 0,
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
        indexPending: false,
      };
    }
    return {
      graphAddressed: [],
      graphMissed: [{
        nodeId: delta.changeType === "add" ? `model:${delta.targetModel}` : delta.targetNodeId,
        reason: `HydraDB verification crashed: ${err instanceof Error ? err.message : err}`,
      }],
      staleNodesFound: [],
      indexPending: false,
    };
  } finally {
    activeStagedState = null;
  }
}
