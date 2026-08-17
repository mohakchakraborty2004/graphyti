/**
 * Block renderers — pure functions from a transcript block to terminal rows.
 *
 * This module *is* the visual language. Every rule about indentation, glyphs,
 * colour and hierarchy from the design spec is expressed here once, and nowhere
 * else. A component's job is to draw the rows it is handed, not to decide what
 * they look like.
 *
 * Being pure and width-parameterised is what makes the layout testable: the
 * suite renders every block at every breakpoint and asserts no row exceeds the
 * width, with no terminal involved.
 */

import {
  UI_COLORS,
  UI_INDENT,
  UI_LAYOUT,
  UI_SYMBOLS,
  STATUS_VISUALS,
} from "../theme/tokens";
import {
  blank,
  dividerLine,
  line,
  span,
  textLines,
  wrapSpans,
  type Line,
} from "../core/line";
import { visualWidth, wrapPath, wrapText, truncateEnd } from "../core/text";
import {
  TOOL_LABELS,
  TOOL_LABEL_WIDTH,
  type Block,
  type BlastBlock,
  type DiffBlock,
  type ErrorBlock,
  type LogBlock,
  type OperationsBlock,
  type PlanBlock,
  type SummaryBlock,
  type ToolBlock,
  type ToolCall,
} from "../state/types";

export interface RenderContext {
  /** Width every row must fit within. */
  width: number;
  /** Width for long-form prose, usually narrower than `width`. */
  textWidth: number;
  /** Drop secondary metadata (§37). */
  narrow: boolean;
  /** Show internal detail (§35). */
  debug: boolean;
  /** Current spinner frame, for blocks with a running state. */
  spinnerFrame: string;
}

const MUTED = { color: UI_COLORS.muted } as const;
const ACCENT = { color: UI_COLORS.accent } as const;
const DIM = { color: UI_COLORS.muted, dim: true } as const;

// ── Speaker markers ──────────────────────────────────────────────────────────

/**
 * `❯ You` / `● Agent` — the marker rows.
 *
 * The marker is its own row and the body is indented beneath it (§8, §9). One
 * marker per turn, never per line: prefixing every line was explicitly called
 * out as the thing to avoid.
 */
function speakerLine(symbol: string, name: string, color: string): Line {
  return line(span(`${symbol} `, { color, bold: true }), span(name, { bold: true }));
}

function renderUser(text: string, ctx: RenderContext): Line[] {
  return [
    speakerLine(UI_SYMBOLS.user, "You", UI_COLORS.accent),
    blank(),
    ...textLines(text, ctx.textWidth, { indent: UI_INDENT.sm }),
  ];
}

function renderAssistant(text: string, continuation: boolean, ctx: RenderContext): Line[] {
  const body = textLines(text, ctx.textWidth, { indent: UI_INDENT.sm });
  if (continuation) return body;
  return [
    speakerLine(UI_SYMBOLS.agent, "Agent", UI_COLORS.accent),
    blank(),
    ...body,
  ];
}

function renderSystem(text: string, tone: "info" | "warning", ctx: RenderContext): Line[] {
  const style = tone === "warning" ? { color: UI_COLORS.warning } : DIM;
  const marker = tone === "warning" ? UI_SYMBOLS.warning : UI_SYMBOLS.bullet;
  return wrapSpans(line(span(`${marker} `, style), span(text, style)), ctx.textWidth, {
    hangingIndent: 2,
  });
}

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * Errors separate *what failed*, *why*, and *what to do* (§23), because a single
 * concatenated `Error: Error: ...` string is unreadable and unactionable.
 */
