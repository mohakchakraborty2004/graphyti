import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { ALLOWLIST_HELP, parseAllowedCommand } from "./utils/commandAllowlist";
import { askConfirm } from "./utils/confirm";
import { success, error, warn, info, sym, rule, bold } from "./cli/theme";
import { renderDiff } from "./cli/renderDiff";
import type { EditPlan, FileEdit, SchemaEdit, CommandAction, CreateFile } from "./generate/scopedEdit";
import { applyScopedEdits, applySchemaEdit, checkSyntax } from "./generate/scopedEdit";
import { StaleEditError, AmbiguousEditError } from "./generate/scopedEdit";

export { StaleEditError, AmbiguousEditError };

export interface AgentOutputOptions {
  dryRun?: boolean;
  yes?: boolean;
  projectRoot?: string;
  onBeforeCommand?: () => void;
}

export interface WriteResult {
  writtenPaths: string[];
  executedCommands: string[];
  /** FileEdits that failed due to stale or ambiguous oldText — orchestrator retries once. */
  staleEdits: Array<{ edit: FileEdit; error: StaleEditError | AmbiguousEditError }>;
  /** New files created by CreateFile operations. */
  createdPaths: string[];
  /** CreateFile operations that failed (file already exists or syntax error). */
  createFailures: Array<{ edit: CreateFile; error: string }>;
}

function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`    ${info("›")} Created directory: ${dirPath}`);
  }
}

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
 * Write all file actions and run all command actions from an EditPlan.
 *
 * File writes happen first. For each FileEdit, reads the current on-disk
 * content and applies scoped edits. If an edit fails due to stale or
 * ambiguous oldText, it is collected in staleEdits (NOT thrown) so the
 * orchestrator can implement one-retry-then-fail.
 *
 * SchemaEdit entries are applied deterministically via applySchemaEdit.
 * CommandAction entries go through the existing allowlist + confirmation flow.
 */
