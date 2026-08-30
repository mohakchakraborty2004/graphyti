import React from "react";
import { render } from "ink";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { App } from "./App";
import { getConfiguredModel } from "../generate/llmClient";

interface TuiOptions {
  dryRun: boolean;
  autoConfirm: boolean;
  legacyContext: boolean;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readVersion(): string {
  const candidates = [
    path.join(__dirname, "package.json"),
    path.join(__dirname, "..", "package.json"),
    path.join(__dirname, "..", "..", "package.json"),
  ];

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf-8"));
      if (pkg.name === "graphyti") return pkg.version ?? "0.0.0";
    } catch {
      continue;
    }
  }
  return "0.0.0";
}

/**
 * Check if the code graph has been initialized. If not, run init-graph
 * automatically so the TUI has context available for queries.
 */
async function ensureGraphInitialized(projectRoot: string): Promise<void> {
  const graphMapPath = path.join(projectRoot, ".dbagent", "graph-map.json");

  if (fs.existsSync(graphMapPath)) {
    return; // Already initialized
  }

  // Graph not found — run init-graph silently
  const { runInitGraph } = await import("../cli/init-graph");
  await runInitGraph(projectRoot);
}

export async function launchTui(options: TuiOptions) {
  if (!process.stdin.isTTY) {
    console.error(
      "graphyti's interactive mode needs a terminal.\n\n" +
        "  Run `graphyti \"<request>\"` for one-shot use,\n" +
        "  or start graphyti directly in a terminal."
    );
    process.exit(1);
  }

  const projectRoot = process.cwd();

  // Ensure the code graph is initialized before launching the TUI
  await ensureGraphInitialized(projectRoot);

  const { waitUntilExit } = render(
    <App
      dryRun={options.dryRun}
      autoConfirm={options.autoConfirm}
      legacyContext={options.legacyContext}
      version={readVersion()}
      model={getConfiguredModel()}
    />,
    {
      // Ctrl+C is handled in-app so it can cancel a run instead of killing the
      // process mid-write; only a second press exits.
      exitOnCtrlC: false,
      /**
       * Console output is captured by the pipeline runner and routed into the
       * transcript, so Ink's own console patching is redundant here — and leaving
       * it on would relocate raw pre-styled text outside the layout system, where
       * it wraps at whatever width the terminal happens to be.
       */
      patchConsole: false,
      // Redraw only the rows that changed. With a mostly-static frame this is
      // what keeps a fast-updating spinner from flickering the whole screen.
      incrementalRendering: true,
    }
  );

  return waitUntilExit();
}