function renderError(block: ErrorBlock, ctx: RenderContext): Line[] {
  const out: Line[] = [
    line(
      span(`${UI_SYMBOLS.error} `, { color: UI_COLORS.error, bold: true }),
      span(block.title, { color: UI_COLORS.error, bold: true })
    ),
  ];

  if (block.context) {
    out.push(blank());
    for (const row of wrapText(block.context, ctx.width - UI_INDENT.sm, { indent: 0 })) {
      out.push(line(span("  "), span("$ ", MUTED), span(row, { bold: true })));
    }
  }

  if (block.detail) {
    out.push(blank());
    // Detail is raw machine output: preserve its own line structure rather than
    // reflowing it into a paragraph, or stack traces become unreadable.
    for (const row of wrapText(block.detail, ctx.width, {
      indent: UI_INDENT.sm,
      normalizeWhitespace: false,
      preserveIndent: true,
    })) {
      out.push(line(span(row, { color: UI_COLORS.error })));
    }
  }

  if (block.hint) {
    out.push(blank());
    out.push(...textLines(block.hint, ctx.textWidth, { indent: UI_INDENT.sm, style: MUTED }));
  }

  return out;
}

// ── Tools ────────────────────────────────────────────────────────────────────

/**
 * A tool call (§11):
 *
 *     └─ read    src/auth/session.ts
 *                ✓ 142 lines
 *
 * The verb sits in a fixed-width column so a stack of calls aligns, and the
 * target wraps at path separators under a hanging indent so it never runs back
 * under the verb.
 */
function renderToolCall(call: ToolCall, expanded: boolean, ctx: RenderContext): Line[] {
  const visual = STATUS_VISUALS[call.status];
  const label = TOOL_LABELS[call.kind];

  // On a narrow terminal the tree glyph is dropped — it is decoration, and
  // decoration is the first thing to go (§37).
  const branch = ctx.narrow ? "" : `${UI_SYMBOLS.branchLast} `;
  const verbColumn = ctx.narrow ? label : label.padEnd(TOOL_LABEL_WIDTH);
  const headIndent = UI_INDENT.sm;
  const prefixWidth = headIndent + visualWidth(branch) + visualWidth(verbColumn) + 1;

  const out: Line[] = [];

  // Target on the same row as the verb when it fits; on its own rows when not,
  // which is what keeps long paths readable instead of truncated (§6).
  const targetWidth = ctx.width - prefixWidth;
  const isPathLike = call.kind !== "run" && call.kind !== "search";
  const fits = visualWidth(call.target) <= targetWidth;

  if (fits) {
    out.push(
      line(
        span(" ".repeat(headIndent)),
        branch ? span(branch, DIM) : null,
        span(verbColumn, { color: UI_COLORS.secondary }),
        span(" "),
        span(call.target, { bold: false })
      )
    );
  } else {
    out.push(
      line(
        span(" ".repeat(headIndent)),
        branch ? span(branch, DIM) : null,
        span(verbColumn, { color: UI_COLORS.secondary })
      )
    );
    const rows = isPathLike
      ? wrapPath(call.target, ctx.width, UI_INDENT.md)
      : wrapText(call.target, ctx.width, { indent: UI_INDENT.md });
    for (const row of rows) out.push(line(span(row)));
  }

  // Status row. Reserved-width marker so a spinner frame changing cannot shift
  // the text beside it (§10, §28).
  const statusIndent = UI_INDENT.md;
  const marker = call.status === "running" ? ctx.spinnerFrame : visual.symbol;
  const statusText =
    call.status === "error"
      ? (call.error ?? "failed")
      : call.status === "running"
        ? "…"
        : (call.result ?? "");

  if (statusText.length > 0 || call.status === "running") {
    const timing =
      !ctx.narrow && call.elapsedMs !== undefined && call.status !== "running"
        ? `  ${formatElapsed(call.elapsedMs)}`
        : "";

    out.push(
      ...wrapSpans(
        line(
          span(`${marker} `, { color: visual.color, bold: !visual.dim }),
          span(statusText, {
            color:
              call.status === "error"
                ? UI_COLORS.error
                : call.status === "success"
                  ? undefined
                  : UI_COLORS.muted,
          }),
          timing ? span(timing, DIM) : null
        ),
        ctx.width,
        { indent: statusIndent, hangingIndent: 2 }
      )
    );
  }

  // Output: collapsed to a hint by default so it cannot dominate the
  // conversation (§12), with a hard row cap in both states.
  if (call.output && call.output.trim().length > 0) {
    out.push(...renderToolOutput(call.output, expanded, ctx));
  }

  return out;
}

