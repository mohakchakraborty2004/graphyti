import * as fs from "fs";
import * as path from "path";
import { HydraDBError } from "@hydradb/sdk";
import type { GraphEdge, GraphNode, NodeKind } from "../extract/types";
import { client, COLLECTION, DATABASE, hydraErrorMessage, waitForIndexed } from "./hydraClient";

/** SDK `IngestContextRequest.appKnowledge` is a JSON array *string*; there is no AppKnowledge item type in the .d.ts. */
export interface AppKnowledgeItem {
  id: string;
  database: string;
  collection: string;
  title: string;
  type: "custom";
  content: { text: string };
  tenant_metadata: { node_kind: string; file_path: string };
  additional_metadata: Record<string, unknown>;
  relations: { ids: string[] };
}

export interface GraphMapEntry {
  kind: NodeKind;
  name: string;
  filePath: string;
  edges: string[];
}

export type GraphMap = Record<string, GraphMapEntry>;

export const GRAPH_MAP_RELATIVE = path.join(".dbagent", "graph-map.json");
export const INGEST_BATCH_SIZE = 200;

export function graphMapPath(projectRoot: string): string {
  return path.join(projectRoot, GRAPH_MAP_RELATIVE);
}

export function loadGraphMap(projectRoot: string): GraphMap {
  const file = graphMapPath(projectRoot);
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")) as GraphMap;
}

