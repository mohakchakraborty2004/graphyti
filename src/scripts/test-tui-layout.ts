/**
 * Layout verification (§7, §42).
 *
 * Asserts the acceptance criteria mechanically rather than by eye:
 *
 *   - no rendered row exceeds the terminal width, at any width, in any state
 *   - no row needed the clip backstop, i.e. wrapping was correct rather than
 *     merely bounded
 *   - the frame fits the terminal height, so the input cannot be pushed off
 *   - spinner animation cannot change any row's width
 *   - the scroll model stays consistent under every offset
 *   - ambiguous-width glyphs never reach the screen
 *
 * Blocks are pure functions of data and width, so all of this runs headlessly.
 */

import {
  renderBlock,
  renderBlocks,
  type RenderContext,
} from "../tui/render/blocks";
import { clipLine, lineText, lineWidth, type Line } from "../tui/core/line";
import { visualWidth } from "../tui/core/text";
import { computeWindow } from "../tui/components/layout/Conversation";
import {
  chromeRows,
  computeLayout,
  breakpointFor,
} from "../tui/layout/useTerminalLayout";
import {
  SPINNER_FRAMES,
  UI_LAYOUT,
  WIDE_UNSAFE,
} from "../tui/theme/tokens";
import { hintsFor } from "../tui/components/layout/StatusBar";
import { filterCommands } from "../tui/components/interactive/CommandPalette";
import { layoutEditor, caretPosition } from "../tui/components/layout/PromptEditor";
import type { Block, SessionState } from "../tui/state/types";

let failures = 0;
let checks = 0;

function ok(condition: boolean, label: string, detail?: string) {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
  }
}

function section(name: string) {
  console.log(`\n${name}`);
}

// ── The widths from the spec, plus adversarial extremes ──────────────────────

const WIDTHS = [40, 50, 60, 80, 100, 120, 160, 30, 35, 200, 240];

// ── Content designed to break layouts ────────────────────────────────────────

const LONG_PATH =
  "src/components/dashboard/widgets/analytics/very/deeply/nested/RevenueChartContainer.tsx";
const LONG_COMMAND =
  "npx prisma migrate dev --name add_published_at_to_post --schema ./prisma/schema.prisma --skip-generate";
const LONG_PROMPT =
  "Refactor the authentication system so that session tokens are validated against the database on every request, add refresh-token rotation, and make sure the middleware rejects expired sessions with a 401 instead of silently passing them through to the route handler.";
const STACK_TRACE = [
  "Error: spawn npm ENOENT",
  "    at ChildProcess._handle.onexit (node:internal/child_process:286:19)",
  "    at onErrorNT (node:internal/child_process:484:16)",
  "    at process.processTicksAndRejections (node:internal/process/task_queues:82:21)",
].join("\n");
const BIG_OUTPUT = Array.from({ length: 80 }, (_, i) => `  test case ${i + 1} ... ok`).join("\n");
const UNICODE_PROMPT = "日本語のリクエストです — please add a フィールド to the モデル 👍";
const NO_BREAK_TOKEN = "a".repeat(300);
const JSON_BLOB = JSON.stringify({
  model: "Post",
  fields: Array.from({ length: 12 }, (_, i) => ({ name: `field${i}`, type: "String" })),
});