export async function handleAgentOutput(
  plan: EditPlan,
  options: AgentOutputOptions = {}
): Promise<WriteResult> {
  const dryRun = options.dryRun ?? false;
  const yes = options.yes ?? false;
  const projectRoot = options.projectRoot ?? process.cwd();
  const onBeforeCommand = options.onBeforeCommand;
  const writtenPaths: string[] = [];
  const executedCommands: string[] = [];
  const staleEdits: WriteResult["staleEdits"] = [];
  const createdPaths: string[] = [];
  const createFailures: WriteResult["createFailures"] = [];

  // ── 1. FileEdit entries ─────────────────────────────────────────────
  for (const item of plan) {
    if (item.type !== "file") continue;
    const fileEdit = item as FileEdit;

    const absPath = path.isAbsolute(fileEdit.filePath)
      ? fileEdit.filePath
      : path.resolve(projectRoot, fileEdit.filePath);

    if (dryRun) {
      if (fs.existsSync(absPath)) {
        const currentContent = fs.readFileSync(absPath, "utf-8");
        try {
          const result = applyScopedEdits(currentContent, fileEdit.edits, fileEdit.filePath);
          const diff = renderDiff(currentContent, result, { header: absPath });
          if (diff) {
            console.log(`\n  ${bold(absPath)}`);
            console.log(diff);
          } else {
            console.log(`\n  ${info("›")} ${absPath} ${info("(no changes)")}`);
          }
        } catch (err) {
          if (err instanceof StaleEditError || err instanceof AmbiguousEditError) {
            console.error(`\n  ${error("✗")} ${err.message}`);
            for (const f of err.failures) {
              console.error(`    ${sym.bullet} ${f.filePath}: ${f.oldText}${f.count !== undefined ? ` (${f.count} matches)` : ""}`);
            }
          } else {
            throw err;
          }
        }
      } else {
        console.log(`\n  ${info("›")} ${absPath} ${info("(new file)")}`);
      }
      continue;
    }

    // Actual write
    const dir = path.dirname(absPath);
    ensureDir(dir);

    let currentContent: string;
    if (fs.existsSync(absPath)) {
      currentContent = fs.readFileSync(absPath, "utf-8");
    } else {
      if (fileEdit.edits.length === 1 && fileEdit.edits[0].oldText === "") {
        fs.writeFileSync(absPath, fileEdit.edits[0].newText, "utf-8");
        console.log(`    ${sym.ok} Created: ${absPath}`);
        writtenPaths.push(absPath);
        continue;
      }
      console.error(`    ${error("✗")} File does not exist and no creation edit: ${absPath}`);
      continue;
    }

    try {
      const mergedContent = applyScopedEdits(currentContent, fileEdit.edits, fileEdit.filePath);
      fs.writeFileSync(absPath, mergedContent, "utf-8");
      console.log(`    ${sym.ok} Updated: ${absPath}`);

      const diff = renderDiff(currentContent, mergedContent, { header: absPath });
      if (diff) {
        console.log();
        console.log(diff);
        console.log();
      }

      writtenPaths.push(absPath);
    } catch (err) {
      if (err instanceof StaleEditError || err instanceof AmbiguousEditError) {
        // Collect for retry — do NOT write anything for this file
        console.error(`    ${error("✗")} ${err.message}`);
        staleEdits.push({ edit: fileEdit, error: err });
      } else {
        throw err;
      }
    }
  }

  // ── 2. CreateFile entries ───────────────────────────────────────────
  for (const item of plan) {
    if (item.type !== "create_file") continue;
    const createOp = item as CreateFile;

    const absPath = path.isAbsolute(createOp.filePath)
      ? createOp.filePath
      : path.resolve(projectRoot, createOp.filePath);

    if (dryRun) {
      if (fs.existsSync(absPath)) {
        console.error(`\n  ${error("✗")} ${absPath} ${error("already exists — cannot create")}`);
      } else {
        console.log(`\n  ${info("›")} ${absPath} ${info("(new file — syntax check pending)")}`);
        const syntaxCheck = checkSyntax(createOp.content, createOp.filePath);
        if (!syntaxCheck.ok) {
          console.error(`    ${error("✗")} ${syntaxCheck.reason}`);
        } else {
          console.log(`    ${sym.ok} Syntax OK`);
        }
      }
      continue;
    }

    // Actual write
    if (fs.existsSync(absPath)) {
      const msg = `File already exists — cannot create ${createOp.filePath}. The plan assumed this file did not exist (stale graph state or planning bug).`;
      console.error(`    ${error("✗")} ${msg}`);
      createFailures.push({ edit: createOp, error: msg });
      continue;
    }

    // Syntax sanity check before writing
    const syntaxCheck = checkSyntax(createOp.content, createOp.filePath);
    if (!syntaxCheck.ok) {
      console.error(`    ${error("✗")} ${syntaxCheck.reason}`);
      createFailures.push({ edit: createOp, error: syntaxCheck.reason });
      continue;
    }

    const dir = path.dirname(absPath);
    ensureDir(dir);
    fs.writeFileSync(absPath, createOp.content, "utf-8");
    console.log(`    ${sym.ok} Created: ${absPath} ${info(`— ${createOp.reason}`)}`);
    createdPaths.push(absPath);
  }

  // ── 3. SchemaEdit entries ────────────────────────────────────────────
  for (const item of plan) {
    if (item.type !== "schema") continue;
    const schemaEdit = item as SchemaEdit;

    // Find schema.prisma
    const candidates = [
      path.join(projectRoot, "prisma", "schema.prisma"),
      path.join(projectRoot, "schema.prisma"),
    ];
    const schemaPath = candidates.find((p) => fs.existsSync(p));
    if (!schemaPath) {
      console.error(`    ${error("✗")} No schema.prisma found for ${schemaEdit.op} on ${schemaEdit.model}`);
      continue;
    }
    const relSchemaPath = path.relative(projectRoot, schemaPath);

    if (dryRun) {
      console.log(`\n  ${bold(relSchemaPath)} — schema edit: ${schemaEdit.op} on ${schemaEdit.model}.${schemaEdit.fieldName ?? ""}`);
      if (schemaEdit.op === "add_field") {
        console.log(`    ${info("+")} ${schemaEdit.model}.${schemaEdit.fieldName} ${schemaEdit.fieldType}`);
      } else if (schemaEdit.op === "remove_field") {
        console.log(`    ${error("−")} ${schemaEdit.model}.${schemaEdit.fieldName} removed`);
      } else if (schemaEdit.op === "rename_field") {
        console.log(`    ${info("~")} ${schemaEdit.model}.${schemaEdit.fieldName} → ${schemaEdit.newFieldName}`);
      } else if (schemaEdit.op === "change_type") {
        console.log(`    ${info("~")} ${schemaEdit.model}.${schemaEdit.fieldName}: ${schemaEdit.fieldType} → ${schemaEdit.newFieldType}`);
      }
      continue;
    }

    const existing = fs.readFileSync(schemaPath, "utf-8");
    try {
      const result = applySchemaEdit(existing, schemaEdit, schemaPath, projectRoot);
      console.log(`    ${sym.ok} Schema updated: ${relSchemaPath} (${schemaEdit.op} on ${schemaEdit.model})`);

      const diff = renderDiff(existing, result, { header: relSchemaPath });
      if (diff) {
        console.log();
        console.log(diff);
        console.log();
      }

      writtenPaths.push(schemaPath);
    } catch (err) {
      console.error(`    ${error("✗")} Schema edit failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── 3. CommandAction entries ─────────────────────────────────────────
  for (const item of plan) {
    if (item.type !== "command") continue;
    const cmd = item as CommandAction;
    const ran = await runCommand(cmd.command, dryRun, yes, onBeforeCommand);
    if (ran) executedCommands.push(ran);
  }

  return { writtenPaths, executedCommands, staleEdits, createdPaths, createFailures };
}