export function saveGraphMap(projectRoot: string, map: GraphMap): void {
  const file = graphMapPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ordered: GraphMap = {};
  for (const id of Object.keys(map).sort((a, b) => a.localeCompare(b))) {
    ordered[id] = map[id];
  }
  fs.writeFileSync(file, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
}

export function adjacencyFromEdges(edges: GraphEdge[]): Map<string, string[]> {
  const adj = new Map<string, Set<string>>();
  for (const edge of edges) {
    const set = adj.get(edge.from) ?? new Set<string>();
    set.add(edge.to);
    adj.set(edge.from, set);
  }
  return new Map(
    [...adj.entries()].map(([from, targets]) => [from, [...targets].sort((a, b) => a.localeCompare(b))])
  );
}

function modelFilePaths(nodes: GraphNode[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of nodes) {
    if (node.kind === "PrismaModel") map.set(node.name, node.filePath);
  }
  return map;
}

export function filePathOf(node: GraphNode, models: Map<string, string>): string {
  if ("filePath" in node && node.filePath) return node.filePath;
  if (node.kind === "ModelField") return models.get(node.modelName) ?? "";
  return "";
}

export function displayNameOf(node: GraphNode): string {
  switch (node.kind) {
    case "File":
      return node.filePath;
    case "PrismaModel":
      return node.name;
    case "ModelField":
      return `${node.modelName}.${node.fieldName}`;
    case "ApiRoute":
      return node.routePath;
    case "Component":
      return node.filePath;
  }
}

function additionalMetadata(node: GraphNode): Record<string, unknown> {
  switch (node.kind) {
    case "File":
      return {};
    case "PrismaModel":
      return { name: node.name };
    case "ModelField":
      return {
        modelName: node.modelName,
        fieldName: node.fieldName,
        type: node.type,
        isRelation: node.isRelation,
        isList: node.isList,
        isOptional: node.isOptional,
        ...(node.relatedModelName ? { relatedModelName: node.relatedModelName } : {}),
      };
    case "ApiRoute":
      return { routePath: node.routePath, httpMethods: node.httpMethods };
    case "Component":
      return {};
  }
}

function describeNode(node: GraphNode, targetIds: string[], byId: Map<string, GraphNode>): string {
  switch (node.kind) {
    case "File":
      return `Source file ${node.filePath}`;
    case "PrismaModel": {
      const fields = targetIds
        .map((id) => byId.get(id))
        .filter((n): n is Extract<GraphNode, { kind: "ModelField" }> => n?.kind === "ModelField")
        .map((n) => n.fieldName);
      return fields.length > 0
        ? `Prisma model ${node.name} with fields ${fields.join(", ")}`
        : `Prisma model ${node.name}`;
    }
    case "ModelField": {
      const flags = [node.isList ? "list" : null, node.isOptional ? "optional" : null].filter(Boolean).join(", ");
      const rel = node.isRelation && node.relatedModelName ? `; relation to ${node.relatedModelName}` : "";
      return `Prisma field ${node.modelName}.${node.fieldName} type ${node.type}${flags ? ` (${flags})` : ""}${rel}`;
    }
    case "ApiRoute": {
      const methods = node.httpMethods.length > 0 ? ` (${node.httpMethods.join(", ")})` : "";
      const models = targetIds
        .map((id) => byId.get(id))
        .filter((n): n is Extract<GraphNode, { kind: "PrismaModel" }> => n?.kind === "PrismaModel")
        .map((n) => n.name);
      const querying = models.length > 0 ? ` querying ${models.join(", ")} model${models.length === 1 ? "" : "s"}` : "";
      return `API route ${node.routePath}${methods}${querying}`;
    }
    case "Component":
      return `React component ${node.filePath}`;
  }
}

export function nodeToAppKnowledgeItem(
  node: GraphNode,
  targetIds: string[] = [],
  allNodes: GraphNode[] = []
): AppKnowledgeItem {
  if (!DATABASE) throw new Error("HYDRA_DB_DATABASE is not set");
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  const models = modelFilePaths(allNodes);
  const filePath = filePathOf(node, models);
  return {
    id: node.id,
    database: DATABASE,
    collection: COLLECTION,
    title: displayNameOf(node),
    type: "custom",
    content: { text: describeNode(node, targetIds, byId) },
    tenant_metadata: { node_kind: node.kind, file_path: filePath },
    additional_metadata: additionalMetadata(node),
    relations: { ids: [...targetIds].sort((a, b) => a.localeCompare(b)) },
  };
}

export function toGraphMapEntry(node: GraphNode, targetIds: string[], allNodes: GraphNode[]): GraphMapEntry {
  return {
    kind: node.kind,
    name: displayNameOf(node),
    filePath: filePathOf(node, modelFilePaths(allNodes)),
    edges: [...targetIds].sort((a, b) => a.localeCompare(b)),
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

async function ingestItems(items: AppKnowledgeItem[]): Promise<string[]> {
  const ingested: string[] = [];
  const batches = chunk(items, INGEST_BATCH_SIZE);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`[ingest] uploading batch ${i + 1}/${batches.length} (${batch.length} items)`);
    let envelope;
    try {
      envelope = await client.context.ingest({
        type: "knowledge",
        database: DATABASE,
        collection: COLLECTION || undefined,
        upsert: "true",
        appKnowledge: JSON.stringify(batch),
      });
    } catch (err) {
      const hydraErr = err instanceof HydraDBError ? err : undefined;
      throw new Error(
        hydraErrorMessage("HydraDB context.ingest failed.", {
          errorCode: hydraErr?.statusCode != null ? String(hydraErr.statusCode) : "INGEST_FAILED",
          errorMessage: hydraErr?.message ?? (err instanceof Error ? err.message : String(err)),
          requestId: hydraErr?.rawResponse?.headers?.get("x-request-id") ?? "unknown",
        })
      );
    }

    const requestId = envelope.meta?.requestId ?? "unknown";
    if (envelope.error?.code || envelope.success === false) {
      throw new Error(
        hydraErrorMessage("HydraDB context.ingest returned an error.", {
          errorCode: envelope.error?.code,
          errorMessage: envelope.error?.message,
          requestId,
        })
      );
    }

    const results = envelope.data?.results ?? [];
    for (const result of results) {
      if (result.error || result.status === "failed") {
        throw new Error(
          hydraErrorMessage("HydraDB rejected an app_knowledge item.", {
            id: result.id,
            errorCode: result.errorCode,
            errorMessage: result.error,
            requestId,
          })
        );
      }
      if (result.id) ingested.push(result.id);
    }

    if (results.length === 0) {
      ingested.push(...batch.map((item) => item.id));
    }
    console.log(
      `[ingest] batch ${i + 1} queued (successCount=${envelope.data?.successCount ?? "?"}, failedCount=${envelope.data?.failedCount ?? 0})`
    );
  }
  return ingested;
}

export async function ingestGraph(nodes: GraphNode[], edges: GraphEdge[], projectRoot: string): Promise<void> {
  if (!DATABASE) throw new Error("HYDRA_DB_DATABASE is not set");
  const adj = adjacencyFromEdges(edges);
  const items = nodes.map((node) => nodeToAppKnowledgeItem(node, adj.get(node.id) ?? [], nodes));
  console.log(`[ingest] ingesting ${items.length} nodes into ${DATABASE}/${COLLECTION || "(default)"}`);
  const ids = await ingestItems(items);
  console.log(`[ingest] waiting for indexing of ${ids.length} ids`);
  await waitForIndexed(ids);
  const map: GraphMap = {};
  for (const node of nodes) {
    map[node.id] = toGraphMapEntry(node, adj.get(node.id) ?? [], nodes);
  }
  saveGraphMap(projectRoot, map);
  console.log(`[ingest] wrote local cache ${graphMapPath(projectRoot)}`);
}

export async function deleteKnowledgeIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  console.log(`[ingest] deleting ${ids.length} ids`);
  const envelope = await client.context.delete({
    type: "knowledge",
    database: DATABASE,
    collection: COLLECTION || undefined,
    ids,
  });
  if (envelope.error?.code || envelope.success === false) {
    throw new Error(
      hydraErrorMessage("HydraDB context.delete returned an error.", {
        errorCode: envelope.error?.code,
        errorMessage: envelope.error?.message,
        requestId: envelope.meta?.requestId,
      })
    );
  }
}
