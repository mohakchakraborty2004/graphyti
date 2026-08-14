import * as path from "path";
import { HydraDBError } from "@hydradb/sdk";
import { loadGraphMap, type GraphMap, type GraphMapEntry } from "./ingest";
import { client, DATABASE, COLLECTION } from "./hydraClient";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface AffectedNode {
  id: string;
  name: string;
  filePath: string;
  reason: string;   // human-readable: edge kind + node names, e.g.
                    // "PostCard.tsx renders Post.title via /api/posts"
}

export interface BlastRadiusResult {
  changedNode: { id: string; name: string; kind: string; filePath: string };
  affectedRoutes: AffectedNode[];
  affectedComponents: AffectedNode[];
  affectedFiles: AffectedNode[];
}

// ---------------------------------------------------------------------------
// Reason-string helpers (edge kind → prose)
// ---------------------------------------------------------------------------

/**
 * Build a human-readable reason for why `neighborId` is affected by a change
 * to `originId`, given that `neighborEntry` was reached via an edge from
 * `originEntry`.  We reconstruct the edge direction from id prefixes because
 * the graph-map stores outgoing edges only.
 */
function buildReason(
  originId: string,
  originEntry: GraphMapEntry,
  neighborId: string,
  neighborEntry: GraphMapEntry
): string {
  const oKind = originEntry.kind;
  const nKind = neighborEntry.kind;

  // Model → Field
  if (oKind === "PrismaModel" && nKind === "ModelField") {
    return `${neighborEntry.name} is a field on model ${originEntry.name}`;
  }
  // Field → Model (relation)
  if (oKind === "ModelField" && nKind === "PrismaModel") {
    return `${originEntry.name} has a relation to model ${neighborEntry.name}`;
  }
  // Route → Model / Field
  if (oKind === "ApiRoute" && nKind === "PrismaModel") {
    return `${originEntry.name} queries model ${neighborEntry.name}`;
  }
  if (oKind === "ApiRoute" && nKind === "ModelField") {
    return `route ${originEntry.name} uses field ${neighborEntry.name}`;
  }
  // Component → Route / Field
  if (oKind === "Component" && nKind === "ApiRoute") {
    return `${originEntry.name} fetches data via ${neighborEntry.name}`;
  }
  if (oKind === "Component" && nKind === "ModelField") {
    return `${originEntry.name} renders field ${neighborEntry.name}`;
  }
  // Anything → anything (reverse walk — a route/component has originId as a neighbor)
  if (nKind === "ApiRoute") {
    return `${neighborEntry.name} uses ${originEntry.name}`;
  }
  if (nKind === "Component") {
    return `${neighborEntry.name} depends on ${originEntry.name}`;
  }
  // File imports
  if (nKind === "File") {
    return `${neighborEntry.name} imports from ${originEntry.name}`;
  }
  return `${neighborEntry.name} is connected to ${originEntry.name}`;
}

/**
 * Build a richer reason for a node reached via a multi-hop path.
 * pathIds is [changedNodeId, hop1, hop2, ..., nodeId].
 */
function buildChainReason(pathIds: string[], map: GraphMap): string {
  const names = pathIds
    .map((id) => map[id]?.name ?? id)
    .filter(Boolean);
  if (names.length <= 1) return `directly affected`;
  if (names.length === 2) return buildReason(pathIds[0], map[pathIds[0]], pathIds[1], map[pathIds[1]]);
  // Multi-hop: "A → B → C"
  return names.join(" → ");
}

// ---------------------------------------------------------------------------
// BFS over the local graph-map (primary path, no network)
// ---------------------------------------------------------------------------

const MAX_HOPS = 3;

/**
 * BFS outward from `startId` through the graph-map adjacency, up to MAX_HOPS
 * deep.  Returns every reachable node id → the path taken to reach it (so we
 * can build a reason string).
 *
 * The graph-map stores outgoing edges only (model → fields, route → models,
 * component → routes/fields).  To catch "what routes USE this model?" we also
 * build a reverse index so that changes to a model surface upstream routes and
 * components.
 */