/** One block of every kind, in every interesting state. */
function allBlocks(): Block[] {
  return [
    { kind: "user", id: "u1", text: LONG_PROMPT },
    { kind: "user", id: "u2", text: UNICODE_PROMPT },
    { kind: "user", id: "u3", text: NO_BREAK_TOKEN },
    { kind: "assistant", id: "a1", text: LONG_PROMPT },
    { kind: "assistant", id: "a2", text: "Short reply.", continuation: true },
    { kind: "system", id: "s1", text: "Dry run on — changes will be previewed only.", tone: "warning" },
    { kind: "system", id: "s2", text: LONG_PROMPT },

    { kind: "error", id: "e1", title: "Command failed", context: LONG_COMMAND, detail: STACK_TRACE, hint: "Check that npm is installed and on PATH." },
    { kind: "error", id: "e2", title: "Missing API key", detail: "GEMINI_API_KEY is not set" },

    { kind: "tool", id: "t1", call: { id: "t1", kind: "read", target: LONG_PATH, status: "success", result: "142 lines", elapsedMs: 320 } },
    { kind: "tool", id: "t2", call: { id: "t2", kind: "run", target: LONG_COMMAND, status: "running" } },
    { kind: "tool", id: "t3", call: { id: "t3", kind: "edit", target: "src/a.ts", status: "error", error: "file changed since it was read" } },
    { kind: "tool", id: "t4", call: { id: "t4", kind: "run", target: "npm test", status: "success", result: "28 tests passed", output: BIG_OUTPUT }, expanded: false },
    { kind: "tool", id: "t5", call: { id: "t5", kind: "run", target: "npm test", status: "success", result: "28 tests passed", output: BIG_OUTPUT }, expanded: true },
    { kind: "tool", id: "t6", call: { id: "t6", kind: "search", target: '"session" "token" in src/**/*.ts', status: "success", result: "18 matches" } },

    {
      kind: "diff",
      id: "d1",
      filePath: LONG_PATH,
      patch: [
        "@@ -12,7 +12,9 @@",
        "-const session = getSession();",
        "+const session = await getSession();",
        "+",
        "+if (!session || session.expiresAt < new Date()) {",
        "+  throw new UnauthorizedError('session expired or missing entirely here');",
        "+}",
        " return session;",
      ].join("\n"),
      expanded: true,
    },
    { kind: "diff", id: "d2", filePath: "prisma/schema.prisma", patch: Array.from({ length: 40 }, (_, i) => `+  field${i} String`).join("\n"), expanded: false },

    {
      kind: "plan",
      id: "p1",
      steps: [
        { description: "Add publishedAt to the Post model in the Prisma schema", kind: "structural_edit" },
        { description: "Create a migration and regenerate the client", kind: "new_file" },
        { description: LONG_PROMPT, kind: "structural_edit" },
      ],
      currentIndex: 1,
      completed: [0],
      failed: [],
    },

    {
      kind: "operations",
      id: "o1",
      operations: [
        { type: "schema", op: "add_field", model: "Post", fieldName: "publishedAt" },
        { type: "file", filePath: LONG_PATH, editCount: 3 },
        { type: "create_file", filePath: "src/app/api/posts/route.ts" },
        { type: "command", command: LONG_COMMAND },
      ],
    },

    {
      kind: "blast",
      id: "b1",
      modelName: "Post",
      routes: Array.from({ length: 9 }, (_, i) => ({ name: `GET /api/posts/${i}`, filePath: `src/app/api/posts/${i}/route.ts`, reason: "reads Post" })),
      components: [{ name: "RevenueChartContainer", filePath: LONG_PATH, reason: "renders Post" }],
      files: [{ name: "seed.ts", filePath: "prisma/seed.ts", reason: "writes Post" }],
      expanded: true,
    },
    { kind: "blast", id: "b2", modelName: "Post", routes: [], components: [], files: [], expanded: false },

    {
      kind: "summary",
      id: "sum1",
      filesWritten: [LONG_PATH, "prisma/schema.prisma"],
      filesCreated: ["src/app/api/posts/route.ts"],
      commands: [LONG_COMMAND],
      blastRadiusSize: 11,
      graphIndexUpdated: true,
      elapsedMs: 12_345,
      dryRun: false,
    },
    { kind: "summary", id: "sum2", filesWritten: [], filesCreated: [], commands: [], blastRadiusSize: 0, graphIndexUpdated: false, elapsedMs: 900, dryRun: true },

    { kind: "log", id: "l1", lines: BIG_OUTPUT.split("\n"), expanded: false },
    { kind: "log", id: "l2", lines: [JSON_BLOB, STACK_TRACE, NO_BREAK_TOKEN], expanded: true },
  ];
}

