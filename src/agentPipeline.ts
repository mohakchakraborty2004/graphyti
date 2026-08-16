import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { ALLOWLIST_HELP, parseAllowedCommand } from "./utils/commandAllowlist";
import { askConfirm } from "./utils/confirm";
import { success, error, warn, info, sym, rule, bold } from "./cli/theme";
import { renderFileDiff, renderDiff } from "./cli/renderDiff";
import { structuralSchemaMerge } from "./graph/schemaMerge";

export interface mergeType {
  code: string;
}

export interface AgentOutputOptions {
  dryRun?: boolean;
  yes?: boolean;
  /**
   * Called before any command that uses spawnSync with stdio:"inherit".
   * The caller should stop any active ora spinner here so it doesn't
   * conflict with the child process's terminal I/O.
   */
  onBeforeCommand?: () => void;
}

export interface WriteResult {
  writtenPaths: string[];
  executedCommands: string[];
}

function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`    ${info("›")} Created directory: ${dirPath}`);
  }
}

/**
 * Write or merge a single file.
 * Returns the absolute path that was written, or null on dry-run.
 */
async function writeFileSafe(
  directory: string,
  fileName: string,
  content: string,
  dryRun: boolean
): Promise<string | null> {
  const fullPath = path.join(directory, fileName);
  const cleanedContent = content.replace(/\\n/g, "\n");

  if (dryRun) {
    const existingContent = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf-8") : null;
    const diff = renderFileDiff(existingContent, cleanedContent, fullPath);
    if (diff) {
      console.log(`\n  ${bold(fullPath)}`);
      console.log(diff);
    } else {
      console.log(`\n  ${info("›")} ${fullPath} ${info("(no changes)")}`);
    }
    return null;
  }

  if (!fs.existsSync(fullPath)) {
    fs.writeFileSync(fullPath, cleanedContent, "utf-8");
    console.log(`    ${sym.ok} Created: ${fullPath}`);
  } else {
    const existing = fs.readFileSync(fullPath, "utf-8");
    let mergedContent: string;

    if (fileName === "schema.prisma") {
      // Structural merge for Prisma schemas — no LLM, no lost newlines
      mergedContent = structuralSchemaMerge(existing, cleanedContent, fullPath, path.resolve(directory, ".."));
      fs.writeFileSync(fullPath, mergedContent, "utf-8");
      console.log(`    ${sym.ok} Updated: ${fullPath}`);
    } else {
      // For non-schema files, write the generated content directly
      // (codeCombiner was causing duplicate accumulation and formatting issues)
      mergedContent = cleanedContent;
      fs.writeFileSync(fullPath, mergedContent, "utf-8");
      console.log(`    ${sym.ok} Updated: ${fullPath}`);
    }

    // Show the diff for actual writes so the user sees what changed
    const diff = renderDiff(existing, mergedContent, { header: fullPath });
    if (diff) {
      console.log();
      console.log(diff);
      console.log();
    }
  }
  return fullPath;
}

/**
 * Run a single model-generated command.
 *
 * IMPORTANT: before calling spawnSync with stdio:"inherit", we MUST invoke
 * onBeforeCommand() so the caller can stop any active ora spinner — ora's
 * repaint timer conflicts with the child process's terminal I/O and causes
 * the process to hang.
 */
async function runCommand(
  cmd: unknown,
  dryRun: boolean,
  yes: boolean,
  onBeforeCommand?: () => void
): Promise<string | null> {
  const check = parseAllowedCommand(cmd);

  if (!check.ok) {
    console.error(`    ${error("✗")} Refused to run command: ${typeof cmd === "string" ? cmd : String(cmd)}`);
    console.error(`      ${check.reason}`);
    console.error(`      Only these command shapes are ever executed:`);
    for (const line of ALLOWLIST_HELP) console.error(`        ${sym.bullet} ${line}`);
    return null;
  }

  if (dryRun) {
    console.log(`    ${info("›")} Would run: ${check.display}`);
    return null;
  }

  console.log(`    ${info("›")} ${check.display}`);
  console.log(`      cwd: ${process.cwd()}`);

  if (yes) {
    console.log(`    ${info("ℹ")} Auto-confirmed (--yes)`);
  } else if (!process.stdin.isTTY) {
    console.error(
      `    ${error("✗")} Not running: no interactive terminal. ` +
        `Re-run with --yes to auto-confirm.`
    );
    return null;
  } else {
    const confirmed = await askConfirm(`    Run this command? [y/N] `);
    if (!confirmed) {
      console.log(`    ${warn("!")} Skipped by user.`);
      return null;
    }
  }

  // ── Stop any active spinner BEFORE spawning — critical ────────────────
  // spawnSync with stdio:"inherit" takes over the terminal. If ora's
  // repaint timer fires while the child process owns stdio, the two fight
  // over the terminal and the process hangs.
  if (onBeforeCommand) onBeforeCommand();

  const isWindows = process.platform === "win32";
  const [exe, ...args] = check.argv;
  const result = spawnSync(isWindows ? `${exe}.cmd` : exe, args, {
    stdio: "inherit",
    shell: isWindows,
  });

  if (result.error) {
    console.error(`    ${error("✗")} Failed to run: ${check.display}`, result.error.message);
    return null;
  }
  if (result.status !== 0) {
    console.error(`    ${error("✗")} Exited with code ${result.status}: ${check.display}`);
    return null;
  }

  console.log(`    ${sym.ok} Executed: ${check.display}`);
  return check.display;
}

/**
 * Write all file actions and run all command actions.
 *
 * File writes happen first (safe — no terminal I/O conflict).
 * Commands are run via spawnSync with stdio:"inherit", which requires any
 * active ora spinner to be paused first via onBeforeCommand.
 */
export async function handleAgentOutput(
  actions: any[],
  options: AgentOutputOptions = {}
): Promise<WriteResult> {
  const dryRun = options.dryRun ?? false;
  const yes = options.yes ?? false;
  const onBeforeCommand = options.onBeforeCommand;
  const writtenPaths: string[] = [];
  const executedCommands: string[] = [];

  // ── 1. Write files first (safe — no terminal conflict) ────────────────
  for (const item of actions) {
    if (item.type === "file") {
      const fullDir = path.resolve(process.cwd(), item.directory);
      if (!dryRun) ensureDir(fullDir);
      const written = await writeFileSafe(fullDir, item.fileName, item.content, dryRun);
      if (written) writtenPaths.push(written);
    }
  }

  // ── 2. Run commands (onBeforeCommand pauses the spinner before each) ──
  for (const item of actions) {
    if (item.type === "command") {
      const ran = await runCommand(item.command, dryRun, yes, onBeforeCommand);
      if (ran) executedCommands.push(ran);
    }
  }

  return { writtenPaths, executedCommands };
}
