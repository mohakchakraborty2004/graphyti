import * as path from "path";
import { extractPrismaSchema, findPrismaSchemas } from "./prismaExtractor";
import { extractTypeScript, isApiRouteFile, isComponentFile, listSourceFiles } from "./tsExtractor";
import {
  componentId,
  extractWarn,
  fieldId,
  fileId,
  modelId,
  routeId,
  toPosix,
  type ExtractResult,
  type GraphEdge,
  type GraphNode,
  type ModelField,
  type PrismaModel,
} from "./types";
import type { TsExtractResult } from "./tsExtractor";

export type { ExtractResult, GraphEdge, GraphNode } from "./types";
export * from "./types";
export { extractPrismaSchema, findPrismaSchemas } from "./prismaExtractor";
export { extractTypeScript, listSourceFiles } from "./tsExtractor";

function addNode(nodes: Map<string, GraphNode>, node: GraphNode): void {
  if (!nodes.has(node.id)) nodes.set(node.id, node);
}

function addEdge(edges: Map<string, GraphEdge>, edge: GraphEdge): void {
  const key = `${edge.kind}|${edge.from}|${edge.to}`;
  if (!edges.has(key)) edges.set(key, edge);
}

function assemble(
  sourceFiles: string[],
  schemaFiles: string[],
  projectRoot: string,
  models: PrismaModel[],
  fields: ModelField[],
  tsResult: TsExtractResult
): ExtractResult {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const fieldsByModel = new Map<string, ModelField[]>();
  for (const field of fields) {
    const list = fieldsByModel.get(field.modelName) ?? [];
    list.push(field);
    fieldsByModel.set(field.modelName, list);
  }

  for (const abs of [...sourceFiles, ...schemaFiles]) {
    const filePath = toPosix(path.relative(projectRoot, abs));
    addNode(nodes, { id: fileId(filePath), kind: "File", filePath });
  }

  for (const model of models) {
    addNode(nodes, {
      id: modelId(model.name),
      kind: "PrismaModel",
      name: model.name,
      filePath: model.filePath,
    });
  }

  for (const field of fields) {
    addNode(nodes, {
      id: fieldId(field.modelName, field.fieldName),
      kind: "ModelField",
      ...field,
    });
    addEdge(edges, {
      kind: "MODEL_HAS_FIELD",
      from: modelId(field.modelName),
      to: fieldId(field.modelName, field.fieldName),
    });
    if (field.isRelation && field.relatedModelName) {
      addEdge(edges, {
        kind: "FIELD_REFERENCES_MODEL",
        from: fieldId(field.modelName, field.fieldName),
        to: modelId(field.relatedModelName),
      });
    }
  }

  for (const route of tsResult.routes) {
    addNode(nodes, {
      id: routeId(route.routePath),
      kind: "ApiRoute",
      routePath: route.routePath,
      filePath: route.filePath,
      httpMethods: route.httpMethods,
    });
  }

  for (const abs of sourceFiles) {
    const filePath = toPosix(path.relative(projectRoot, abs));
    if (isComponentFile(filePath) && !isApiRouteFile(filePath)) {
      addNode(nodes, { id: componentId(filePath), kind: "Component", filePath });
    }
  }

  for (const imp of tsResult.imports) {
    addEdge(edges, {
      kind: "FILE_IMPORTS",
      from: fileId(imp.fromFile),
      to: fileId(imp.toFile),
    });
  }

  const modelsByRoute = new Map<string, Set<string>>();
  for (const usage of tsResult.routeModelUsages) {
    addEdge(edges, {
      kind: "ROUTE_QUERIES_MODEL",
      from: routeId(usage.routePath),
      to: modelId(usage.modelName),
    });
    const set = modelsByRoute.get(usage.routePath) ?? new Set<string>();
    set.add(usage.modelName);
    modelsByRoute.set(usage.routePath, set);

    const modelFields = fieldsByModel.get(usage.modelName) ?? [];
    const known = new Set(modelFields.map((f) => f.fieldName));
    for (const fieldName of usage.fieldNames) {
      if (!known.has(fieldName)) {
        extractWarn(
          `Route ${usage.routePath} uses unknown field ${usage.modelName}.${fieldName} — skipping ROUTE_USES_FIELD`
        );
        continue;
      }
      addEdge(edges, {
        kind: "ROUTE_USES_FIELD",
        from: routeId(usage.routePath),
        to: fieldId(usage.modelName, fieldName),
      });
    }
  }

  const routePaths = new Set(tsResult.routes.map((r) => r.routePath));
  for (const fetch of tsResult.componentFetches) {
    if (!routePaths.has(fetch.routePath)) {
      extractWarn(
        `Component ${fetch.componentFile} fetches unknown route ${fetch.routePath} — skipping COMPONENT_FETCHES_ROUTE`
      );
      continue;
    }
    addEdge(edges, {
      kind: "COMPONENT_FETCHES_ROUTE",
      from: componentId(fetch.componentFile),
      to: routeId(fetch.routePath),
    });

    const candidateModels = [...(modelsByRoute.get(fetch.routePath) ?? [])];
    for (const fieldName of fetch.fieldNames) {
      const matches: Array<{ modelName: string; fieldName: string }> = [];
      for (const modelName of candidateModels) {
        const modelFields = fieldsByModel.get(modelName) ?? [];
        if (modelFields.some((f) => f.fieldName === fieldName)) {
          matches.push({ modelName, fieldName });
        }
      }
      if (matches.length === 1) {
        addEdge(edges, {
          kind: "COMPONENT_RENDERS_FIELD",
          from: componentId(fetch.componentFile),
          to: fieldId(matches[0].modelName, matches[0].fieldName),
        });
      } else if (matches.length === 0) {
        extractWarn(
          `Component ${fetch.componentFile} reads field "${fieldName}" which is not on models queried by ${fetch.routePath} — skipping`
        );
      } else {
        extractWarn(
          `Component ${fetch.componentFile} reads ambiguous field "${fieldName}" on ${fetch.routePath} — skipping`
        );
      }
    }
  }

  const nodeList = [...nodes.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const edgeList = [...edges.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
  );
  return { nodes: nodeList, edges: edgeList };
}

export function extractAll(projectRoot: string): ExtractResult {
  const absRoot = path.resolve(projectRoot);
  const schemaFiles = findPrismaSchemas(absRoot);
  const models: PrismaModel[] = [];
  const fields: ModelField[] = [];
  for (const schema of schemaFiles) {
    const extracted = extractPrismaSchema(schema, absRoot);
    models.push(...extracted.models);
    fields.push(...extracted.fields);
  }

  const sourceFiles = listSourceFiles(absRoot);
  const tsResult = extractTypeScript(absRoot, sourceFiles, models);
  return assemble(sourceFiles, schemaFiles, absRoot, models, fields, tsResult);
}
