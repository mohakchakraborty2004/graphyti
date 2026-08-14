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

function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`📁 Created directory: ${dirPath}`);
  }
}

async function writeFileSafe(
  directory: string,
  fileName: string,
  content: string,
  dryRun: boolean
) {
  const fullPath = path.join(directory, fileName);
  const cleanedContent = content.replace(/\\n/g, "\n");

  if (dryRun) {
    console.log(`\n📄 [dry-run] Would write: ${fullPath}`);
    console.log("─".repeat(60));
    // Print a preview (first 60 lines to keep output readable)
    const lines = cleanedContent.split("\n");
    const preview = lines.slice(0, 60).join("\n");
    console.log(preview);
    if (lines.length > 60) {
      console.log(`  … (${lines.length - 60} more lines)`);
    }
    console.log("─".repeat(60));
    return;
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
}

function runCommand(cmd: string, dryRun: boolean) {
  if (dryRun) {
    console.log(`\n⚡ [dry-run] Would run: ${cmd}`);
    return;
  }
  try {
    execSync(cmd, { stdio: "inherit" });
    console.log(`💡 Executed: ${cmd}`);
  } catch (err) {
    console.error(`❌ Failed to run command: ${cmd}`, err);
  }
}

export async function handleAgentOutput(
  actions: any[],
  options: AgentOutputOptions = {}
) {
  const dryRun = options.dryRun ?? false;

  if (dryRun) {
    console.log("\n🔍 [dry-run] Showing what would be written — no files will be changed.\n");
  }

  for (const item of actions) {
    if (item.type === "file") {
      const fullDir = path.resolve(process.cwd(), item.directory);
      if (!dryRun) ensureDir(fullDir);
      await writeFileSafe(fullDir, item.fileName, item.content, dryRun);
    }

    if (item.type === "command") {
      runCommand(item.command, dryRun);
    }
  }

  if (dryRun) {
    console.log("\n✅ [dry-run] Preview complete. Re-run without --dry-run to apply.");
  }
}
