/**
 * Session state — the explicit state machine behind the UI (§22).
 *
 * The previous implementation had a `Phase` union that conflated two unrelated
 * things: *which pipeline stage is running* and *what the UI is doing*. That is
 * why the input vanished once a run finished — `phase === "done"` rendered a
 * results box and nothing else, with no way back to a prompt.
 *
 * Here the two are separate. `SessionState` is what the UI is doing and is the
 * only thing that decides which chrome and key hints appear. Pipeline stages are
 * ordinary content blocks in the transcript. A finished run returns the session
 * to `idle`, so the prompt is always reachable.
 */

import type { Line } from "../core/line";
import type { StatusKind } from "../theme/tokens";

/**
 * What the UI is doing right now. Every value has one predictable visual
 * representation, and the set is closed — the status bar and help bar switch
 * exhaustively on it, so a new state cannot be added without deciding how it
 * looks and what keys it offers.
 */
export type SessionState =
  | "idle"
  | "thinking"
  | "planning"
  | "tool_running"
  | "waiting_for_permission"
  | "waiting_for_input"
  | "success"
  | "error"
  | "cancelled";

/** Human label for the status bar. */
export const SESSION_LABELS: Record<SessionState, string> = {
  idle: "Ready",
  thinking: "Thinking",
  planning: "Planning",
  tool_running: "Running",
  waiting_for_permission: "Permission required",
  waiting_for_input: "Waiting for input",
  success: "Done",
  error: "Error",
  cancelled: "Cancelled",
};

/** Is the agent doing work? Drives the spinner and the cancel hint. */
export function isBusy(state: SessionState): boolean {
  return state === "thinking" || state === "planning" || state === "tool_running";
}

/** Is the UI blocked on the user? Drives input focus routing. */
export function isBlocking(state: SessionState): boolean {
  return state === "waiting_for_permission" || state === "waiting_for_input";
}

// ── Tools ────────────────────────────────────────────────────────────────────

/**
 * The tool vocabulary (§14). Fixed set, one visual per verb, never varying
 * between screens. `label` is what the user sees; it is padded to a common
 * width so a column of tool calls aligns.
 */
export type ToolKind =
  | "read"
  | "write"
  | "edit"
  | "create"
  | "delete"
  | "search"
  | "run"
  | "schema"
  | "analyze"
  | "index";

export const TOOL_LABELS: Record<ToolKind, string> = {
  read: "read",
  write: "write",
  edit: "edit",
  create: "create",
  delete: "delete",
  search: "search",
  run: "run",
  schema: "schema",
  analyze: "analyze",
  index: "index",
};

/** Widest tool label, so the verb column is a fixed width and never shifts. */
export const TOOL_LABEL_WIDTH = Math.max(
  ...Object.values(TOOL_LABELS).map((l) => l.length)
);

export interface ToolCall {
  id: string;
  kind: ToolKind;
  /** The primary target: a file path, a command, a query. */
  target: string;
  status: StatusKind;
  /** One-line result summary, e.g. "142 lines", "28 tests passed". */
  result?: string;
  /** Failure reason, shown in place of the result. */
  error?: string;
  /** Raw output, collapsed by default. */
  output?: string;
  elapsedMs?: number;
}

// ── Transcript blocks ────────────────────────────────────────────────────────

export interface UserBlock {
  kind: "user";
  id: string;
  text: string;
}

export interface AssistantBlock {
  kind: "assistant";
  id: string;
  text: string;
  /** Suppress the `● Agent` marker when continuing a previous assistant turn. */
  continuation?: boolean;
}

export interface SystemBlock {
  kind: "system";
  id: string;
  text: string;
  tone?: "info" | "warning";
}

export interface ErrorBlock {
  kind: "error";
  id: string;
  /** What failed — the headline. */
  title: string;
  /** The failing command or operation, if there was one. */
  context?: string;
  /** Why it failed — the raw message. */
  detail?: string;
  /** What the user can do about it. */
  hint?: string;
}

export interface ToolBlock {
  kind: "tool";
  id: string;
  call: ToolCall;
  expanded?: boolean;
}

export interface DiffBlock {
  kind: "diff";
  id: string;
  filePath: string;
  /** Unified-diff text, as produced by the diff layer. */
  patch: string;
  expanded?: boolean;
}

export interface PlanBlock {
  kind: "plan";
  id: string;
  steps: Array<{ description: string; kind: "structural_edit" | "new_file" }>;
  currentIndex: number;
  completed: number[];
  failed: number[];
}

export interface OperationsBlock {
  kind: "operations";
  id: string;
  operations: Array<{
    type: string;
    op?: string;
    model?: string;
    fieldName?: string;
    filePath?: string;
    command?: string;
    editCount?: number;
  }>;
}

export interface BlastBlock {
  kind: "blast";
  id: string;
  modelName: string;
  routes: Array<{ name: string; filePath: string; reason: string }>;
  components: Array<{ name: string; filePath: string; reason: string }>;
  files: Array<{ name: string; filePath: string; reason: string }>;
  expanded?: boolean;
}

export interface SummaryBlock {
  kind: "summary";
  id: string;
  filesWritten: string[];
  filesCreated: string[];
  commands: string[];
  blastRadiusSize: number;
  graphIndexUpdated: boolean;
  elapsedMs: number;
  dryRun: boolean;
}

/** Captured stdout/stderr from the pipeline, kept out of the way (§34, §35). */
export interface LogBlock {
  kind: "log";
  id: string;
  lines: string[];
  expanded?: boolean;
}

/** Pre-rendered rows, for content that is already a `Line[]`. */
export interface RawBlock {
  kind: "raw";
  id: string;
  lines: Line[];
}

export type Block =
  | UserBlock
  | AssistantBlock
  | SystemBlock
  | ErrorBlock
  | ToolBlock
  | DiffBlock
  | PlanBlock
  | OperationsBlock
  | BlastBlock
  | SummaryBlock
  | LogBlock
  | RawBlock;

// ── Permission requests ──────────────────────────────────────────────────────

export interface PermissionRequest {
  id: string;
  /** Headline: what is being asked. */
  title: string;
  /** The command or operation, shown verbatim and monospaced. */
  subject?: string;
  /** Consequence the user must understand before answering. */
  consequence?: string;
  /** The question itself. */
  question: string;
  /** Severity — drives colour and glyph, never the wording. */
  danger?: boolean;
}

// ── Store ────────────────────────────────────────────────────────────────────

export interface SessionSnapshot {
  state: SessionState;
  /** Finalised transcript. Append-only. */
  blocks: Block[];
  /** Blocks belonging to the in-flight turn, not yet finalised. */
  live: Block[];
  /** Current activity line, e.g. "Retrieving codebase context". */
  activity: string | null;
  /** Pending permission request, if any. */
  permission: PermissionRequest | null;
  /** Input history, most recent last. */
  history: string[];
  /** Debug mode (§35). */
  debug: boolean;
}