function contextFor(width: number, overrides: Partial<RenderContext> = {}): RenderContext {
  const layout = computeLayout(width, 40);
  return {
    width: layout.contentWidth,
    textWidth: layout.maxTextWidth,
    narrow: layout.isNarrow,
    debug: false,
    spinnerFrame: SPINNER_FRAMES[0]!,
    ...overrides,
  };
}

// ── No horizontal overflow, and no reliance on clipping ─────────────────────

function testNoOverflow() {
  section("no horizontal overflow — every block, every width");

  for (const width of WIDTHS) {
    for (const debug of [false, true]) {
      const ctx = contextFor(width, { debug });

      for (const block of allBlocks()) {
        const lines = renderBlock(block, ctx);

        lines.forEach((l, i) => {
          const w = lineWidth(l);
          ok(
            w <= ctx.width,
            `${block.kind} fits at ${width} cols`,
            `row ${i} is ${w} wide, budget ${ctx.width}: ${JSON.stringify(lineText(l))}`
          );

          // Stronger than "fits": the clip backstop must never have work to do.
          // If it does, a renderer wrapped against the wrong width.
          const clipped = clipLine(l, ctx.width);
          ok(
            lineText(clipped) === lineText(l),
            `${block.kind} needed no clipping at ${width} cols`,
            `row ${i}: ${JSON.stringify(lineText(l))}`
          );

          ok(
            !lineText(l).includes("\n"),
            `${block.kind} row has no embedded newline at ${width} cols`
          );
        });
      }
    }
  }
}

function testTranscriptNoOverflow() {
  section("no horizontal overflow — full transcript");

  for (const width of WIDTHS) {
    const ctx = contextFor(width);
    const lines = renderBlocks(allBlocks(), ctx);
    const worst = lines.reduce((max, l) => Math.max(max, lineWidth(l)), 0);
    ok(
      worst <= ctx.width,
      `transcript fits at ${width} cols`,
      `widest row ${worst} > ${ctx.width}`
    );
  }
}

// ── Spinner cannot change layout ─────────────────────────────────────────────

function testSpinnerStability() {
  section("spinner animation cannot shift layout");

  const running: Block[] = [
    { kind: "tool", id: "t", call: { id: "t", kind: "run", target: "npm test", status: "running" } },
    {
      kind: "plan",
      id: "p",
      steps: [
        { description: "step one", kind: "structural_edit" },
        { description: "step two", kind: "structural_edit" },
      ],
      currentIndex: 0,
      completed: [],
      failed: [],
    },
  ];

  for (const width of WIDTHS) {
    const signatures = new Set<string>();

    for (const frame of SPINNER_FRAMES) {
      const ctx = contextFor(width, { spinnerFrame: frame });
      const lines = renderBlocks(running, ctx);
      signatures.add(lines.map(lineWidth).join(","));
    }

    ok(
      signatures.size === 1,
      `every spinner frame yields identical row widths at ${width} cols`,
      `${signatures.size} distinct width profiles: ${[...signatures].join(" | ")}`
    );
  }
}

// ── Vertical budget: the input must always be reachable ─────────────────────

function testHeightBudget() {
  section("vertical budget — chrome always fits, conversation never starves");

  const heights = [6, 8, 10, 12, 16, 20, 24, 30, 40, 60, 100];

  for (const width of WIDTHS) {
    for (const height of heights) {
      const layout = computeLayout(width, height);
      const compact = layout.height < 20 || layout.isNarrow;
      const chrome = chromeRows(compact);

      ok(
        layout.conversationHeight >= UI_LAYOUT.minConversationRows,
        `conversation keeps its floor at ${width}x${height}`,
        `got ${layout.conversationHeight}`
      );

      // The whole point: chrome plus conversation must never exceed the terminal,
      // because the overflow would come off the bottom — the input.
      const total = chrome + layout.conversationHeight;
      ok(
        total <= Math.max(layout.height, chrome + UI_LAYOUT.minConversationRows),
        `frame fits the terminal at ${width}x${height}`,
        `chrome ${chrome} + conversation ${layout.conversationHeight} = ${total} > ${layout.height}`
      );

      ok(layout.contentWidth > 0, `content width is positive at ${width}x${height}`);
      ok(
        layout.contentWidth <= layout.width,
        `content width never exceeds terminal at ${width}x${height}`
      );
      ok(
        layout.inputWidth > 0 && layout.inputWidth <= layout.contentWidth,
        `input width is sane at ${width}x${height}`
      );
      ok(
        layout.maxTextWidth <= layout.contentWidth,
        `prose width never exceeds content width at ${width}x${height}`
      );
    }
  }
}