function renderToolOutput(output: string, expanded: boolean, ctx: RenderContext): Line[] {
  const rows = output.replace(/\s+$/, "").split("\n");
  const cap = expanded ? UI_LAYOUT.expandedOutputRows : UI_LAYOUT.collapsedOutputRows;
  const out: Line[] = [];

  if (!expanded) {
    out.push(
      line(
        span(" ".repeat(UI_INDENT.md)),
        span(`${UI_SYMBOLS.collapsed} `, DIM),
        span(`${rows.length} line${rows.length === 1 ? "" : "s"} of output`, DIM),
        span("  ctrl+o", { color: UI_COLORS.muted, dim: true })
      )
    );
    return out;
  }

  const shown = rows.slice(0, cap);
  const hidden = rows.length - shown.length;

  out.push(
    line(
      span(" ".repeat(UI_INDENT.md)),
      span(`${UI_SYMBOLS.expanded} `, DIM),
      span("Output", DIM)
    )
  );

  for (const row of shown) {
    for (const wrapped of wrapText(row, ctx.width, {
      indent: UI_INDENT.lg,
      normalizeWhitespace: false,
      preserveIndent: true,
    })) {
      out.push(line(span(wrapped, DIM)));
    }
  }

  if (hidden > 0) {
    out.push(
      line(span(" ".repeat(UI_INDENT.lg)), span(`${UI_SYMBOLS.ellipsis} ${hidden} more`, DIM))
    );
  }

  return out;
}

// ── Diffs ────────────────────────────────────────────────────────────────────

/**
 * A diff (§15): file header, then gutter-marked lines. No box per line, no box
 * at all — colour plus a `+`/`-` gutter carries it, and the gutter means it
 * still reads in a monochrome terminal (§36).
 */
function renderDiff(block: DiffBlock, ctx: RenderContext): Line[] {
  const out: Line[] = [];

  for (const row of wrapPath(block.filePath, ctx.width, UI_INDENT.sm)) {
    out.push(line(span(row, { bold: true })));
  }
  out.push(blank());

  const rows = block.patch.split("\n").filter((r, i, arr) => !(i === arr.length - 1 && r === ""));
  const cap = block.expanded ? UI_LAYOUT.expandedOutputRows : UI_LAYOUT.collapsedDiffRows;
  const shown = rows.slice(0, cap);
  const hidden = rows.length - shown.length;

  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.startsWith("+")) added++;
    else if (row.startsWith("-")) removed++;
  }

  for (const row of shown) {
    const isAdd = row.startsWith("+");
    const isRemove = row.startsWith("-");
    const isMeta = row.startsWith("@@");

    const style = isAdd
      ? { color: UI_COLORS.added }
      : isRemove
        ? { color: UI_COLORS.removed }
        : isMeta
          ? { color: UI_COLORS.secondary }
          : DIM;

    const body = isAdd || isRemove ? row.slice(1) : isMeta ? row : row.replace(/^ /, "");
    const gutter = isAdd
      ? UI_SYMBOLS.diffAdd
      : isRemove
        ? UI_SYMBOLS.diffRemove
        : isMeta
          ? ""
          : UI_SYMBOLS.diffContext;

    // Gutter is reserved separately from the body so a wrapped continuation
    // lines up under the code, not under the marker.
    const wrapped = wrapText(body, ctx.width, {
      indent: UI_INDENT.sm + (gutter ? 2 : 0),
      normalizeWhitespace: false,
      preserveIndent: true,
    });

    if (wrapped.length === 0) {
      out.push(line(span(" ".repeat(UI_INDENT.sm)), gutter ? span(gutter, style) : null));
      continue;
    }

    wrapped.forEach((wrappedRow, i) => {
      if (i === 0 && gutter) {
        const body2 = wrappedRow.slice(UI_INDENT.sm + 2);
        out.push(
          line(
            span(" ".repeat(UI_INDENT.sm)),
            span(gutter, { ...style, bold: true }),
            span(" "),
            span(body2, style)
          )
        );
      } else {
        out.push(line(span(wrappedRow, style)));
      }
    });
  }

  if (hidden > 0) {
    out.push(
      line(
        span(" ".repeat(UI_INDENT.sm)),
        span(`${UI_SYMBOLS.ellipsis} ${hidden} more line${hidden === 1 ? "" : "s"}`, DIM),
        span("  ctrl+o", DIM)
      )
    );
  }

  if (!ctx.narrow && (added > 0 || removed > 0)) {
    out.push(
      line(
        span(" ".repeat(UI_INDENT.sm)),
        span(`+${added}`, { color: UI_COLORS.added }),
        span("  "),
        span(`-${removed}`, { color: UI_COLORS.removed })
      )
    );
  }

  return out;
}