function bfsReachable(
  startId: string,
  map: GraphMap
): Map<string, string[]> {
  // Build reverse adjacency: target → [sources that point to it]
  const reverse = new Map<string, string[]>();
  for (const [id, entry] of Object.entries(map)) {
    for (const target of entry.edges) {
      if (!reverse.has(target)) reverse.set(target, []);
      reverse.get(target)!.push(id);
    }
  }

  const visited = new Map<string, string[]>(); // id → path from startId
  visited.set(startId, [startId]);

  const queue: Array<{ id: string; path: string[]; hops: number }> = [
    { id: startId, path: [startId], hops: 0 },
  ];

  while (queue.length > 0) {
    const { id, path, hops } = queue.shift()!;
    if (hops >= MAX_HOPS) continue;

    const entry = map[id];
    if (!entry) continue;

    // Forward edges (e.g. model → fields, component → routes)
    const forward = entry.edges ?? [];
    // Reverse edges (e.g. routes that point at this model, components that point at this route)
    const backward = reverse.get(id) ?? [];

    for (const neighborId of [...forward, ...backward]) {
      if (visited.has(neighborId)) continue;
      if (neighborId === startId) continue;
      const newPath = [...path, neighborId];
      visited.set(neighborId, newPath);
      queue.push({ id: neighborId, path: newPath, hops: hops + 1 });
    }
  }

  visited.delete(startId); // don't include the changed node itself
  return visited;
}

// ---------------------------------------------------------------------------
// HydraDB consistency check (non-blocking, warn-only)
// ---------------------------------------------------------------------------

