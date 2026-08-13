/** Intermediate extractor outputs and the assembled graph types. */

export interface PrismaModel {
  name: string;
  filePath: string;
}

export interface ModelField {
  modelName: string;
  fieldName: string;
  type: string;
  isRelation: boolean;
  relatedModelName?: string;
  isList: boolean;
  isOptional: boolean;
}

export interface FileImport {
  fromFile: string;
  toFile: string;
}

export interface ApiRoute {
  routePath: string;
  filePath: string;
  httpMethods: string[];
}

export interface RouteModelUsage {
  routePath: string;
  filePath: string;
  modelName: string;
  operation: string;
  fieldNames: string[];
}

export interface ComponentFetch {
  componentFile: string;
  routePath: string;
  fieldNames: string[];
}

export type NodeKind =
  | "File"
  | "PrismaModel"
  | "ModelField"
  | "ApiRoute"
  | "Component";

export type EdgeKind =
  | "MODEL_HAS_FIELD"
  | "FIELD_REFERENCES_MODEL"
  | "ROUTE_QUERIES_MODEL"
  | "ROUTE_USES_FIELD"
  | "COMPONENT_FETCHES_ROUTE"
  | "COMPONENT_RENDERS_FIELD"
  | "FILE_IMPORTS";

export type FileNode = {
  id: string;
  kind: "File";
  filePath: string;
};

export type PrismaModelNode = {
  id: string;
  kind: "PrismaModel";
  name: string;
  filePath: string;
};

export type ModelFieldNode = {
  id: string;
  kind: "ModelField";
  modelName: string;
  fieldName: string;
  type: string;
  isRelation: boolean;
  relatedModelName?: string;
  isList: boolean;
  isOptional: boolean;
};

export type ApiRouteNode = {
  id: string;
  kind: "ApiRoute";
  routePath: string;
  filePath: string;
  httpMethods: string[];
};

export type ComponentNode = {
  id: string;
  kind: "Component";
  filePath: string;
};

export type GraphNode =
  | FileNode
  | PrismaModelNode
  | ModelFieldNode
  | ApiRouteNode
  | ComponentNode;

export type GraphEdge =
  | { kind: "MODEL_HAS_FIELD"; from: string; to: string }
  | { kind: "FIELD_REFERENCES_MODEL"; from: string; to: string }
  | { kind: "ROUTE_QUERIES_MODEL"; from: string; to: string }
  | { kind: "ROUTE_USES_FIELD"; from: string; to: string }
  | { kind: "COMPONENT_FETCHES_ROUTE"; from: string; to: string }
  | { kind: "COMPONENT_RENDERS_FIELD"; from: string; to: string }
  | { kind: "FILE_IMPORTS"; from: string; to: string };

export interface ExtractResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export function modelId(name: string): string {
  return `model:${name}`;
}

export function fieldId(modelName: string, fieldName: string): string {
  return `field:${modelName}.${fieldName}`;
}

export function routeId(routePath: string): string {
  const normalized = routePath.startsWith("/") ? routePath : `/${routePath}`;
  return `route:${normalized}`;
}

export function componentId(relativePath: string): string {
  return `component:${toPosix(relativePath)}`;
}

export function fileId(relativePath: string): string {
  return `file:${toPosix(relativePath)}`;
}

export function extractWarn(message: string): void {
  console.warn(`[extract] ${message}`);
}
