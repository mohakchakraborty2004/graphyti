import * as fs from "fs";
import * as path from "path";
import { HydraDBError } from "@hydradb/sdk";
import { loadGraphMap, type GraphMap, type GraphMapEntry } from "./ingest";
import { listSourceFiles } from "../extract/tsExtractor";
import { client } from "./hydraClient";
import { requireHydraConfig } from "../config";
import { referencesIdentifier, toPosix } from "../utils/paths";
import { referencesField } from "../verify/symbolRefs";
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
  /** Graph-linked AND textually confirmed. These are the enforced set. */
  affectedRoutes: AffectedNode[];
  affectedComponents: AffectedNode[];
  affectedFiles: AffectedNode[];
  /**
   * Files that mention the changed symbol but are not linked to it in the
   * graph. Surfaced to the user and to the model, never enforced by the
   * verifier — a bare word match is not evidence of a data-flow dependency,
   * and blocking on one would fail a run over an unrelated `title` in a
   * page's metadata.
   */
  advisoryFiles: AffectedNode[];
  /** Every distinct project-relative file path in the enforced set. */
  affectedFilePaths: string[];
  /** Graph-linked candidates dropped because their file never names the symbol. */
  filteredOut: Array<{ id: string; filePath: string }>;
  /** Candidates whose file is gone from disk — the graph cache is stale. */
  staleNodes: Array<{ id: string; filePath: string }>;
}

/** What is changing. `field` absent means the whole model is going away. */
export interface BlastRadiusTarget {
  model: string;
  field?: string;
}

// ---------------------------------------------------------------------------
// Edge kinds, recovered from node-id prefixes
//
// The local graph cache stores edges as a flat `string[]` of target ids, which
// drops the edge kind the extractor knew. It is recoverable without a cache
// format change because the (fromPrefix, toPrefix) pair is unique across all
// seven kinds the extractor emits — see src/extract/index.ts.
// ---------------------------------------------------------------------------

export type EdgeKind =
  | "MODEL_HAS_FIELD"
  | "FIELD_REFERENCES_MODEL"
  | "FILE_IMPORTS"
  | "ROUTE_QUERIES_MODEL"
  | "ROUTE_USES_FIELD"
  | "COMPONENT_FETCHES_ROUTE"
  | "COMPONENT_RENDERS_FIELD"
  | "UNKNOWN";

function prefixOf(id: string): string {
  const i = id.indexOf(":");
  return i === -1 ? "" : id.slice(0, i);
}

function edgeKind(from: string, to: string): EdgeKind {
  const f = prefixOf(from);
  const t = prefixOf(to);
  if (f === "model" && t === "field") return "MODEL_HAS_FIELD";
  if (f === "field" && t === "model") return "FIELD_REFERENCES_MODEL";
  if (f === "file" && t === "file") return "FILE_IMPORTS";
  if (f === "route" && t === "model") return "ROUTE_QUERIES_MODEL";
  if (f === "route" && t === "field") return "ROUTE_USES_FIELD";
  if (f === "component" && t === "route") return "COMPONENT_FETCHES_ROUTE";
  if (f === "component" && t === "field") return "COMPONENT_RENDERS_FIELD";
  return "UNKNOWN";
}

/** Reverse adjacency, bucketed by edge kind: who points AT this node, and how. */
type ReverseLookup = (kind: EdgeKind, target: string) => string[];

function buildReverseIndex(map: GraphMap): ReverseLookup {
  const index = new Map<string, string[]>();
  for (const [from, entry] of Object.entries(map)) {
    for (const to of entry.edges ?? []) {
      const key = `${edgeKind(from, to)}|${to}`;
      const list = index.get(key);
      if (list) list.push(from);
      else index.set(key, [from]);
    }
  }
  return (kind, target) => index.get(`${kind}|${target}`) ?? [];
}

// ---------------------------------------------------------------------------
// Candidate collection — semantic, directed, and bounded by structure
//
// The previous implementation ran an undirected 3-hop BFS from the model node.
// That escaped through unrelated relation fields: renaming `User.phone` reached
// `/api/posts` via `field:Post.author → model:User`, and from there reached
// every component fetching that route. Following edges in the direction that
// actually carries a dependency removes that entire class of false positive.
// ---------------------------------------------------------------------------