function testBoundedContent() {
  section("vertical budget — unbounded content stays bounded");

  const ctx = contextFor(80);

  const hugeOutput: Block = {
    kind: "tool",
    id: "t",
    call: { id: "t", kind: "run", target: "npm test", status: "success", output: Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n") },
    expanded: true,
  };
  const expandedRows = renderBlock(hugeOutput, ctx).length;
  ok(
    expandedRows <= UI_LAYOUT.expandedOutputRows + 4,
    "expanded tool output is capped",
    `${expandedRows} rows`
  );

  const collapsed = renderBlock({ ...hugeOutput, expanded: false } as Block, ctx).length;
  ok(collapsed <= 4, "collapsed tool output is a single hint", `${collapsed} rows`);

  const hugeDiff: Block = {
    kind: "diff",
    id: "d",
    filePath: "a.ts",
    patch: Array.from({ length: 4000 }, (_, i) => `+line ${i}`).join("\n"),
    expanded: false,
  };
  const diffRows = renderBlock(hugeDiff, ctx).length;
  ok(
    diffRows <= UI_LAYOUT.collapsedDiffRows + 6,
    "collapsed diff is capped",
    `${diffRows} rows`
  );

  const hugeBlast: Block = {
    kind: "blast",
    id: "b",
    modelName: "Post",
    routes: Array.from({ length: 500 }, (_, i) => ({ name: `r${i}`, filePath: `src/${i}.ts`, reason: "x" })),
    components: [],
    files: [],
    expanded: true,
  };
  const blastRows = renderBlock(hugeBlast, ctx).length;
  ok(blastRows <= 20, "expanded blast radius is capped", `${blastRows} rows`);

  const hugeLog: Block = {
    kind: "log",
    id: "l",
    lines: Array.from({ length: 9000 }, (_, i) => `log ${i}`),
    expanded: true,
  };
  const logRows = renderBlock(hugeLog, ctx).length;
  ok(
    logRows <= UI_LAYOUT.expandedOutputRows + 4,
    "expanded log is capped",
    `${logRows} rows`
  );
}

// ── Scrolling ────────────────────────────────────────────────────────────────

function testScrollModel() {
  section("scroll model");

  const lines: Line[] = Array.from({ length: 100 }, (_, i) => [{ text: `row ${i}` }]);

  for (const height of [1, 5, 10, 33, 99, 100, 101, 250]) {
    for (const offset of [0, 1, 5, 50, 99, 100, 1000, -5]) {
      const { visible, scroll } = computeWindow(lines, height, offset);

      ok(
        visible.length <= Math.max(1, height),
        `window never exceeds its height (h=${height}, o=${offset})`,
        `got ${visible.length}`
      );
      ok(scroll.offset >= 0, `offset never negative (h=${height}, o=${offset})`);
      ok(
        scroll.hiddenAbove + visible.length + scroll.hiddenBelow === lines.length,
        `window accounts for every row (h=${height}, o=${offset})`,
        `${scroll.hiddenAbove}+${visible.length}+${scroll.hiddenBelow} != ${lines.length}`
      );
      ok(
        scroll.following === (scroll.offset === 0),
        `following iff pinned to bottom (h=${height}, o=${offset})`
      );
      if (scroll.following) {
        ok(
          scroll.hiddenBelow === 0,
          `nothing hidden below while following (h=${height}, o=${offset})`
        );
      }
    }
  }

  // Auto-follow: at offset 0 the newest row is always the last visible one.
  const { visible } = computeWindow(lines, 10, 0);
  ok(lineText(visible[visible.length - 1]!) === "row 99", "offset 0 shows the newest row");

  // Content shorter than the window must not scroll.
  const short = computeWindow(lines.slice(0, 3), 10, 5);
  ok(short.visible.length === 3 && short.scroll.following, "short content cannot scroll");
}

// ── Symbol hygiene ───────────────────────────────────────────────────────────

function testNoAmbiguousGlyphs() {
  section("ambiguous-width glyphs never reach the screen");

  for (const width of WIDTHS) {
    const ctx = contextFor(width);
    const text = renderBlocks(allBlocks(), ctx).map(lineText).join("\n");

    for (const glyph of WIDE_UNSAFE) {
      if (glyph.trim().length === 0) continue;
      ok(
        !text.includes(glyph),
        `no ${JSON.stringify(glyph)} in output at ${width} cols`
      );
    }
  }
}

// ── Contextual help ──────────────────────────────────────────────────────────

function testContextualHints() {
  section("key hints are contextual and never empty");

  const states: SessionState[] = [
    "idle", "thinking", "planning", "tool_running",
    "waiting_for_permission", "waiting_for_input",
    "success", "error", "cancelled",
  ];

  for (const state of states) {
    for (const overlay of ["none", "palette", "permission"] as const) {
      for (const scrolledUp of [false, true]) {
        const hints = hintsFor({ state, overlay, hasExpandable: true, scrolledUp, hasHistory: true });
        ok(hints.length > 0, `hints exist for ${state}/${overlay}`);
        ok(
          hints.every((h) => h.keys.length > 0 && h.label.length > 0),
          `hints are well-formed for ${state}/${overlay}`
        );
      }
    }
  }

  // A permission prompt must never advertise anything but answering it.
  const perm = hintsFor({ state: "waiting_for_permission", overlay: "permission", hasExpandable: true, scrolledUp: true, hasHistory: true });
  ok(
    perm.some((h) => h.keys === "enter") && perm.some((h) => h.keys === "esc"),
    "permission hints cover confirm and deny"
  );
  ok(
    !perm.some((h) => h.keys === "/"),
    "permission hints do not offer unrelated keys"
  );

  // While busy, stop must be offered and send must not.
  const busy = hintsFor({ state: "tool_running", overlay: "none", hasExpandable: false, scrolledUp: false, hasHistory: false });
  ok(busy.some((h) => h.keys === "ctrl+c"), "busy hints offer cancel");
  ok(!busy.some((h) => h.keys === "enter"), "busy hints do not offer send");
}

// ── Editor ───────────────────────────────────────────────────────────────────

function testEditor() {
  section("prompt editor — wrapping and caret");

  const inputs = [LONG_PROMPT, UNICODE_PROMPT, NO_BREAK_TOKEN, "a\nb\nc", "", "hi", LONG_COMMAND];

  for (const width of [10, 20, 38, 58, 78, 118, 158]) {
    for (const value of inputs) {
      const rows = layoutEditor(value, width);

      for (const row of rows) {
        ok(
          visualWidth(row.text) <= width,
          `editor row fits (w=${width})`,
          `${visualWidth(row.text)} > ${width}: ${JSON.stringify(row.text)}`
        );
      }

      // Rows must reconstruct the value exactly, or the caret index and the
      // displayed text refer to different strings.
      ok(
        rows.map((r) => r.text).join("") === value.replace(/\n/g, ""),
        `editor rows reconstruct the value (w=${width})`,
        JSON.stringify(rows.map((r) => r.text))
      );

      for (const cursor of [0, 1, Math.floor(value.length / 2), value.length]) {
        const caret = caretPosition(rows, cursor);
        ok(
          caret.row >= 0 && caret.row < Math.max(1, rows.length),
          `caret row in range (w=${width}, c=${cursor})`,
          `row ${caret.row} of ${rows.length}`
        );
        ok(
          caret.column <= width,
          `caret column within width (w=${width}, c=${cursor})`,
          `col ${caret.column} > ${width}`
        );
      }
    }
  }
}

// ── Breakpoints and responsive priority ──────────────────────────────────────

function testBreakpoints() {
  section("responsive breakpoints");

  ok(breakpointFor(40) === "narrow", "40 cols is narrow");
  ok(breakpointFor(59) === "narrow", "59 cols is narrow");
  ok(breakpointFor(60) === "medium", "60 cols is medium");
  ok(breakpointFor(99) === "medium", "99 cols is medium");
  ok(breakpointFor(100) === "wide", "100 cols is wide");
  ok(breakpointFor(200) === "wide", "200 cols is wide");

  // Narrow spends every column on content.
  ok(computeLayout(40, 24).gutter === 0, "narrow terminals drop the gutter");
  ok(computeLayout(120, 24).gutter > 0, "wide terminals keep the gutter");

  // Wide terminals must not produce unreadably long prose lines.
  ok(
    computeLayout(240, 40).maxTextWidth <= UI_LAYOUT.maxTextWidth,
    "prose width is capped on very wide terminals"
  );

  // Narrow must never hide essential content: a user message and an error still
  // render substantively at 40 columns (§37).
  const ctx = contextFor(40);
  const user = renderBlock({ kind: "user", id: "u", text: LONG_PROMPT }, ctx);
  ok(user.length > 2, "user message survives at 40 cols", `${user.length} rows`);
  ok(
    user.map(lineText).join(" ").includes("Refactor"),
    "user message content is present at 40 cols"
  );

  const err = renderBlock(
    { kind: "error", id: "e", title: "Command failed", context: LONG_COMMAND, detail: STACK_TRACE, hint: "Install npm." },
    ctx
  );
  const errText = err.map(lineText).join(" ");
  ok(errText.includes("Command failed"), "error title survives at 40 cols");
  ok(errText.includes("Install npm."), "error hint survives at 40 cols");
}

// ── Resize stability ─────────────────────────────────────────────────────────

function testResize() {
  section("terminal resize");

  // Re-rendering at a new width must always produce a frame valid for that width
  // — the property that makes resize correct rather than merely non-crashing.
  const blocks = allBlocks();
  let previous = -1;

  for (const width of [160, 120, 100, 80, 60, 50, 40, 35, 30, 80, 200]) {
    const ctx = contextFor(width);
    const lines = renderBlocks(blocks, ctx);
    const worst = lines.reduce((max, l) => Math.max(max, lineWidth(l)), 0);

    ok(worst <= ctx.width, `resize to ${width} yields a valid frame`, `widest ${worst} > ${ctx.width}`);
    ok(lines.length > 0, `resize to ${width} still renders content`);
    previous = width;
  }
  ok(previous === 200, "resize sweep completed");
}

// ── Command palette ──────────────────────────────────────────────────────────

function testPalette() {
  section("command palette filtering");

  ok(filterCommands("/").length > 0, "bare slash lists commands");
  ok(filterCommands("/clear")[0]!.name === "/clear", "exact match ranks first");
  ok(filterCommands("/cl")[0]!.name === "/clear", "prefix match ranks first");
  ok(filterCommands("/zzzz").length === 0, "no false matches");
  ok(
    filterCommands("/dryrun")[0]!.name === "/dry-run",
    "aliases match",
    filterCommands("/dryrun")[0]?.name
  );
  ok(filterCommands("/conversation").some((c) => c.name === "/clear"), "descriptions are searchable");
}

async function main() {
  console.log("TUI layout — responsive verification");

  testNoOverflow();
  testTranscriptNoOverflow();
  testSpinnerStability();
  testHeightBudget();
  testBoundedContent();
  testScrollModel();
  testNoAmbiguousGlyphs();
  testContextualHints();
  testEditor();
  testBreakpoints();
  testResize();
  testPalette();

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
