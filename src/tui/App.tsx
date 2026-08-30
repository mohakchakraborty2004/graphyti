/**
 * App shell.
 *
 * Deliberately thin. It owns the fixed layout, routes keyboard input to whatever
 * currently owns it, and bridges the pipeline runner to the store. It renders no
 * content itself and computes no widths of its own — those belong to the block
 * renderers and `useTerminalLayout` respectively.
 *
 * The frame is assembled in the order §26 requires: chrome is reserved first and
 * the conversation takes what is left, which is what structurally prevents a
 * large diff or a wall of tool output from pushing the prompt off screen.
 */

import React from "react";
import { Box, Text, useApp, useInput } from "ink";
import { UI_COLORS } from "./theme/tokens";
import { useTerminalLayout, chromeBudget } from "./layout/useTerminalLayout";
import { useSessionInfo } from "./layout/useSessionInfo";
import { useSession } from "./state/useSession";
import { isBusy, type Block, type PermissionRequest } from "./state/types";
import { renderBlock, renderBlocks, type RenderContext } from "./render/blocks";
import { blank, type Line } from "./core/line";
import { computeWindow } from "./core/scroll";
import { editorRowCount } from "./core/editor";
import { layoutPermission } from "./core/permission";
import { filterCommands } from "./core/commands";
import { Divider, Lines, useSpinnerFrame } from "./components/primitives";
import { Header } from "./components/layout/Header";
import { Conversation } from "./components/layout/Conversation";
import { StatusBar, HelpBar } from "./components/layout/StatusBar";
import { WelcomeScreen } from "./components/layout/WelcomeScreen";
import { PromptEditor, MAX_EDITOR_ROWS, type Draft } from "./components/layout/PromptEditor";
import { PermissionPrompt } from "./components/interactive/PermissionPrompt";
import { CommandPalette } from "./components/interactive/CommandPalette";
import { useSelection } from "./components/interactive/Selector";
import { runPipeline, CancelledError } from "./engine/runPipeline";

export interface AppProps {
  dryRun: boolean;
  autoConfirm: boolean;
  legacyContext: boolean;
  version: string;
  model: string;
}