/** Fixpoint guard — the graph is a DAG in practice, but never trust that. */
const MAX_PROPAGATION_ROUNDS = 12;

function collectCandidates(
  target: BlastRadiusTarget,
  map: GraphMap,
  rev: ReverseLookup
): Map<string, string> {
  const candidates = new Map<string, string>();
  const add = (id: string, reason: string): boolean => {
    if (candidates.has(id) || !map[id]) return false;
    candidates.set(id, reason);
    return true;
  };

  const modelId = `model:${target.model}`;
  const fieldIds = target.field
    ? [`field:${target.model}.${target.field}`]
    : Object.keys(map).filter((id) => id.startsWith(`field:${target.model}.`));

  // 1. Nodes with an explicit edge to the changed field.
  for (const fieldId of fieldIds) {
    const label = map[fieldId]?.name ?? fieldId.replace(/^field:/, "");
    for (const id of rev("ROUTE_USES_FIELD", fieldId)) add(id, `selects ${label}`);
    for (const id of rev("COMPONENT_RENDERS_FIELD", fieldId)) add(id, `renders ${label}`);
  }

  // 2. Routes that query the model without the extractor pinning a field.
  //    A `findMany()` with no `select` returns every column, so these are real
  //    candidates — the text gate below decides whether each one is affected.
  for (const id of rev("ROUTE_QUERIES_MODEL", modelId)) {
    add(id, `queries model ${target.model}`);
  }

  // 3+4. Propagate outward: components fetching an affected route, and files
  //      importing an affected file. Both directions carry a real dependency.
  let frontier = [...candidates.keys()];
  for (let round = 0; round < MAX_PROPAGATION_ROUNDS && frontier.length > 0; round++) {
    const next: string[] = [];
    for (const id of frontier) {
      const entry = map[id];
      if (!entry) continue;

      if (prefixOf(id) === "route") {
        for (const consumer of rev("COMPONENT_FETCHES_ROUTE", id)) {
          if (add(consumer, `fetches ${entry.name}`)) next.push(consumer);
        }
      }

      if (entry.filePath) {
        const fileNode = `file:${entry.filePath}`;
        for (const importer of rev("FILE_IMPORTS", fileNode)) {
          if (add(importer, `imports ${entry.filePath}`)) next.push(importer);
        }
      }
    }
    frontier = next;
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Text gate — does this file actually name the symbol that is changing?
// ---------------------------------------------------------------------------

/**
 * Identifiers whose presence means a file is affected by this change.
 *
 * For a field change that is the field name. For a whole-model change it is the
 * model name plus its camelCase Prisma-client alias, so `prisma.user.findMany`
 * is matched as well as `User`.
 */
function symbolsFor(target: BlastRadiusTarget): string[] {
  if (target.field) return [target.field];
  const alias = target.model.charAt(0).toLowerCase() + target.model.slice(1);
  return alias === target.model ? [target.model] : [target.model, alias];
}

function readOrNull(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * A syntactic reference — `post.title`, `{ title?: string }`, `select: { title }`.
 *
 * This is the enforced signal. It is precise enough to keep a page's
 * `metadata = { title: "…" }` out of the radius, and complete enough to catch a
 * component the extractor failed to link.
 */
function fileReferencesSymbol(
  absPath: string,
  relPath: string,
  symbols: string[],
  wholeModel: boolean
): boolean {
  const content = readOrNull(absPath);
  if (content === null) return false;
  // Deleting a model invalidates type annotations, imports, and Prisma-client
  // delegates as well as property accesses. Field-only syntax is deliberately
  // too narrow for this case.
  if (wholeModel) return symbols.some((s) => referencesIdentifier(content, s));
  return symbols.some((s) => referencesField(content, relPath, s));
}

/** A bare word match — the advisory signal, never enforced. */
function fileMentionsSymbol(absPath: string, symbols: string[]): boolean {
  const content = readOrNull(absPath);
  if (content === null) return false;
  return symbols.some((s) => referencesIdentifier(content, s));
}

/** route beats component beats file when several nodes share one path. */
const SPECIFICITY: Record<string, number> = { route: 3, component: 2, file: 1 };

// ---------------------------------------------------------------------------
// HydraDB consistency check (non-blocking, advisory)
// ---------------------------------------------------------------------------

/**
 * HydraDB returns relation endpoints as content-hash `entityId`s plus a
 * lowercased display `name`/`identifier`. The hashes are meaningless to us, so
 * comparing them against graphyti node ids — as this check used to — could
 * never match and warned on every single run. Compare the names instead, and
 * only report endpoints that look like graphyti ids yet are absent from the
 * local graph: those are genuinely stale remote nodes, which is actionable.
 */
async function checkHydraConsistency(
  changedNodeId: string,
  map: GraphMap
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

    const remoteNames = new Set<string>();
    for (const triplet of envelope.data.relations) {
      for (const side of [triplet.source, triplet.target]) {
        if (!side) continue;
        if (side.name) remoteNames.add(side.name.trim().toLowerCase());
        if (side.identifier) remoteNames.add(side.identifier.trim().toLowerCase());
      }
    }
    remoteNames.delete(changedNodeId.toLowerCase());

    const localIdsLower = new Set(Object.keys(map).map((id) => id.toLowerCase()));
    const ghosts = [...remoteNames].filter(
      (name) => KNOWN_PREFIXES.has(prefixOf(name)) && !localIdsLower.has(name)
    );

    if (ghosts.length === 0) {
      console.log(
        `  ${sym.ok} ${info("[HydraDB]")} no stale remote nodes around ${changedNodeId}`
      );
    } else {
      console.warn(
        `  ${warn("!")} ${info("[HydraDB]")} ${ghosts.length} stale remote node(s) near ${changedNodeId}: ${ghosts.slice(0, 6).join(", ")}${ghosts.length > 6 ? ", …" : ""}`
      );
      console.warn(`      (run 'graphyti init-graph' to prune them)`);
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
      console.warn(
        `  ${warn("!")} ${info("[HydraDB]")} check skipped — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

const KNOWN_PREFIXES = new Set(["model", "field", "route", "component", "file"]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function parseTarget(target: string | BlastRadiusTarget): BlastRadiusTarget | null {
  if (typeof target !== "string") return target;
  if (target.startsWith("model:")) return { model: target.slice("model:".length) };
  if (target.startsWith("field:")) {
    const rest = target.slice("field:".length);
    const dot = rest.indexOf(".");
    if (dot === -1) return { model: rest };
    return { model: rest.slice(0, dot), field: rest.slice(dot + 1) };
  }
  return null;
}

/** A radius with nothing in it — for a target the graph has never seen. */
export function emptyBlastRadius(target: BlastRadiusTarget): BlastRadiusResult {
  return emptyResult(
    nodeIdFor(target),
    target.field ? `${target.model}.${target.field}` : target.model
  );
}

function emptyResult(id: string, name: string): BlastRadiusResult {
  return {
    changedNode: { id, name, kind: "unknown", filePath: "" },
    affectedRoutes: [],
    affectedComponents: [],
    affectedFiles: [],
    advisoryFiles: [],
    affectedFilePaths: [],
    filteredOut: [],
    staleNodes: [],
  };
}

/**
 * Enumerate everything a breaking schema change can break.
 *
 * Accepts either a `{ model, field }` target or a node id string
 * (`model:User`, `field:User.phone`) for older call sites.
 */
export interface ComputeBlastRadiusOptions {
  /** Run the advisory HydraDB consistency check. Off in tests — it needs a network. */
  checkRemote?: boolean;
}

export async function computeBlastRadius(
  target: string | BlastRadiusTarget,
  projectRoot: string = process.cwd(),
  options: ComputeBlastRadiusOptions = {}
): Promise<BlastRadiusResult> {
  const checkRemote = options.checkRemote ?? true;
  const parsed = parseTarget(target);
  const rawId = typeof target === "string" ? target : nodeIdFor(target);
  if (!parsed) return emptyResult(rawId, rawId);

  const absRoot = path.resolve(projectRoot);
  const map = loadGraphMap(absRoot);

  const changedId = nodeIdFor(parsed);
  const modelId = `model:${parsed.model}`;
  const changedEntry: GraphMapEntry | undefined = map[changedId] ?? map[modelId];

  if (!changedEntry) return emptyResult(changedId, parsed.field ?? parsed.model);

  const consistencyCheck = checkRemote
    ? checkHydraConsistency(modelId, map)
    : Promise.resolve();

  const rev = buildReverseIndex(map);
  const candidates = collectCandidates(parsed, map, rev);
  const symbols = symbolsFor(parsed);

  // ── Reference gate ───────────────────────────────────────────────────────
  const filteredOut: BlastRadiusResult["filteredOut"] = [];
  const staleNodes: BlastRadiusResult["staleNodes"] = [];
  const kept: AffectedNode[] = [];

  for (const [id, reason] of candidates) {
    const entry = map[id];
    if (!entry?.filePath) continue;
    const abs = path.resolve(absRoot, entry.filePath);
    if (!fs.existsSync(abs)) {
      staleNodes.push({ id, filePath: entry.filePath });
      continue;
    }
    if (!fileReferencesSymbol(abs, entry.filePath, symbols, !parsed.field)) {
      filteredOut.push({ id, filePath: entry.filePath });
      continue;
    }
    kept.push({ id, name: entry.name, filePath: entry.filePath, reason });
  }

  // ── Recall pass ──────────────────────────────────────────────────────────
  //
  // Files that syntactically reference the field but carry no edge to it. The
  // extractor drops an edge whenever it cannot pin a field to exactly one model
  // — a component reading `post.title` from a route that queries `User` gets no
  // COMPONENT_RENDERS_FIELD edge at all. Those files break just as hard, so a
  // graph-only radius is not a safe radius.
  for (const abs of safeListSourceFiles(absRoot)) {
    const rel = toPosix(path.relative(absRoot, abs));
    if (rel === changedEntry.filePath) continue;
    if (kept.some((n) => n.filePath === rel)) continue;
    if (!fileReferencesSymbol(abs, rel, symbols, !parsed.field)) continue;

    const nodeId = map[`component:${rel}`]
      ? `component:${rel}`
      : map[`file:${rel}`]
        ? `file:${rel}`
        : `file:${rel}`;
    kept.push({
      id: nodeId,
      name: map[nodeId]?.name ?? rel,
      filePath: rel,
      reason: `references ${symbols[0]} (no graph edge — extractor could not disambiguate)`,
    });
  }

  // ── One node per file path, most specific wins ───────────────────────────
  const byPath = new Map<string, AffectedNode>();
  for (const node of kept) {
    const existing = byPath.get(node.filePath);
    if (
      !existing ||
      (SPECIFICITY[prefixOf(node.id)] ?? 0) > (SPECIFICITY[prefixOf(existing.id)] ?? 0)
    ) {
      byPath.set(node.filePath, node);
    }
  }

  const affectedRoutes: AffectedNode[] = [];
  const affectedComponents: AffectedNode[] = [];
  const affectedFiles: AffectedNode[] = [];
  for (const node of byPath.values()) {
    if (prefixOf(node.id) === "route") affectedRoutes.push(node);
    else if (prefixOf(node.id) === "component") affectedComponents.push(node);
    else affectedFiles.push(node);
  }

  // ── Advisory sweep ───────────────────────────────────────────────────────
  const advisoryFiles = sweepForSymbols(absRoot, symbols, byPath, changedEntry.filePath);

  const sortByPath = (a: AffectedNode, b: AffectedNode) =>
    a.filePath.localeCompare(b.filePath);
  affectedRoutes.sort(sortByPath);
  affectedComponents.sort(sortByPath);
  affectedFiles.sort(sortByPath);
  advisoryFiles.sort(sortByPath);

  await consistencyCheck;

  return {
    changedNode: {
      id: changedId,
      name: parsed.field ? `${parsed.model}.${parsed.field}` : parsed.model,
      kind: parsed.field ? "ModelField" : "PrismaModel",
      filePath: changedEntry.filePath,
    },
    affectedRoutes,
    affectedComponents,
    affectedFiles,
    advisoryFiles,
    affectedFilePaths: [...byPath.keys()].sort(),
    filteredOut,
    staleNodes,
  };
}

export function nodeIdFor(target: BlastRadiusTarget): string {
  return target.field
    ? `field:${target.model}.${target.field}`
    : `model:${target.model}`;
}

function safeListSourceFiles(absRoot: string): string[] {
  try {
    return listSourceFiles(absRoot);
  } catch {
    return [];
  }
}

/**
 * Files that merely mention the name somewhere — a parameter called `title`, a
 * page's `metadata = { title }`.
 *
 * Shown to the user and to the model so a genuine miss is still visible, but
 * never enforced: a bare word match is not evidence of a data-flow dependency,
 * and blocking on one fails correct runs.
 */
function sweepForSymbols(
  absRoot: string,
  symbols: string[],
  covered: Map<string, AffectedNode>,
  changedFilePath: string
): AffectedNode[] {
  const out: AffectedNode[] = [];

  for (const abs of safeListSourceFiles(absRoot)) {
    const rel = toPosix(path.relative(absRoot, abs));
    if (covered.has(rel) || rel === changedFilePath) continue;
    if (!fileMentionsSymbol(abs, symbols)) continue;
    out.push({
      id: `file:${rel}`,
      name: rel,
      filePath: rel,
      reason: `mentions ${symbols[0]}, but never as a field reference`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI tree formatter
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

/** Distinct files in the enforced set — the number the user is asked to approve. */
export function blastRadiusSize(result: BlastRadiusResult): number {
  return result.affectedFilePaths.length;
}

export function formatBlastRadius(result: BlastRadiusResult): string {
  const lines: string[] = [];

  lines.push(
    `  ${info("Changing:")} ${accent(result.changedNode.name)} ${info(`(${result.changedNode.kind})`)}`
  );
  lines.push(`  ${info(result.changedNode.filePath)}`);

  const total = blastRadiusSize(result);

  if (total === 0) {
    lines.push(`  ${success("No downstream file references this — nothing else to update.")}`);
  } else {
    const allNodes = [
      ...result.affectedRoutes,
      ...result.affectedComponents,
      ...result.affectedFiles,
    ];
    const colWidth = Math.min(28, Math.max(12, ...allNodes.map((n) => visLen(n.name))));
    lines.push(`  ${bold(`${total} file${total === 1 ? "" : "s"} must change:`)}`);
    lines.push(...formatNodeGroup("Routes", result.affectedRoutes, colWidth));
    lines.push(...formatNodeGroup("Components", result.affectedComponents, colWidth));
    lines.push(...formatNodeGroup("Files", result.affectedFiles, colWidth));
  }

  if (result.filteredOut.length > 0) {
    lines.push(
      `  ${info(`${result.filteredOut.length} graph neighbour(s) skipped — they never name ${result.changedNode.name}`)}`
    );
  }
  if (result.staleNodes.length > 0) {
    lines.push(
      `  ${warn("!")} ${result.staleNodes.length} graph node(s) point at files that no longer exist — run 'graphyti init-graph'`
    );
  }
  if (result.advisoryFiles.length > 0) {
    lines.push(`  ${warn("Also mentions this name (not graph-linked, not enforced):")}`);
    for (const n of result.advisoryFiles) {
      lines.push(`    ${sym.bullet} ${info(n.filePath)}`);
    }
  }

  return lines.join("\n");
}

export function blastRadiusPromptSection(result: BlastRadiusResult): string {
  const enforced = [
    ...result.affectedRoutes,
    ...result.affectedComponents,
    ...result.affectedFiles,
  ];
  if (enforced.length === 0 && result.advisoryFiles.length === 0) return "";

  const lines: string[] = [
    `\n== BLAST RADIUS for ${result.changedNode.name} ==`,
  ];

  if (enforced.length > 0) {
    lines.push(
      `These ${enforced.length} file(s) reference it today and MUST be updated in the same change:\n`
    );
    for (const n of enforced) {
      lines.push(`  - ${n.filePath}  (${n.reason})`);
    }
  }

  if (result.advisoryFiles.length > 0) {
    lines.push(`\nThese files also mention the name; update them only if genuinely related:\n`);
    for (const n of result.advisoryFiles) {
      lines.push(`  - ${n.filePath}`);
    }
  }

  lines.push(`\nLeaving any required file inconsistent will fail structural verification.`);
  return lines.join("\n");
}
