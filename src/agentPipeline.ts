import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { codeCombiner } from "./utils/agent";
import { ALLOWLIST_HELP, parseAllowedCommand } from "./utils/commandAllowlist";
import { askConfirm } from "./utils/confirm";

export interface mergeType {
  code: string;
}

export interface AgentOutputOptions {
  dryRun?: boolean;
  /** Auto-confirm command execution (CLI `--yes`), mirroring the blast-radius gate. */
  yes?: boolean;
}

export interface WriteResult {
  /** Absolute paths of every file that was created or updated */
  writtenPaths: string[];
  /** Commands that were executed */
  executedCommands: string[];
}

function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`📁 Created directory: ${dirPath}`);
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
    console.log(`\n📄 [dry-run] Would write: ${fullPath}`);
    console.log("─".repeat(60));
    const lines = cleanedContent.split("\n");
    const preview = lines.slice(0, 60).join("\n");
    console.log(preview);
    if (lines.length > 60) console.log(`  … (${lines.length - 60} more lines)`);
    console.log("─".repeat(60));
    return null;
  }

  if (!fs.existsSync(fullPath)) {
    fs.writeFileSync(fullPath, cleanedContent, "utf-8");
    console.log(`✅ Created new file: ${fullPath}`);
  } else {
    const existing = fs.readFileSync(fullPath, "utf-8");
    // @ts-ignore
    const merged = await codeCombiner(existing, cleanedContent);
    // @ts-ignore
    fs.writeFileSync(fullPath, merged.code.replace(/\\n/g, "\n"), "utf-8");
    console.log(`🔁 Updated file with merged content: ${fullPath}`);
  }
  return fullPath;
}

/**
 * Run a single model-generated command, but only if it matches the allowlist in
 * utils/commandAllowlist.ts, and only after the user has confirmed the exact
 * command that will run.
 *
 * Three layers, in order:
 *   1. Structural allowlist — the raw string is parsed into a canonical argv.
 *      A rejection is explained and skipped, never executed.
 *   2. Explicit y/n confirmation on the printed command (same gate as the
 *      blast-radius confirmation), skippable only with --yes.
 *   3. Execution of the canonical argv via spawnSync — the raw model string is
 *      never handed to a shell.
 *
 * @returns The canonical command string that ran, or null if nothing ran.
 */
async function runCommand(cmd: unknown, dryRun: boolean, yes: boolean): Promise<string | null> {
  const check = parseAllowedCommand(cmd);

  if (!check.ok) {
    console.error(`\n🚫 Refused to run command: ${typeof cmd === "string" ? cmd : String(cmd)}`);
    console.error(`   ${check.reason}`);
    console.error(`   Only these command shapes are ever executed:`);
    for (const line of ALLOWLIST_HELP) console.error(`     • ${line}`);
    return null;
  }

  if (dryRun) {
    console.log(`\n⚡ [dry-run] Would run: ${check.display}`);
    return null;
  }

  console.log(`\n⚡ Command to run (allowlist rule: ${check.rule})`);
  console.log(`     ${check.display}`);
  console.log(`     cwd: ${process.cwd()}`);

  if (yes) {
    console.log(`  ℹ️  Skipping confirmation (--yes flag set)`);
  } else if (!process.stdin.isTTY) {
    console.error(
      `  🚫 Not running: no interactive terminal available to confirm on. ` +
        `Re-run with --yes to auto-confirm allowlisted commands.`
    );
    return null;
  } else {
    const confirmed = await askConfirm(`  Run this command? [y/N] `);
    if (!confirmed) {
      console.log(`  ✋ Command skipped by user.`);
      return null;
    }
  }

  // Execute the canonical argv, not the model's string. shell is enabled only on
  // Windows, where npm/npx are .cmd shims that cannot be spawned directly; it is
  // safe because parseAllowedCommand() rejects every shell metacharacter, so no
  // token can carry operators, quoting or substitution.
  const isWindows = process.platform === "win32";
  const [exe, ...args] = check.argv;
  const result = spawnSync(isWindows ? `${exe}.cmd` : exe, args, {
    stdio: "inherit",
    shell: isWindows,
  });

  if (result.error) {
    console.error(`❌ Failed to run command: ${check.display}`, result.error.message);
    return null;
  }
  if (result.status !== 0) {
    console.error(`❌ Command exited with code ${result.status}: ${check.display}`);
    return null;
  }

  console.log(`💡 Executed: ${check.display}`);
  return check.display;
}

/**
 * Write all file actions and run all command actions.
 * Returns { writtenPaths, executedCommands } so callers can reingest changed
 * files and build the CLI summary.
 */
export async function handleAgentOutput(
  actions: any[],
  options: AgentOutputOptions = {}
): Promise<WriteResult> {
  const dryRun = options.dryRun ?? false;
  const yes = options.yes ?? false;
  const writtenPaths: string[] = [];
  const executedCommands: string[] = [];

  if (dryRun) {
    console.log("\n🔍 [dry-run] Showing what would be written — no files will be changed.\n");
  }

  for (const item of actions) {
    if (item.type === "file") {
      const fullDir = path.resolve(process.cwd(), item.directory);
      if (!dryRun) ensureDir(fullDir);
      const written = await writeFileSafe(fullDir, item.fileName, item.content, dryRun);
      if (written) writtenPaths.push(written);
    }

    if (item.type === "command") {
      const ran = await runCommand(item.command, dryRun, yes);
      if (ran) executedCommands.push(ran);
    }
  }

  if (dryRun) {
    console.log("\n✅ [dry-run] Preview complete. Re-run without --dry-run to apply.");
  }

  return { writtenPaths, executedCommands };
}