// ── Plan ─────────────────────────────────────────────────────────────────────

function renderPlan(block: PlanBlock, ctx: RenderContext): Line[] {
  const done = block.completed.length;
  const failed = block.failed.length;
  const total = block.steps.length;

  const out: Line[] = [
    line(
      span(`${UI_SYMBOLS.agent} `, ACCENT),
      span("Plan", { bold: true }),
      span(`  ${done}/${total}`, MUTED),
      failed > 0 ? span(`  ${failed} failed`, { color: UI_COLORS.error }) : null
    ),
    blank(),
  ];

  block.steps.forEach((step, i) => {
    const status = block.completed.includes(i)
      ? "success"
      : block.failed.includes(i)
        ? "error"
        : i === block.currentIndex
          ? "running"
          : "pending";

    const visual = STATUS_VISUALS[status];
    const marker = status === "running" ? ctx.spinnerFrame : visual.symbol;
    const isLast = i === block.steps.length - 1;
    const branch = ctx.narrow ? "" : `${isLast ? UI_SYMBOLS.branchLast : UI_SYMBOLS.branch} `;

    out.push(
      ...wrapSpans(
        line(
          branch ? span(branch, DIM) : null,
          span(`${marker} `, { color: visual.color, bold: !visual.dim }),
          span(`${i + 1}. `, DIM),
          span(step.description, visual.dim ? MUTED : {}),
          step.kind === "new_file" && !ctx.narrow
            ? span("  new file", { color: UI_COLORS.secondary, dim: true })
            : null
        ),
        ctx.width,
        { indent: UI_INDENT.sm, hangingIndent: ctx.narrow ? 3 : 5 }
      )
    );
  });

  return out;
}

// ── Operations ───────────────────────────────────────────────────────────────

function renderOperations(block: OperationsBlock, ctx: RenderContext): Line[] {
  const out: Line[] = [
    line(
      span(`${UI_SYMBOLS.agent} `, ACCENT),
      span("Planned edits", { bold: true }),
      span(`  ${block.operations.length}`, MUTED)
    ),
    blank(),
  ];

  for (const op of block.operations) {
    const { verb, detail } = describeOperation(op);
    out.push(
      ...wrapSpans(
        line(
          ctx.narrow ? null : span(`${UI_SYMBOLS.branchLast} `, DIM),
          span(ctx.narrow ? verb : verb.padEnd(TOOL_LABEL_WIDTH), {
            color: UI_COLORS.secondary,
          }),
          span(" "),
          span(detail)
        ),
        ctx.width,
        { indent: UI_INDENT.sm, hangingIndent: ctx.narrow ? 2 : 3 }
      )
    );
  }

  return out;
}

function describeOperation(op: OperationsBlock["operations"][number]): {
  verb: string;
  detail: string;
} {
  switch (op.type) {
    case "schema":
      return {
        verb: "schema",
        detail: `${op.op ?? "edit"} ${op.model ?? ""}${op.fieldName ? `.${op.fieldName}` : ""}`.trim(),
      };
    case "file": {
      const edits = op.editCount ?? 1;
      return {
        verb: "edit",
        detail: `${op.filePath ?? "?"}${edits > 1 ? `  ${edits} edits` : ""}`,
      };
    }
    case "create_file":
      return { verb: "create", detail: op.filePath ?? "?" };
    case "command":
      return { verb: "run", detail: op.command ?? "?" };
    default:
      return { verb: op.type, detail: op.filePath ?? op.command ?? "" };
  }
}

