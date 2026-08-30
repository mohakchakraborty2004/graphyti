/**
 * Visual snapshots.
 *
 * The layout suite proves invariants; this proves the result is *legible*. It
 * renders the real component tree through Ink's `renderToString` at a given width
 * and prints it with a ruler, so the output can be read the way a user would see
 * it — and so a regression in visual hierarchy shows up as a diff rather than as
 * a passing test.
 *
 *   npx tsx src/scripts/tui-snapshot.ts [width] [scene]
 *   npx tsx src/scripts/tui-snapshot.ts all
 */

import React from "react";
import { Box, renderToString } from "ink";
import { Header } from "../tui/components/layout/Header";
import { StatusBar, HelpBar } from "../tui/components/layout/StatusBar";
import { WelcomeScreen } from "../tui/components/layout/WelcomeScreen";
import { PromptEditor, MAX_EDITOR_ROWS } from "../tui/components/layout/PromptEditor";
import { PermissionPrompt } from "../tui/components/interactive/PermissionPrompt";
import { CommandPalette } from "../tui/components/interactive/CommandPalette";
import { Lines, Divider } from "../tui/components/primitives";
import { renderBlocks } from "../tui/render/blocks";
import { computeLayout, chromeBudget } from "../tui/core/layout";
import { computeWindow } from "../tui/core/scroll";
import { editorRowCount } from "../tui/core/editor";
import { layoutPermission } from "../tui/core/permission";
import { visualWidth, stripAnsi } from "../tui/core/text";
import { SPINNER_FRAMES } from "../tui/theme/tokens";
import type { Block, PermissionRequest } from "../tui/state/types";
import type { SessionInfo } from "../tui/layout/useSessionInfo";

const INFO: SessionInfo = {
  cwd: "~/projects/storefront",
  git: { branch: "main", dirty: true, ahead: 2, behind: 0 },
  version: "1.0.0",
  model: "configured-model",
};

// ── Scenes ───────────────────────────────────────────────────────────────────

const CONVERSATION: Block[] = [
  { kind: "user", id: "u1", text: "Add a publishedAt timestamp to Post and expose it on the posts API." },
  {
    kind: "assistant",
    id: "a1",
    text: "I'll check how Post is used before changing the schema, so I can update the routes that read it in the same pass.",
  },
  { kind: "tool", id: "t1", call: { id: "t1", kind: "search", target: "Post model references", status: "success", result: "18 matches", elapsedMs: 240 } },
  { kind: "tool", id: "t2", call: { id: "t2", kind: "read", target: "prisma/schema.prisma", status: "success", result: "84 lines", elapsedMs: 12 } },
  {
    kind: "operations",
    id: "o1",
    operations: [
      { type: "schema", op: "add_field", model: "Post", fieldName: "publishedAt" },
      { type: "file", filePath: "src/app/api/posts/route.ts", editCount: 2 },
      { type: "create_file", filePath: "src/lib/posts/serialize.ts" },
    ],
  },
  {
    kind: "diff",
    id: "d1",
    filePath: "prisma/schema.prisma",
    patch: [
      "@@ model Post @@",
      "   title       String",
      "   body        String",
      "+  publishedAt DateTime?",
      "   createdAt   DateTime @default(now())",
    ].join("\n"),
    expanded: true,
  },  { kind: "tool", id: "t3", call: { id: "t3", kind: "edit", target: "src/app/api/posts/route.ts", status: "success", result: "2 edits", elapsedMs: 30 } },
  { kind: "tool", id: "t4", call: { id: "t4", kind: "run", target: "npm test", status: "success", result: "28 tests passed", output: "PASS src/posts.test.ts\nPASS src/auth.test.ts", elapsedMs: 4200 } },
  {
    kind: "summary",
    id: "s1",
    filesWritten: ["prisma/schema.prisma", "src/app/api/posts/route.ts"],
    filesCreated: ["src/lib/posts/serialize.ts"],
    commands: ["npx prisma generate"],
    blastRadiusSize: 4,
    graphIndexUpdated: true,
    elapsedMs: 18_400,
    dryRun: false,
  },
];

