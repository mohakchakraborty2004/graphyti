#!/usr/bin/env node
/**
 * Bundle-and-run a TypeScript entry point as ESM.
 *
 * Needed because Ink depends on `yoga-layout`, which uses top-level await. This
 * package is not `"type": "module"`, so `tsx` transpiles `.ts`/`.tsx` to CJS —
 * and top-level await cannot exist in CJS. The app itself sidesteps this by
 * bundling to `dist/cli.mjs` as ESM; this gives scripts the same treatment.
 *
 *   node run-esm.mjs src/scripts/tui-snapshot.tsx [args...]
 */

import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

const [entry, ...args] = process.argv.slice(2);

if (!entry) {
  console.error("usage: node run-esm.mjs <entry.ts|entry.tsx> [args...]");
  process.exit(2);
}

/**
 * Build inside the project, not the OS temp dir: dependencies are left external
 * so Node resolves them at runtime, and that resolution walks up from the output
 * file — which only finds `node_modules` if the output lives in the project.
 */
const outDir = mkdtempSync(path.join(process.cwd(), ".run-esm-"));
const outfile = path.join(outDir, "entry.mjs");

let exitCode = 1;

try {
  await esbuild.build({
    absWorkingDir: process.cwd(),
    // esbuild treats `src/foo.tsx` as a package-style entry in some Windows
    // shells. Resolving it first makes the live TUI test run from any cwd.
    entryPoints: [path.resolve(process.cwd(), entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    // Dependencies stay external so they load from node_modules with their own
    // module semantics intact — bundling Ink's native yoga binding would break it.
    packages: "external",
    jsx: "automatic",
    logLevel: "warning",
  });

  const result = spawnSync(process.execPath, [outfile, ...args], {
    stdio: "inherit",
  });

  exitCode = result.status ?? 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

process.exit(exitCode);