// ── Blast radius ─────────────────────────────────────────────────────────────

function renderBlast(block: BlastBlock, ctx: RenderContext): Line[] {
  const groups: Array<[string, BlastBlock["routes"]]> = [
    ["routes", block.routes],
    ["components", block.components],
    ["files", block.files],
  ];
  const total = groups.reduce((sum, [, items]) => sum + items.length, 0);

  const out: Line[] = [
    line(
      span(`${UI_SYMBOLS.warning} `, { color: UI_COLORS.warning, bold: true }),
      span("Blast radius", { bold: true }),
      span(`  ${block.modelName}`, { color: UI_COLORS.secondary })
    ),
    blank(),
    ...textLines(
      `${total} downstream ${total === 1 ? "item" : "items"} depend on this model.`,
      ctx.textWidth,
      { indent: UI_INDENT.sm, style: MUTED }
    ),
  ];

  if (!block.expanded) {
    out.push(
      line(
        span(" ".repeat(UI_INDENT.sm)),
        span(`${UI_SYMBOLS.collapsed} `, DIM),
        span("show affected files", DIM),
        span("  ctrl+o", DIM)
      )
    );
    return out;
  }

  for (const [name, items] of groups) {
    if (items.length === 0) continue;
    out.push(blank());
    out.push(
      line(
        span(" ".repeat(UI_INDENT.sm)),
        span(name, { color: UI_COLORS.secondary }),
        span(`  ${items.length}`, DIM)
      )
    );

    const cap = UI_LAYOUT.collapsedOutputRows;
    const shown = items.slice(0, cap);

    shown.forEach((item, i) => {
      const isLast = i === shown.length - 1 && items.length <= cap;
      const branch = ctx.narrow ? "" : `${isLast ? UI_SYMBOLS.branchLast : UI_SYMBOLS.branch} `;
      out.push(
        ...wrapSpans(
          line(
            branch ? span(branch, DIM) : null,
            span(item.name),
            ctx.narrow ? null : span(`  ${item.filePath}`, DIM)
          ),
          ctx.width,
          { indent: UI_INDENT.md, hangingIndent: 3 }
        )
      );
    });

    if (items.length > cap) {
      out.push(
        line(
          span(" ".repeat(UI_INDENT.md + (ctx.narrow ? 0 : 3))),
          span(`${UI_SYMBOLS.ellipsis} ${items.length - cap} more`, DIM)
        )
      );
    }
  }

  return out;
}

// ── Summary ──────────────────────────────────────────────────────────────────

function renderSummary(block: SummaryBlock, ctx: RenderContext): Line[] {
  const wrote = block.filesWritten.length + block.filesCreated.length;
  const headline = block.dryRun
    ? "Dry run complete"
    : wrote === 0
      ? "No files changed"
      : "Done";

  const out: Line[] = [
    line(
      span(`${UI_SYMBOLS.success} `, { color: UI_COLORS.success, bold: true }),
      span(headline, { bold: true }),
      !ctx.narrow ? span(`  ${formatElapsed(block.elapsedMs)}`, DIM) : null
    ),
  ];

  if (block.dryRun) {
    out.push(blank());
    out.push(
      ...textLines("No changes were written to disk.", ctx.textWidth, {
        indent: UI_INDENT.sm,
        style: MUTED,
      })
    );
  }

  const fileGroups: Array<[string, string[]]> = [
    ["changed", block.filesWritten],
    ["created", block.filesCreated],
  ];

  for (const [label, files] of fileGroups) {
    if (files.length === 0) continue;
    out.push(blank());
    out.push(
      line(span(" ".repeat(UI_INDENT.sm)), span(label, MUTED), span(`  ${files.length}`, DIM))
    );
    for (const file of files) {
      for (const row of wrapPath(file, ctx.width, UI_INDENT.md)) {
        out.push(line(span(row)));
      }
    }
  }

  if (block.commands.length > 0) {
    out.push(blank());
    out.push(line(span(" ".repeat(UI_INDENT.sm)), span("commands", MUTED)));
    for (const cmd of block.commands) {
      for (const row of wrapText(cmd, ctx.width, { indent: UI_INDENT.md })) {
        out.push(line(span(row, DIM)));
      }
    }
  }

  if (!ctx.narrow && (block.blastRadiusSize > 0 || block.graphIndexUpdated)) {
    out.push(blank());
    const bits: string[] = [];
    if (block.blastRadiusSize > 0) {
      bits.push(`${block.blastRadiusSize} downstream affected`);
    }
    if (block.graphIndexUpdated) bits.push("graph index updated");
    out.push(line(span(" ".repeat(UI_INDENT.sm)), span(bits.join(`  ${UI_SYMBOLS.bullet}  `), DIM)));
  }

  return out;
}