const RUNNING: Block[] = [
  { kind: "user", id: "u1", text: "Rename User.email to User.emailAddress everywhere." },
  { kind: "assistant", id: "a1", text: "That renames a field other code depends on, so I'll map the blast radius first." },
  { kind: "tool", id: "t1", call: { id: "t1", kind: "analyze", target: "blast radius", status: "warning", result: "11 downstream items", elapsedMs: 890 } },
  {
    kind: "blast",
    id: "b1",
    modelName: "User",
    routes: [
      { name: "POST /api/auth/login", filePath: "src/app/api/auth/login/route.ts", reason: "reads User.email" },
      { name: "GET /api/users/[id]", filePath: "src/app/api/users/[id]/route.ts", reason: "selects User.email" },
    ],
    components: [{ name: "AccountSettingsForm", filePath: "src/components/account/AccountSettingsForm.tsx", reason: "renders User.email" }],
    files: [{ name: "seed.ts", filePath: "prisma/seed.ts", reason: "writes User.email" }],
    expanded: true,
  },
  {
    kind: "plan",
    id: "p1",
    steps: [
      { description: "Rename the field in the Prisma schema", kind: "structural_edit" },
      { description: "Update the four API routes that select it", kind: "structural_edit" },
      { description: "Add a migration", kind: "new_file" },
    ],
    currentIndex: 1,
    completed: [0],
    failed: [],
  },
  { kind: "tool", id: "t2", call: { id: "t2", kind: "edit", target: "src/app/api/auth/login/route.ts", status: "running" } },
];

const ERROR_SCENE: Block[] = [
  { kind: "user", id: "u1", text: "Run the build." },
  {
    kind: "error",
    id: "e1",
    title: "Command failed",
    context: "npm run build",
    detail: "spawn npm ENOENT",
    hint: "Check that npm is installed and available on PATH, then try again.",
  },
];

const PERMISSION: PermissionRequest = {
  id: "p1",
  title: "Breaking schema change",
  subject: "npx prisma migrate dev --name rename_user_email --schema ./prisma/schema.prisma",
  consequence: "11 downstream files reference User.email and may stop compiling until they are updated.",
  question: "Write these changes anyway?",
  danger: true,
};

// ── Frame assembly ───────────────────────────────────────────────────────────

type Scene =
  | "welcome"
  | "conversation"
  | "running"
  | "error"
  | "permission"
  | "palette";

