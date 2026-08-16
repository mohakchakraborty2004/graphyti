import * as path from "path";
import { HydraDBError } from "@hydradb/sdk";
import { loadGraphMap, type GraphMap, type GraphMapEntry } from "./ingest";
import { client } from "./hydraClient";
import { requireHydraConfig } from "../config";
import { success, warn, info, sym, accent, bold, visLen, pad } from "../cli/theme";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface AffectedNode {
  id: string;
  name: string;
  filePath: string;
  reason: string;
}

export interface BlastRadiusResult {
  changedNode: { id: string; name: string; kind: string; filePath: string };
  affectedRoutes: AffectedNode[];
  affectedComponents: AffectedNode[];
  affectedFiles: AffectedNode[];
}

// ---------------------------------------------------------------------------
// Reason-string helpers
// ---------------------------------------------------------------------------

function buildReason(
  originId: string,
  originEntry: GraphMapEntry,
  neighborId: string,
  neighborEntry: GraphMapEntry
): string {
  const oKind = originEntry.kind;
  const nKind = neighborEntry.kind;

  if (oKind === "PrismaModel" && nKind === "ModelField") {
    return `${neighborEntry.name} is a field on model ${originEntry.name}`;
  }
  if (oKind === "ModelField" && nKind === "PrismaModel") {
    return `${originEntry.name} has a relation to model ${neighborEntry.name}`;
  }
  if (oKind === "ApiRoute" && nKind === "PrismaModel") {
    return `${originEntry.name} queries model ${neighborEntry.name}`;
  }
  if (oKind === "ApiRoute" && nKind === "ModelField") {
    return `route ${originEntry.name} uses field ${neighborEntry.name}`;
  }
  if (oKind === "Component" && nKind === "ApiRoute") {
    return `${originEntry.name} fetches data via ${neighborEntry.name}`;
  }
  if (oKind === "Component" && nKind === "ModelField") {
    return `${originEntry.name} renders field ${neighborEntry.name}`;
  }
  if (nKind === "ApiRoute") {
    return `${neighborEntry.name} uses ${originEntry.name}`;
  }
  if (nKind === "Component") {
    return `${neighborEntry.name} depends on ${originEntry.name}`;
  }
  if (nKind === "File") {
    return `${neighborEntry.name} imports from ${originEntry.name}`;
  }
  return `${neighborEntry.name} is connected to ${originEntry.name}`;
}

function buildChainReason(pathIds: string[], map: GraphMap): string {
  const names = pathIds
    .map((id) => map[id]?.name ?? id)
    .filter(Boolean);
  if (names.length <= 1) return `directly affected`;
  if (names.length === 2) return buildReason(pathIds[0], map[pathIds[0]], pathIds[1], map[pathIds[1]]);
  return names.join(" → ");
}

// ---------------------------------------------------------------------------
// BFS over the local graph-map
// ---------------------------------------------------------------------------

const MAX_HOPS = 3;