export function App({
  dryRun: initialDryRun,
  autoConfirm,
  legacyContext,
  version,
  model,
}: AppProps) {
  const { exit } = useApp();
  const layout = useTerminalLayout();
  const info = useSessionInfo(version, model);
  const { session, dispatch, addTool, patchTool } = useSession();

  const [dryRun, setDryRun] = React.useState(initialDryRun);
  // One piece of state, updated functionally. Ink dispatches every key parsed
  // from a single stdin chunk in the same tick, so two independent setters (or a
  // props-derived next value) would drop all but the last keystroke of a burst.
  const [draft, setDraft] = React.useState<Draft>({ value: "", cursor: 0 });
  const input = draft.value;
  const [scrollOffset, setScrollOffset] = React.useState(0);
  const [historyIndex, setHistoryIndex] = React.useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = React.useState(0);

  const abortRef = React.useRef<AbortController | null>(null);
  const decisionRef = React.useRef<((allowed: boolean) => void) | null>(null);
  const runStartRef = React.useRef(0);

  const busy = isBusy(session.state);
  const spinnerFrame = useSpinnerFrame(busy);

  const paletteOpen = input.startsWith("/") && !busy;
  const paletteMatches = React.useMemo(
    () => (paletteOpen ? filterCommands(input) : []),
    [paletteOpen, input]
  );
  const palette = useSelection(paletteMatches.length, input);

  const overlay: "none" | "palette" | "permission" = session.permission
    ? "permission"
    : paletteOpen
      ? "palette"
      : "none";

  // ── Elapsed timer ──────────────────────────────────────────────────────────
  // Ticks only while busy, at 10Hz — fast enough to feel live, slow enough not
  // to spend a frame per animation step.
  React.useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      setElapsedMs(Date.now() - runStartRef.current);
    }, 100);
    return () => clearInterval(timer);
  }, [busy]);

  // ── Render context ─────────────────────────────────────────────────────────
  const ctx: RenderContext = React.useMemo(
    () => ({
      width: layout.contentWidth,
      textWidth: layout.maxTextWidth,
      narrow: layout.isNarrow,
      debug: session.debug,
      spinnerFrame,
    }),
    [layout.contentWidth, layout.maxTextWidth, layout.isNarrow, session.debug, spinnerFrame]
  );

  /**
   * Finalised history, grouped per block.
   *
   * Each entry keeps its own id so `<Static>` appends only what is new instead of
   * reflowing the whole transcript. Rows are re-derived when the width changes,
   * which is how a resize reflows history correctly.
   */
  const history = React.useMemo(
    () =>
      session.blocks.map((block) => ({
        id: block.id,
        lines: [...renderBlock(block, ctx), blank()],
      })),
    [session.blocks, ctx]
  );

  const liveLines: Line[] = React.useMemo(
    () => renderBlocks(session.live, ctx),
    [session.live, ctx]
  );

  // ── Height budget ──────────────────────────────────────────────────────────
  // Compact chrome is decided once, by the layout, so every consumer of the
  // height budget agrees with the components that draw into it.
  const { compact } = layout;
  const chrome = chromeBudget(compact);

  // Overlays are chrome too: reserving their rows is what stops a permission
  // prompt appearing from shoving the conversation upward.
  const overlayRows =
    overlay === "permission"
      ? layoutPermission(session.permission!, layout.contentWidth, layout.isNarrow).height + 1
      : overlay === "palette"
        ? Math.min(6, Math.max(1, paletteMatches.length)) + 3
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
      (compact ? 1 : 2)
  );

  const showWelcome = session.blocks.length === 0 && session.live.length === 0;
  const hasExpandable =
    session.live.some(isExpandable) || session.blocks.some(isExpandable);

  const { scroll } = computeWindow(liveLines, conversationHeight, scrollOffset);

  // ── Pipeline bridge ────────────────────────────────────────────────────────
  const submit = React.useCallback(
    async (raw: string) => {
      const query = raw.trim();
      if (query.length === 0 || busy) return;

      // Commit the previous turn to static history before starting a new one, so
      // the live frame only ever holds the current turn.
      dispatch({ type: "commitLive" });
      dispatch({ type: "pushHistory", value: query });
      dispatch({ type: "appendHistory", block: { kind: "user", id: `user-${Date.now()}`, text: query } });

      setDraft({ value: "", cursor: 0 });
      setHistoryIndex(null);
      setScrollOffset(0);
      runStartRef.current = Date.now();
      setElapsedMs(0);

      const controller = new AbortController();
      abortRef.current = controller;
      dispatch({ type: "state", state: "thinking" });

      try {
        const result = await runPipeline(
          query,
          { dryRun, autoConfirm, legacyContext, projectRoot: process.cwd() },
          {
            message: (text) => dispatch({ type: "appendLive", block: { kind: "assistant", id: id("assistant"), text } }),
            activity: (activity) => dispatch({ type: "activity", activity }),
            state: (state) => dispatch({ type: "state", state }),
            toolStart: (kind, target) => addTool(kind, target),
            toolUpdate: (toolId, patch) => patchTool(toolId, patch),
            operations: (operations) =>
              dispatch({
                type: "appendLive",
                block: { kind: "operations", id: id("ops"), operations: operations as never },
              }),
            plan: (steps) =>
              dispatch({
                type: "appendLive",
                block: { kind: "plan", id: "plan", steps, currentIndex: -1, completed: [], failed: [] },
              }),
            planProgress: (currentIndex, completed, failed) =>
              dispatch({
                type: "patchBlock",
                id: "plan",
                patch: { currentIndex, completed, failed } as never,
              }),
            blast: (results) => {
              for (const entry of results) {
                dispatch({
                  type: "appendLive",
                  block: { kind: "blast", id: id("blast"), ...entry },
                });
              }
            },
            diff: (filePath, patch) =>
              dispatch({
                type: "appendLive",
                block: { kind: "diff", id: id("diff"), filePath, patch },
              }),
            logs: (lines) =>
              dispatch({ type: "appendLive", block: { kind: "log", id: id("log"), lines } }),
            confirm: (request) =>
              new Promise<boolean>((resolve) => {
                const pending: PermissionRequest = { ...request, id: id("perm") };
                decisionRef.current = resolve;
                dispatch({ type: "state", state: "waiting_for_permission" });
                dispatch({ type: "permission", request: pending });
              }),
          },
          controller.signal
        );

        dispatch({
          type: "appendLive",
          block: {
            kind: "summary",
            id: id("summary"),
            filesWritten: result.filesWritten,
            filesCreated: result.filesCreated,
            commands: result.commands,
            blastRadiusSize: result.blastRadiusSize,
            graphIndexUpdated: result.graphIndexUpdated,
            elapsedMs: result.elapsedMs,
            dryRun,
          },
        });
        dispatch({ type: "state", state: "success" });
      } catch (error) {
        if (error instanceof CancelledError || controller.signal.aborted) {
          dispatch({
            type: "appendLive",
            block: { kind: "system", id: id("sys"), text: "Cancelled. Nothing further was written.", tone: "warning" },
          });
          dispatch({ type: "state", state: "cancelled" });
        } else {
          dispatch({ type: "appendLive", block: describeError(error) });
          dispatch({ type: "state", state: "error" });
        }
      } finally {
        abortRef.current = null;
        decisionRef.current = null;
        dispatch({ type: "permission", request: null });
        dispatch({ type: "activity", activity: null });
        // Return to idle so the prompt is always reachable — the old
        // implementation stopped at a terminal "done" state with no way back.
        dispatch({ type: "state", state: "idle" });
      }
    },
    [busy, dryRun, autoConfirm, legacyContext, dispatch, addTool, patchTool]
  );

  const decide = React.useCallback(
    (allowed: boolean) => {
      const resolve = decisionRef.current;
      decisionRef.current = null;
      dispatch({ type: "permission", request: null });
      dispatch({ type: "state", state: "thinking" });
      resolve?.(allowed);
    },
    [dispatch]
  );

  // ── Global keys ────────────────────────────────────────────────────────────
  // Registered before the editor's own handler and inactive while an overlay owns
  // the keyboard, so a keystroke is never handled twice.
  useInput(
    (inputChar, key) => {
      if (key.ctrl && inputChar === "c") {
        if (busy) {
          abortRef.current?.abort();
          decisionRef.current?.(false);
          return;
        }
        exit();
        return;
      }

      if (key.ctrl && inputChar === "o") {
        dispatch({ type: "expandLast" });
        return;
      }

      if (key.pageUp) {
        setScrollOffset((o) => o + Math.max(1, conversationHeight - 1));
        return;
      }
      if (key.pageDown) {
        setScrollOffset((o) => Math.max(0, o - Math.max(1, conversationHeight - 1)));
        return;
      }
      if (key.end && !busy && input.length === 0) {
        setScrollOffset(0);
        return;
      }
      if (key.escape && scrollOffset > 0) {
        setScrollOffset(0);
        return;
      }
    },
    { isActive: overlay !== "permission" }
  );

  // Palette navigation, active only while the palette owns the keyboard.
  useInput(
    (_inputChar, key) => {
      if (key.upArrow) return palette.move(-1);
      if (key.downArrow) return palette.move(1);
      if (key.escape) {
        setDraft({ value: "", cursor: 0 });
        return;
      }
      if (key.return) {
        const chosen = paletteMatches[palette.index];
        if (chosen) runCommand(chosen.name);
        return;
      }
    },
    { isActive: overlay === "palette" }
  );

  const runCommand = React.useCallback(
    (name: string) => {
      setDraft({ value: "", cursor: 0 });

      switch (name) {
        case "/clear":
          dispatch({ type: "clear" });
          setScrollOffset(0);
          return;
        case "/debug":
          dispatch({ type: "toggleDebug" });
          dispatch({
            type: "appendHistory",
            block: {
              kind: "system",
              id: id("sys"),
              text: session.debug ? "Debug detail hidden." : "Debug detail shown.",
            },
          });
          return;
        case "/dry-run": {
          // Compute the next value first, then dispatch. Dispatching from inside
          // a state updater makes the updater impure — React may invoke it more
          // than once, duplicating the message.
          const next = !dryRun;
          setDryRun(next);
          dispatch({
            type: "appendHistory",
            block: {
              kind: "system",
              id: id("sys"),
              text: next
                ? "Dry run on — changes will be previewed, not written."
                : "Dry run off — changes will be written to disk.",
              tone: next ? "warning" : "info",
            },
          });
          return;
        }
        case "/init-graph": {
          // Run init-graph asynchronously
          dispatch({ type: "state", state: "thinking" });
          dispatch({ type: "activity", activity: "Re-initializing code graph" });

          const projectRoot = process.cwd();
          import("../cli/init-graph")
            .then(({ runInitGraph }) => runInitGraph(projectRoot))
            .then(() => {
              dispatch({
                type: "appendHistory",
                block: {
                  kind: "system",
                  id: id("sys"),
                  text: "Code graph re-initialized successfully.",
                },
              });
              dispatch({ type: "state", state: "idle" });
            })
            .catch((err) => {
              dispatch({
                type: "appendHistory",
                block: {
                  kind: "error",
                  id: id("error"),
                  title: "init-graph failed",
                  detail: err instanceof Error ? err.message : String(err),
                  hint: "Check that HydraDB credentials are configured in .env",
                },
              });
              dispatch({ type: "state", state: "error" });
            })
            .finally(() => {
              dispatch({ type: "activity", activity: null });
            });
          return;
        }
        case "/exit":
          exit();
          return;
        case "/help":
          dispatch({ type: "appendHistory", block: helpBlock() });
          return;
        case "/doctor":
          dispatch({
            type: "appendHistory",
            block: {
              kind: "system",
              id: id("sys"),
              text: "Run `graphyti doctor` outside the TUI for a full environment report.",
            },
          });
          return;
        default:
          return;
      }
    },
    [dispatch, exit, session.debug, dryRun]
  );

  // ── History recall ─────────────────────────────────────────────────────────
  const recallHistory = React.useCallback(
    (direction: -1 | 1): string | null => {
      const { history: entries } = session;
      if (entries.length === 0) return null;

      if (direction === -1) {
        const next = historyIndex === null ? entries.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(next);
        return entries[next] ?? null;
      }

      if (historyIndex === null) return null;
      const next = historyIndex + 1;
      if (next >= entries.length) {
        setHistoryIndex(null);
        return "";
      }
      setHistoryIndex(next);
      return entries[next] ?? null;
    },
    [session, historyIndex]
  );

  // ── Frame ──────────────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column" paddingX={layout.gutter} width={layout.width}>
      <Header info={info} layout={layout} compact={compact} dryRun={dryRun} />

      {showWelcome ? (
        <Box flexDirection="column" flexShrink={0} marginTop={compact ? 0 : 1}>
          <WelcomeScreen layout={layout} dryRun={dryRun} />
        </Box>
      ) : (
        <Conversation
          history={history}
          live={liveLines}
          width={layout.contentWidth}
          height={conversationHeight}
          scrollOffset={scrollOffset}
        />
      )}

      <Box flexDirection="column" flexShrink={0} marginTop={compact ? 0 : 1}>
        <StatusBar
          state={session.state}
          activity={session.activity}
          elapsedMs={elapsedMs}
          spinnerFrame={spinnerFrame}
          width={layout.contentWidth}
          narrow={layout.isNarrow}
        />

        {session.permission && (
          <Box marginTop={1} flexShrink={0}>
            <PermissionPrompt
              request={session.permission}
              onDecide={decide}
              width={layout.contentWidth}
              narrow={layout.isNarrow}
              active
            />
          </Box>
        )}

        {overlay === "palette" && (
          <Box marginTop={1} flexShrink={0}>
            <CommandPalette
              query={input}
              selectedIndex={palette.index}
              width={layout.contentWidth}
              narrow={layout.isNarrow}
            />
          </Box>
        )}

        {!compact && <Divider width={layout.contentWidth} />}

        <PromptEditor
          draft={draft}
          onEdit={setDraft}
          onSubmit={(value) => {
            if (value.startsWith("/")) {
              const chosen = paletteMatches[palette.index];
              runCommand(chosen?.name ?? value.trim());
              return;
            }
            void submit(value);
          }}
          onHistory={recallHistory}
          width={layout.inputWidth}
          active={overlay !== "permission" && !busy}
          placeholder={busy ? "" : "Describe a change, or / for commands"}
        />

        <HelpBar
          ctx={{
            state: session.state,
            overlay,
            hasExpandable,
            scrolledUp: !scroll.following,
            hasHistory: session.history.length > 0,
          }}
          width={layout.contentWidth}
          compact={compact}
        />
      </Box>
    </Box>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let counter = 0;