function frame(scene: Scene, width: number, height: number) {
  const layout = computeLayout(width, height);
  const spinnerFrame = SPINNER_FRAMES[2]!;

  const ctx = {
    width: layout.contentWidth,
    textWidth: layout.maxTextWidth,
    narrow: layout.isNarrow,
    debug: false,
    spinnerFrame,
  };

  const blocks =
    scene === "conversation"
      ? CONVERSATION
      : scene === "running" || scene === "permission"
        ? RUNNING
        : scene === "error"
          ? ERROR_SCENE
          : [];

  const state =
    scene === "running"
      ? ("tool_running" as const)
      : scene === "permission"
        ? ("waiting_for_permission" as const)
        : scene === "error"
          ? ("error" as const)
          : ("idle" as const);

  const activity =
    scene === "running"
      ? "Updating src/app/api/auth/login/route.ts"
      : scene === "permission"
        ? "Waiting for permission"
        : null;

  const input = scene === "palette" ? "/d" : "";

  // Mirror the App's height budget exactly, so a snapshot shows the frame the
  // user would actually see rather than an unbounded transcript. Getting this
  // wrong is what makes a "looks fine" snapshot hide a scrolled-away prompt.
  const chrome = chromeBudget(layout.compact);
  const overlayRows =
    scene === "permission"
      ? layoutPermission(PERMISSION, layout.contentWidth, layout.isNarrow).height + 1
      : scene === "palette"
        ? 5
        : 0;
  const inputRows = editorRowCount(input, layout.inputWidth, MAX_EDITOR_ROWS);
  const conversationHeight = Math.max(
    1,
    layout.height -
      chrome.header -
      chrome.status -
      chrome.help -
      overlayRows -
      inputRows -
      (layout.compact ? 1 : 2)
  );

  const allLines = renderBlocks(blocks, ctx);
  const { visible, markers, scroll } = computeWindow(allLines, conversationHeight, 0);

  return (
    <Box flexDirection="column" paddingX={layout.gutter} width={layout.width}>
      <Header info={INFO} layout={layout} compact={layout.compact} dryRun={false} />

      {scene === "welcome" ? (
        <Box flexDirection="column" marginTop={layout.compact ? 0 : 1}>
          <WelcomeScreen layout={layout} dryRun={false} />
        </Box>
      ) : (
        <Box flexDirection="column">
          {markers.above && (
            <Lines
              lines={[[{ text: `↑ ${scroll.hiddenAbove} more lines`, color: "gray", dim: true }]]}
              width={layout.contentWidth}
            />
          )}
          <Lines lines={visible} width={layout.contentWidth} />
        </Box>
      )}

      <Box flexDirection="column" marginTop={layout.compact ? 0 : 1}>
        <StatusBar
          state={state}
          activity={activity}
          elapsedMs={7300}
          spinnerFrame={spinnerFrame}
          width={layout.contentWidth}
          narrow={layout.isNarrow}
        />

        {scene === "permission" && (
          <Box marginTop={1}>
            <PermissionPrompt
              request={PERMISSION}
              onDecide={() => {}}
              width={layout.contentWidth}
              narrow={layout.isNarrow}
              active={false}
            />
          </Box>
        )}

        {scene === "palette" && (
          <Box marginTop={1}>
            <CommandPalette
              query={input}
              selectedIndex={0}
              width={layout.contentWidth}
              narrow={layout.isNarrow}
            />
          </Box>
        )}

        {!layout.compact && <Divider width={layout.contentWidth} />}

        <PromptEditor
          draft={{ value: input, cursor: input.length }}
          onEdit={() => {}}
          onSubmit={() => {}}
          onHistory={() => null}
          width={layout.inputWidth}
          active={scene !== "permission"}
          placeholder={state === "idle" ? "Describe a change, or / for commands" : ""}
        />

        <HelpBar
          ctx={{
            state,
            overlay: scene === "permission" ? "permission" : scene === "palette" ? "palette" : "none",
            hasExpandable: blocks.length > 0,
            scrolledUp: false,
            hasHistory: scene === "conversation",
          }}
          width={layout.contentWidth}
          compact={layout.compact}
        />
      </Box>
    </Box>
  );
}

// ── Output ───────────────────────────────────────────────────────────────────

function ruler(width: number): string {
  let out = "";
  for (let i = 1; i <= width; i++) {
    out += i % 10 === 0 ? String((i / 10) % 10) : i % 5 === 0 ? "+" : "·";
  }
  return out;
}

function show(scene: Scene, width: number, height: number) {
  const output = renderToString(frame(scene, width, height), { columns: width });
  const rows = output.split("\n");

  console.log(`\n${"═".repeat(width)}`);
  console.log(`${scene}  ${width}x${height}`);
  console.log(ruler(width));

  let overflow = 0;
  for (const row of rows) {
    const w = visualWidth(stripAnsi(row));
    if (w > width) {
      overflow++;
      console.log(`${row}  <<< OVERFLOW ${w}/${width}`);
    } else {
      console.log(row);
    }
  }

  console.log(ruler(width));
  const status =
    overflow > 0
      ? `${overflow} OVERFLOWING ROW(S)`
      : rows.length > height
        ? `${rows.length} rows > ${height} available`
        : "fits";
  console.log(`${rows.length} rows  ${status}`);
  return { overflow, rows: rows.length };
}

const SCENES: Scene[] = ["welcome", "conversation", "running", "error", "permission", "palette"];

function main() {
  const [arg1, arg2] = process.argv.slice(2);

  if (arg1 === "all" || arg1 === undefined) {
    let bad = 0;
    for (const width of [40, 60, 80, 120]) {
      for (const scene of SCENES) {
        const r = show(scene, width, width < 60 ? 24 : 32);
        if (r.overflow > 0) bad++;
      }
    }
    console.log(`\n${bad === 0 ? "no overflow in any scene" : `${bad} scenes overflowed`}`);
    process.exit(bad === 0 ? 0 : 1);
  }

  const width = Number.parseInt(arg1, 10) || 80;
  const scene = (arg2 as Scene) ?? "conversation";
  show(scene, width, 32);
}

main();