function bfsReachable(
  startId: string,
  map: GraphMap
): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const [id, entry] of Object.entries(map)) {
    for (const target of entry.edges) {
      if (!reverse.has(target)) reverse.set(target, []);
      reverse.get(target)!.push(id);
    }
  }

  const visited = new Map<string, string[]>();
  visited.set(startId, [startId]);

  const queue: Array<{ id: string; path: string[]; hops: number }> = [
    { id: startId, path: [startId], hops: 0 },
  ];

  while (queue.length > 0) {
    const { id, path, hops } = queue.shift()!;
    if (hops >= MAX_HOPS) continue;

    const entry = map[id];
    if (!entry) continue;

    const forward = entry.edges ?? [];
    const backward = reverse.get(id) ?? [];

    for (const neighborId of [...forward, ...backward]) {
      if (visited.has(neighborId)) continue;
      if (neighborId === startId) continue;
      const newPath = [...path, neighborId];
      visited.set(neighborId, newPath);
      queue.push({ id: neighborId, path: newPath, hops: hops + 1 });
    }
  }

  visited.delete(startId);
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
    const { database, collection } = requireHydraConfig();

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("HydraDB relations request timed out")), 10_000)
    );

    const envelope = await Promise.race([
      client.context.relations({
        database,
        collection,
        id: changedNodeId,
        type: "knowledge",
      }),
      timeoutPromise,
    ]);

    if (!envelope.data?.relations) return;

    const hydraIds = new Set<string>();
    for (const triplet of envelope.data.relations) {
      if (triplet.source?.entityId) hydraIds.add(triplet.source.entityId);
      if (triplet.target?.entityId) hydraIds.add(triplet.target.entityId);
    }
    hydraIds.delete(changedNodeId);

    const localDirect = new Set(
      (Object.entries(Object.fromEntries([[changedNodeId, { edges: [] as string[] }]]))[0]?.[1]?.edges ?? [])
    );

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
        `  ${sym.ok} ${info("[HydraDB]")} local graph and HydraDB agree on neighbors of ${changedNodeId}`
      );
    } else {
      if (onlyLocal.length > 0) {
        console.warn(
          `  ${warn("!")} ${info("[HydraDB]")} local graph has neighbors not in HydraDB for ${changedNodeId}: ${onlyLocal.join(", ")}`
        );
        console.warn(`      (run 'dbagent init-graph' to sync)`);
      }
      if (onlyHydra.length > 0) {
        console.warn(
          `  ${warn("!")} ${info("[HydraDB]")} HydraDB has neighbors not in local graph for ${changedNodeId}: ${onlyHydra.join(", ")}`
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
        `  ${warn("!")} ${info("[HydraDB]")} check skipped — error_code=${code} request_id=${reqId}: ${err.message}`
      );
    } else {
      console.warn(`  ${warn("!")} ${info("[HydraDB]")} check skipped — unexpected error:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function computeBlastRadius(
  changedNodeId: string,
  projectRoot: string = process.cwd()
): Promise<BlastRadiusResult> {
  const map = loadGraphMap(projectRoot);

  const changedEntry = map[changedNodeId];
  if (!changedEntry) {
    return {
      changedNode: { id: changedNodeId, name: changedNodeId, kind: "unknown", filePath: "" },
      affectedRoutes: [],
      affectedComponents: [],
      affectedFiles: [],
    };
  }

  const reachable = bfsReachable(changedNodeId, map);
  const directNeighborIds = new Set(changedEntry.edges);

  const consistencyCheck = checkHydraConsistency(changedNodeId, directNeighborIds);

  const affectedRoutes: AffectedNode[] = [];
  const affectedComponents: AffectedNode[] = [];
  const affectedFiles: AffectedNode[] = [];

  for (const [nodeId, pathIds] of reachable.entries()) {
    const entry = map[nodeId];
    if (!entry) continue;

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
    }
  }

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
// CLI tree formatter — clean indented tree view
// ---------------------------------------------------------------------------

function formatNodeGroup(
  label: string,
  nodes: AffectedNode[],
  colWidth: number
): string[] {
  if (nodes.length === 0) return [];
  const lines: string[] = [];
  lines.push(`  ${bold(label)}`);
  for (const n of nodes) {
    const nameCol = pad(accent(n.name), colWidth);
    lines.push(`    ${sym.bullet} ${nameCol}  ${info(n.filePath)}`);
    lines.push(`      ${info(n.reason)}`);
  }
  return lines;
}

/**
 * Format blast-radius as a compact, scannable tree view.
 *
 * Output style:
 *   Model: Post (PrismaModel)
 *   prisma/schema.prisma
 *
 *   Routes
 *     › /api/posts     src/app/api/posts/route.ts
 *       queries model Post
 *   Components
 *     › PostCard.tsx    components/PostCard.tsx
 *       renders field Post.title
 */
export function formatBlastRadius(result: BlastRadiusResult): string {
  const lines: string[] = [];

  lines.push(
    `  ${info("Model:")} ${accent(result.changedNode.name)} ${info(`(${result.changedNode.kind})`)}`
  );
  lines.push(`  ${info(result.changedNode.filePath)}`);

  const total =
    result.affectedRoutes.length +
    result.affectedComponents.length +
    result.affectedFiles.length;

  if (total === 0) {
    lines.push(`  ${info("No downstream dependents found in the graph.")}`);
    return lines.join("\n");
  }

  // Calculate column width for aligned name column
  const allNodes = [...result.affectedRoutes, ...result.affectedComponents, ...result.affectedFiles];
  const colWidth = Math.min(28, Math.max(12, ...allNodes.map((n) => visLen(n.name))));

  lines.push(...formatNodeGroup("Routes", result.affectedRoutes, colWidth));
  lines.push(...formatNodeGroup("Components", result.affectedComponents, colWidth));
  lines.push(...formatNodeGroup("Files", result.affectedFiles, colWidth));

  return lines.join("\n");
}

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