async function checkHydraConsistency(
  changedNodeId: string,
  localNeighborIds: Set<string>
): Promise<void> {
  try {
    const envelope = await client.context.relations({
      database: DATABASE,
      collection: COLLECTION || undefined,
      id: changedNodeId,
      type: "knowledge",
    });

    if (!envelope.data?.relations) return;

    // Collect the set of neighbor ids HydraDB knows about for this node
    const hydraIds = new Set<string>();
    for (const triplet of envelope.data.relations) {
      if (triplet.source?.entityId) hydraIds.add(triplet.source.entityId);
      if (triplet.target?.entityId) hydraIds.add(triplet.target.entityId);
    }
    hydraIds.delete(changedNodeId); // exclude self

    // Direct neighbors only (hop-1) for the comparison
    const localDirect = new Set(
      (Object.entries(Object.fromEntries([[changedNodeId, { edges: [] as string[] }]]))[0]?.[1]?.edges ?? [])
    );
    // Actually get direct neighbors from the map — pass them in via closure below
    // (this function is called with localNeighborIds = direct neighbors of changedNodeId)

    const onlyLocal: string[] = [];
    const onlyHydra: string[] = [];

    for (const id of localNeighborIds) {
      if (!hydraIds.has(id)) onlyLocal.push(id);
    }
    for (const id of hydraIds) {
      if (!localNeighborIds.has(id)) onlyHydra.push(id);
    }

    if (onlyLocal.length === 0 && onlyHydra.length === 0) {
      console.log(
        `  ✅ [HydraDB consistency] local graph and HydraDB agree on neighbors of ${changedNodeId}`
      );
    } else {
      if (onlyLocal.length > 0) {
        console.warn(
          `  ⚠️  [HydraDB consistency] local graph has neighbors not in HydraDB for ${changedNodeId}: ${onlyLocal.join(", ")}`
        );
        console.warn(`      (run 'dbagent init-graph' to sync)`);
      }
      if (onlyHydra.length > 0) {
        console.warn(
          `  ⚠️  [HydraDB consistency] HydraDB has neighbors not in local graph for ${changedNodeId}: ${onlyHydra.join(", ")}`
        );
      }
    }
  } catch (err) {
    if (err instanceof HydraDBError) {
      const code = err.statusCode ?? "unknown";
      const reqId =
        err.rawResponse?.headers?.get("x-request-id") ??
        err.rawResponse?.headers?.get("X-Request-Id") ??
        "unknown";
      console.warn(
        `  ⚠️  [HydraDB consistency] check skipped — error_code=${code} request_id=${reqId}: ${err.message}`
      );
    } else {
      console.warn(`  ⚠️  [HydraDB consistency] check skipped — unexpected error:`, err);
    }
    // Non-blocking: primary path is the local graph, so we continue regardless.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the blast radius of a change to `changedNodeId`.
 *
 * Primary path: local BFS over .dbagent/graph-map.json (fast, no network).
 * Secondary: calls HydraDB relations() for the changed node's direct neighbors
 * and logs a consistency warning if there's a mismatch — non-blocking.
 *
 * @param changedNodeId - Graph node id, e.g. "model:Post" or "field:Post.title"
 * @param projectRoot   - Repo root (defaults to cwd)
 */
export async function computeBlastRadius(
  changedNodeId: string,
  projectRoot: string = process.cwd()
): Promise<BlastRadiusResult> {
  const map = loadGraphMap(projectRoot);

  const changedEntry = map[changedNodeId];
  if (!changedEntry) {
    // Node not in graph — return empty result, not an error
    return {
      changedNode: { id: changedNodeId, name: changedNodeId, kind: "unknown", filePath: "" },
      affectedRoutes: [],
      affectedComponents: [],
      affectedFiles: [],
    };
  }

  // -------------------------------------------------------------------------
  // 1. BFS — collect all reachable nodes and their paths
  // -------------------------------------------------------------------------
  const reachable = bfsReachable(changedNodeId, map);

  // Direct neighbors for the HydraDB consistency check
  const directNeighborIds = new Set(changedEntry.edges);

  // -------------------------------------------------------------------------
  // 2. HydraDB consistency check (fire-and-forget warn, non-blocking)
  // -------------------------------------------------------------------------
  // Don't await here — we run it in parallel with classifying results but
  // still log before returning.
  const consistencyCheck = checkHydraConsistency(changedNodeId, directNeighborIds);

  // -------------------------------------------------------------------------
  // 3. Classify reachable nodes into buckets
  // -------------------------------------------------------------------------
  const affectedRoutes: AffectedNode[] = [];
  const affectedComponents: AffectedNode[] = [];
  const affectedFiles: AffectedNode[] = [];

  for (const [nodeId, pathIds] of reachable.entries()) {
    const entry = map[nodeId];
    if (!entry) continue;
    // Don't include the changed node itself or its own kind=PrismaModel/ModelField siblings
    // (those are already captured in the changedNode; we want downstream consumers)

    const reason = buildChainReason(pathIds, map);

    const affected: AffectedNode = {
      id: nodeId,
      name: entry.name,
      filePath: entry.filePath,
      reason,
    };

    switch (entry.kind) {
      case "ApiRoute":
        affectedRoutes.push(affected);
        break;
      case "Component":
        affectedComponents.push(affected);
        break;
      case "File":
        affectedFiles.push(affected);
        break;
      // ModelField and PrismaModel siblings are intentionally omitted from the
      // output buckets — they're schema peers, not downstream consumers.
    }
  }

  // Wait for the consistency check to finish logging before we return
  await consistencyCheck;

  return {
    changedNode: {
      id: changedNodeId,
      name: changedEntry.name,
      kind: changedEntry.kind,
      filePath: changedEntry.filePath,
    },
    affectedRoutes,
    affectedComponents,
    affectedFiles,
  };
}

// ---------------------------------------------------------------------------
// CLI summary formatter (used by preWriteCheck and --dry-run)
// ---------------------------------------------------------------------------

export function formatBlastRadius(result: BlastRadiusResult): string {
  const lines: string[] = [];
  lines.push(`\n🔥 Blast radius for change to: ${result.changedNode.name} (${result.changedNode.kind})`);
  lines.push(`   ${result.changedNode.filePath}`);

  const total =
    result.affectedRoutes.length +
    result.affectedComponents.length +
    result.affectedFiles.length;

  if (total === 0) {
    lines.push("   No downstream dependents found in the graph.");
    return lines.join("\n");
  }

  if (result.affectedRoutes.length > 0) {
    lines.push("\n   Affected API routes:");
    for (const n of result.affectedRoutes) {
      lines.push(`     • ${n.name}  (${n.filePath})`);
      lines.push(`       ↳ ${n.reason}`);
    }
  }
  if (result.affectedComponents.length > 0) {
    lines.push("\n   Affected components:");
    for (const n of result.affectedComponents) {
      lines.push(`     • ${n.name}  (${n.filePath})`);
      lines.push(`       ↳ ${n.reason}`);
    }
  }
  if (result.affectedFiles.length > 0) {
    lines.push("\n   Affected files:");
    for (const n of result.affectedFiles) {
      lines.push(`     • ${n.name}  (${n.filePath})`);
      lines.push(`       ↳ ${n.reason}`);
    }
  }

  return lines.join("\n");
}

/**
 * Render the blast-radius result as a compact instruction string to inject
 * into the code-generation prompt.
 */
export function blastRadiusPromptSection(result: BlastRadiusResult): string {
  const total =
    result.affectedRoutes.length +
    result.affectedComponents.length +
    result.affectedFiles.length;
  if (total === 0) return "";

  const lines: string[] = [
    `\n== BLAST RADIUS — you MUST also update these files ==`,
    `Changing ${result.changedNode.name} affects ${total} downstream file(s).`,
    `Do NOT leave any of these inconsistent after your changes:\n`,
  ];

  for (const n of [
    ...result.affectedRoutes,
    ...result.affectedComponents,
    ...result.affectedFiles,
  ]) {
    lines.push(`  - ${n.filePath}  (${n.name})`);
    lines.push(`    reason: ${n.reason}`);
  }

  lines.push(`\nEnsure all listed files are updated to stay consistent with the schema change.`);
  return lines.join("\n");
}