// ── Logs ─────────────────────────────────────────────────────────────────────

/**
 * Captured pipeline stdout. Collapsed to a single row by default: it is debug
 * information and must never overpower the conversation (§34).
 */
function renderLog(block: LogBlock, ctx: RenderContext): Line[] {
  if (!block.expanded && !ctx.debug) {
    return [
      line(
        span(" ".repeat(UI_INDENT.sm)),
        span(`${UI_SYMBOLS.collapsed} `, DIM),
        span(`${block.lines.length} log line${block.lines.length === 1 ? "" : "s"}`, DIM)
      ),
    ];
  }

  const cap = UI_LAYOUT.expandedOutputRows;
  const shown = block.lines.slice(-cap);
  const out: Line[] = [
    line(
      span(" ".repeat(UI_INDENT.sm)),
      span(`${UI_SYMBOLS.expanded} `, DIM),
      span("Logs", DIM)
    ),
  ];

  for (const row of shown) {
    for (const wrapped of wrapText(row, ctx.width, {
      indent: UI_INDENT.md,
      normalizeWhitespace: false,
      preserveIndent: true,
    })) {
      out.push(line(span(wrapped, DIM)));
    }
  }

  return out;
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/** Render one block to rows. Total function over the `Block` union. */
export function renderBlock(block: Block, ctx: RenderContext): Line[] {
  switch (block.kind) {
    case "user":
      return renderUser(block.text, ctx);
    case "assistant":
      return renderAssistant(block.text, block.continuation ?? false, ctx);
    case "system":
      return renderSystem(block.text, block.tone ?? "info", ctx);
    case "error":
      return renderError(block, ctx);
    case "tool":
      return renderToolCall(block.call, block.expanded ?? false, ctx);
    case "diff":
      return renderDiff(block, ctx);
    case "plan":
      return renderPlan(block, ctx);
    case "operations":
      return renderOperations(block, ctx);
    case "blast":
      return renderBlast(block, ctx);
    case "summary":
      return renderSummary(block, ctx);
    case "log":
      return renderLog(block, ctx);
    case "raw":
      return block.lines;
  }
}

/**
 * Render a sequence of blocks with one blank row between them.
 *
 * Spacing lives here rather than inside each renderer so that gaps stay uniform
 * and no block can accidentally double up its own margin — the cause of the
 * inconsistent vertical rhythm in the previous implementation.
 */
export function renderBlocks(blocks: Block[], ctx: RenderContext): Line[] {
  const out: Line[] = [];

  blocks.forEach((block, i) => {
    if (i > 0) out.push(blank());
    out.push(...renderBlock(block, ctx));
  });

  return out;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${(s % 60).toFixed(0)}s`;
}

/** Divider spanning the content width. Used only at major boundaries (§3). */
export function divider(width: number): Line {
  return dividerLine(width);
}

/** Truncate a path to one row, keeping both ends (for headers and status). */
export function shortPath(filePath: string, width: number): string {
  return truncateEnd(filePath, width);
}
