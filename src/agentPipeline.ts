import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { codeCombiner } from "./utils/agent";

export interface mergeType {
  code: string;
}

export interface AgentOutputOptions {
  dryRun?: boolean;
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
    console.log(existing);
    // @ts-ignore
    const merged = await codeCombiner(existing, cleanedContent);
    // @ts-ignore
    fs.writeFileSync(fullPath, merged.code.replace(/\\n/g, "\n"), "utf-8");
    console.log(`🔁 Updated file with merged content: ${fullPath}`);
  }
  return fullPath;
}

function runCommand(cmd: string, dryRun: boolean): boolean {
  if (dryRun) {
    console.log(`\n⚡ [dry-run] Would run: ${cmd}`);
    return false;
  }
  try {
    execSync(cmd, { stdio: "inherit" });
    console.log(`💡 Executed: ${cmd}`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to run command: ${cmd}`, err);
    return false;
  }
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
      const ran = runCommand(item.command, dryRun);
      if (ran) executedCommands.push(item.command);
    }
  }

  if (dryRun) {
    console.log("\n✅ [dry-run] Preview complete. Re-run without --dry-run to apply.");
  }

  return { writtenPaths, executedCommands };
}
