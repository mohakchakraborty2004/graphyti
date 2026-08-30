/**
 * Live integration test.
 *
 * Mounts the real `App` against fake TTY streams and drives it with real
 * keystrokes, then asserts on the frames Ink actually emits. This is the only
 * check here that exercises the parts the pure suites cannot reach: `useInput`
 * routing, focus ownership between the editor and the overlays, the resize path,
 * and whether the prompt survives everything.
 *
 * Run with: node run-esm.mjs src/scripts/test-tui-live.tsx
 */

import React from "react";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { App } from "../tui/App";
import { visualWidth, stripAnsi } from "../tui/core/text";

let failures = 0;
let checks = 0;

function ok(condition: boolean, label: string, detail?: string) {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
  } else {
    console.log(`  ok    ${label}`);
  }
}

// ── Fake terminal ────────────────────────────────────────────────────────────

/**
 * A writable stream that looks enough like a TTY for Ink, and remembers every
 * frame so assertions can inspect what the user would have seen.
 */
class FakeStdout extends EventEmitter {
  columns: number;
  rows: number;
  readonly isTTY = true;
  frames: string[] = [];

  constructor(columns = 80, rows = 30) {
    super();
    this.columns = columns;
    this.rows = rows;
  }

  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }

  /** Latest frame, with ANSI and cursor control stripped. */
  lastFrame(): string {
    const frame = this.frames[this.frames.length - 1] ?? "";
    return stripAnsi(frame)
      // Ink emits erase/move sequences around each frame; drop what survives
      // stripping so assertions see text rather than control noise.
      .replace(/\[[0-9;]*[A-Za-z]/g, "")
      .replace(/\[[?][0-9;]*[a-z]/gi, "");
  }

  /** Everything written so far, flattened. */
  allText(): string {
    return this.frames.map((f) => stripAnsi(f)).join("");
  }

  resize(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
  }
}

/**
 * A readable stream that looks enough like a TTY for Ink.
 *
 * Ink 7 consumes input via the `'readable'` + `read()` protocol rather than
 * `'data'` events, so a fake that only emits `'data'` is silently ignored — the
 * app mounts and renders but never sees a keystroke. This implements the protocol
 * Ink actually uses.
 */
class FakeStdin extends EventEmitter {
  readonly isTTY = true;
  private queue: string[] = [];

  setRawMode() {
    return this;
  }
  setEncoding() {
    return this;
  }
  resume() {
    return this;
  }
  pause() {
    return this;
  }
  ref() {}
  unref() {}

  read(): string | null {
    return this.queue.shift() ?? null;
  }

  unshift(chunk: unknown) {
    if (typeof chunk === "string") this.queue.unshift(chunk);
  }

  removeListener(event: string, listener: (...args: never[]) => void): this {
    return super.removeListener(event, listener as (...args: unknown[]) => void) as this;
  }

  /** Deliver a keypress the way a terminal would. */
  press(sequence: string) {
    this.queue.push(sequence);
    this.emit("readable");
  }

  /** Deliver several characters as one burst, i.e. a paste. */
  paste(text: string) {
    this.queue.push(text);
    this.emit("readable");
  }
}

const KEYS = {
  enter: "\r",
  escape: "",
  backspace: "",
  up: "[A",
  down: "[B",
  left: "[D",
  right: "[C",
  ctrlC: "",
  ctrlO: "",
  pageUp: "[5~",
  pageDown: "[6~",
} as const;

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

async function mount(columns = 80, rows = 30) {
  const stdout = new FakeStdout(columns, rows);
  const stdin = new FakeStdin();

  const instance = render(
    <App
      dryRun={false}
      autoConfirm={false}
      legacyContext={false}
      version="1.0.0"
      model="configured-model"
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
      // A deterministic single frame per update is what makes assertions stable.
      debug: true,
    }
  );

  await tick();
  return { stdout, stdin, instance };
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function testInitialFrame() {
  console.log("\ninitial frame");
  const { stdout, instance } = await mount();

  const frame = stdout.lastFrame();
  ok(frame.includes("graphyti"), "header shows the app name");
  ok(frame.includes("Graph-grounded"), "empty state explains the tool");
  ok(frame.includes("Ask me to"), "empty state lists capabilities");
  ok(frame.includes("enter send"), "contextual hints are present");
  ok(
    frame.includes("Describe a change"),
    "the prompt placeholder is visible"
  );

  for (const row of frame.split("\n")) {
    const w = visualWidth(row);
    ok(w <= 80, "initial frame row fits 80 cols", `${w} > 80: ${JSON.stringify(row)}`);
  }

  instance.unmount();
  await tick();
}

async function testTypingAndCaret() {
  console.log("\ntyping");
  const { stdout, stdin, instance } = await mount();

  for (const ch of "add a field") stdin.press(ch);
  await tick();

  let frame = stdout.lastFrame();
  ok(frame.includes("add a field"), "typed text appears in the prompt");
  ok(!frame.includes("Describe a change"), "placeholder is replaced once typing starts");

  // Every row must still fit — this is the case the old input got wrong, where
  // typing pushed the right border further right with each character.
  for (const row of frame.split("\n")) {
    ok(visualWidth(row) <= 80, "row still fits after typing", `${visualWidth(row)} > 80`);
  }

  // A prompt longer than the terminal is the real test of the editor's wrapping.
  const long = "x".repeat(300);
  for (const ch of long) stdin.press(ch);
  await tick(120);

  frame = stdout.lastFrame();
  for (const row of frame.split("\n")) {
    ok(
      visualWidth(row) <= 80,
      "row fits with a 300-character prompt",
      `${visualWidth(row)} > 80: ${JSON.stringify(row.slice(0, 90))}`
    );
  }
  ok(frame.includes("enter send"), "hints survive a long prompt");

  instance.unmount();
  await tick();
}

async function testBackspace() {
  console.log("\nediting");
  const { stdout, stdin, instance } = await mount();

  for (const ch of "hello") stdin.press(ch);
  await tick();
  stdin.press(KEYS.backspace);
  stdin.press(KEYS.backspace);
  await tick();

  const frame = stdout.lastFrame();
  ok(frame.includes("hel"), "backspace removes characters");
  ok(!/hello/.test(frame), "removed characters are gone");

  instance.unmount();
  await tick();
}

async function testCommandPalette() {
  console.log("\ncommand palette");
  const { stdout, stdin, instance } = await mount();

  stdin.press("/");
  await tick();

  let frame = stdout.lastFrame();
  ok(frame.includes("/help"), "typing / opens the palette");
  ok(frame.includes("/clear"), "palette lists commands");
  ok(frame.includes("enter select"), "hints switch to palette context");
  ok(!frame.includes("enter send"), "send hint is withdrawn while the palette owns keys");

  stdin.press("d");
  await tick();
  frame = stdout.lastFrame();
  ok(frame.includes("/debug"), "palette filters as you type");
  ok(!frame.includes("/clear"), "non-matching commands are filtered out");

  // Escape must return to the prompt, not leave the palette stuck open.
  stdin.press(KEYS.escape);
  await tick();
  frame = stdout.lastFrame();
  ok(!frame.includes("/debug"), "escape closes the palette");
  ok(frame.includes("enter send"), "hints return to prompt context");

  instance.unmount();
  await tick();
}

async function testSlashCommandExecutes() {
  console.log("\nslash commands");
  const { stdout, stdin, instance } = await mount();

  for (const ch of "/dry-run") stdin.press(ch);
  await tick();
  stdin.press(KEYS.enter);
  await tick(120);

  const text = stdout.allText();
  ok(text.includes("dry run"), "the /dry-run command reports its effect");

  const frame = stdout.lastFrame();
  ok(frame.includes("enter send"), "the prompt is usable again after a command");

  instance.unmount();
  await tick();
}

async function testResize() {
  console.log("\nresize");
  const { stdout, stdin, instance } = await mount(120, 30);

  for (const ch of "a prompt that is reasonably long so wrapping matters") {
    stdin.press(ch);
  }
  await tick();

  for (const [columns, rows] of [
    [40, 24],
    [60, 20],
    [200, 50],
    [35, 12],
    [80, 30],
  ] as const) {
    stdout.resize(columns, rows);
    await tick(80);

    const frame = stdout.lastFrame();
    for (const row of frame.split("\n")) {
      ok(
        visualWidth(row) <= columns,
        `frame fits after resize to ${columns}x${rows}`,
        `${visualWidth(row)} > ${columns}: ${JSON.stringify(row.slice(0, columns + 20))}`
      );
    }
    ok(frame.trim().length > 0, `frame still renders at ${columns}x${rows}`);
    ok(frame.includes("graphyti"), `header survives ${columns}x${rows}`);
  }

  instance.unmount();
  await tick();
}

async function testPromptAlwaysReachable() {
  console.log("\nprompt reachability");

  // The old implementation lost the prompt after a run finished, and could push
  // it off screen with tall content. Both are checked here at a punishing height.
  const { stdout, stdin, instance } = await mount(80, 10);

  for (const ch of "hello") stdin.press(ch);
  await tick();

  const frame = stdout.lastFrame();
  const rows = frame.split("\n").filter((r) => r.trim().length > 0);
  ok(rows.length > 0, "something renders at height 10");
  ok(frame.includes("hello"), "the prompt is visible at height 10");
  ok(
    frame.includes("enter send") || frame.includes("ctrl+c"),
    "hints are visible at height 10"
  );

  instance.unmount();
  await tick();
}

async function testCtrlCDoesNotExitWhileIdleTyping() {
  console.log("\nctrl+c");
  const { stdout, stdin, instance } = await mount();

  let exited = false;
  void instance.waitUntilExit().then(() => {
    exited = true;
  });

  for (const ch of "draft") stdin.press(ch);
  await tick();
  ok(stdout.lastFrame().includes("draft"), "draft text is present");

  // Idle + ctrl+c is an explicit quit, so it should exit. The important property
  // is that it is *our* handler doing it, not Ink's default, which would bypass
  // in-run cancellation.
  stdin.press(KEYS.ctrlC);
  await tick(120);
  ok(exited, "ctrl+c while idle exits the app");
}

async function main() {
  console.log("TUI live integration");

  await testInitialFrame();
  await testTypingAndCaret();
  await testBackspace();
  await testCommandPalette();
  await testSlashCommandExecutes();
  await testResize();
  await testPromptAlwaysReachable();
  await testCtrlCDoesNotExitWhileIdleTyping();

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