function id(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

function isExpandable(block: Block): boolean {
  return "expanded" in block || block.kind === "log";
}

function describeError(error: unknown): Block {
  const message = error instanceof Error ? error.message : String(error);

  // Turn the failures users actually hit into an explanation and a next step,
  // rather than surfacing a raw stack (§23).
  let title = "Something went wrong";
  let hint: string | undefined;

  if (/GEMINI_API_KEY|API key/i.test(message)) {
    title = "Missing or invalid API key";
    hint = "Set GEMINI_API_KEY in graphyti's .env, then try again.";
  } else if (/HYDRA_DB|hydra/i.test(message)) {
    title = "Graph database unavailable";
    hint = "Check HYDRA_DB_API_KEY and HYDRA_DB_DATABASE, or rerun with --legacy-context.";
  } else if (/ENOENT/.test(message)) {
    title = "A file or command was not found";
    hint = "Check the path exists and that the command is installed and on PATH.";
  } else if (/schema\.prisma/i.test(message)) {
    title = "Prisma schema not found";
    hint = "Run graphyti from a project with prisma/schema.prisma.";
  } else if (/context/i.test(message) && /not found|missing/i.test(message)) {
    title = "No codebase context";
    hint = "Run `graphyti init-graph` first so graphyti can read your project.";
  }

  return {
    kind: "error",
    id: id("error"),
    title,
    detail: message,
    hint,
  };
}

function helpBlock(): Block {
  return {
    kind: "system",
    id: id("help"),
    text:
      "Describe a change in plain language and graphyti will plan it, show what it affects, " +
      "and write the files. Use /dry-run to preview without writing, ctrl+o to expand output, " +
      "and pgup/pgdn to scroll.",
  };
}
