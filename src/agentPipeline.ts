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
import { resolveProjectPath } from "./utils/paths";
import { log, type LogFields } from "./utils/agentLog";

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
  /**
   * SchemaEdit operations that failed.
   *
   * Non-empty means nothing at all was written: the schema is applied first and
   * a failure aborts the rest of the plan, so the caller can treat this as a
   * clean no-op rather than a partial migration.
   */
  schemaFailures: Array<{ edit: SchemaEdit; error: string }>;
}

function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`    ${info("›")} Created directory: ${dirPath}`);
  }
}

/**
 * Resolve an LLM-produced path, or refuse to touch it.
 *
 * Model output routinely prefixes paths with the project folder's own name.
 * `handleAgentOutput` used to resolve whatever it was given and `mkdir -p` the
 * way there, so `sample-project/components/PostCard.tsx` inside `sample-project/`
 * silently created a duplicate tree and a ghost node in the graph that then
 * showed up in every later blast radius.
 */
function safeResolve(
  filePath: string,
  projectRoot: string,
  label: string
): { abs: string; rel: string } | null {
  const resolved = resolveProjectPath(filePath, projectRoot);
  if (!resolved) {
    console.error(
      `    ${error("✗")} Refused ${label}: ${filePath} resolves outside the project root`
    );
    log.warn("path.refused", { label, filePath });
    return null;
  }
  if (resolved.corrected) {
    console.log(
      `    ${warn("!")} Corrected path ${filePath} → ${resolved.rel} (duplicated project-root prefix)`
    );
    log.info("path.corrected", { label, filePath, corrected: resolved.rel });
  }
  return { abs: resolved.abs, rel: resolved.rel };
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
    log.error("command.refused", { command: String(cmd), reason: check.reason });
    return null;
  }

  if (dryRun) {
    console.log(`    ${info("›")} Would run: ${check.display}`);
    log.info("command.dryRun", { command: check.display });
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
    log.warn("command.skipped", { command: check.display, reason: "no interactive terminal" });
    return null;
  } else {
    const confirmed = await askConfirm(`    Run this command? [y/N] `);
    if (!confirmed) {
      console.log(`    ${warn("!")} Skipped by user.`);
      log.warn("command.skipped", { command: check.display, reason: "declined by user" });
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
    log.error("command.failed", { command: check.display, error: result.error.message });
    return null;
  }
  if (result.status !== 0) {
    console.error(`    ${error("✗")} Exited with code ${result.status}: ${check.display}`);
    log.error("command.failed", { command: check.display, exitCode: result.status });
    return null;
  }

  console.log(`    ${sym.ok} Executed: ${check.display}`);
  log.info("command.executed", { command: check.display, cwd: process.cwd() });
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
  const schemaFailures: WriteResult["schemaFailures"] = [];

  // What the plan is made of, before anything lands. This is the line that
  // answers "what did the model actually ask for?" when a run goes wrong.
  log.debug("write.start", {
    dryRun,
    projectRoot,
    operations: summarizePlan(plan),
  });

  // ── 1. SchemaEdit entries — FIRST, and fatal on failure ─────────────
  //
  // The schema is the source of truth every other edit is derived from. When
  // this ran last and merely logged its failure, a failed schema edit left the
  // call sites renamed against an unrenamed schema — the exact structural
  // inconsistency this tool exists to prevent, inverted. Nothing else is
  // written unless the schema change lands.
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
      const msg = `No schema.prisma found for ${schemaEdit.op} on ${schemaEdit.model}`;
      console.error(`    ${error("✗")} ${msg}`);
      schemaFailures.push({ edit: schemaEdit, error: msg });
      log.error("write.schema.missing", { op: schemaEdit.op, model: schemaEdit.model });
      continue;
    }
    const relSchemaPath = path.relative(projectRoot, schemaPath);

    if (dryRun) {
      console.log(`\n  ${bold(relSchemaPath)} — schema edit: ${schemaEdit.op} on ${schemaEdit.model}.${schemaEdit.fieldName ?? ""}`);
      if (schemaEdit.op === "create_model") {
        console.log(`    ${info("+")} new model ${bold(schemaEdit.model)}`);
        if (schemaEdit.modelBody) {
          for (const line of schemaEdit.modelBody.split("\n")) {
            console.log(`    ${info("│")} ${line}`);
          }
        }
      } else if (schemaEdit.op === "remove_model") {
        console.log(`    ${error("−")} model ${bold(schemaEdit.model)} ${error("removed")}`);
      } else if (schemaEdit.op === "add_field") {
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
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    ${error("✗")} Schema edit failed: ${msg}`);
      schemaFailures.push({ edit: schemaEdit, error: msg });
      log.error("write.schema.failed", {
        op: schemaEdit.op,
        model: schemaEdit.model,
        field: schemaEdit.fieldName,
        reason: msg,
      });
    }
  }

  // A schema edit that did not land makes every downstream file edit wrong.
  // Stop here so the working tree is left untouched rather than half-migrated.
  if (schemaFailures.length > 0 && !dryRun) {
    console.error(
      `    ${error("✗")} ${schemaFailures.length} schema edit(s) failed — skipping all file writes and commands`
    );
    log.error("write.aborted", { reason: "schema_failures", failed: schemaFailures.length });
    return { writtenPaths, executedCommands, staleEdits, createdPaths, createFailures, schemaFailures };
  }
  // ── 2. FileEdit entries ─────────────────────────────────────────────
  for (const item of plan) {
    if (item.type !== "file") continue;
    const fileEdit = item as FileEdit;

    const resolved = safeResolve(fileEdit.filePath, projectRoot, "file edit");
    if (!resolved) continue;
    const absPath = resolved.abs;
    fileEdit.filePath = resolved.rel;
    for (const e of fileEdit.edits) e.filePath = resolved.rel;

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
        log.info("write.file", { path: absPath, outcome: "created", edits: 1 });
        continue;
      }
      console.error(`    ${error("✗")} File does not exist and no creation edit: ${absPath}`);
      log.error("write.file.missing", { path: absPath, edits: fileEdit.edits.length });
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
      log.info("write.file", {
        path: absPath,
        outcome: "updated",
        edits: fileEdit.edits.length,
      });
    } catch (err) {
      if (err instanceof StaleEditError || err instanceof AmbiguousEditError) {
        // Collect for retry — do NOT write anything for this file
        console.error(`    ${error("✗")} ${err.message}`);
        staleEdits.push({ edit: fileEdit, error: err });
        log.warn("write.file.stale", {
          path: absPath,
          reason: err instanceof StaleEditError ? "stale" : "ambiguous",
          detail: err.message,
        });
      } else {
        throw err;
      }
    }
  }

  // ── 3. CreateFile entries ───────────────────────────────────────────
  for (const item of plan) {
    if (item.type !== "create_file") continue;
    const createOp = item as CreateFile;

    const resolved = safeResolve(createOp.filePath, projectRoot, "file creation");
    if (!resolved) continue;
    const absPath = resolved.abs;
    createOp.filePath = resolved.rel;

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
      log.error("write.create.exists", { path: absPath, reason: createOp.reason });
      continue;
    }

    // Syntax sanity check before writing
    const syntaxCheck = checkSyntax(createOp.content, createOp.filePath);
    if (!syntaxCheck.ok) {
      console.error(`    ${error("✗")} ${syntaxCheck.reason}`);
      createFailures.push({ edit: createOp, error: syntaxCheck.reason });
      log.error("write.create.syntax", { path: absPath, reason: syntaxCheck.reason });
      continue;
    }

    const dir = path.dirname(absPath);
    ensureDir(dir);
    fs.writeFileSync(absPath, createOp.content, "utf-8");
    console.log(`    ${sym.ok} Created: ${absPath} ${info(`— ${createOp.reason}`)}`);
    createdPaths.push(absPath);
    log.info("write.create", { path: absPath, reason: createOp.reason, bytes: createOp.content.length });
  }

  // ── 4. CommandAction entries ─────────────────────────────────────────
  for (const item of plan) {
    if (item.type !== "command") continue;
    const cmd = item as CommandAction;
    const ran = await runCommand(cmd.command, dryRun, yes, onBeforeCommand);
    if (ran) executedCommands.push(ran);
  }

  const summary = {
    written: writtenPaths.length,
    created: createdPaths.length,
    executed: executedCommands.length,
    stale: staleEdits.length,
    createFailures: createFailures.length,
    schemaFailures: schemaFailures.length,
    paths: [...writtenPaths, ...createdPaths],
    commands: executedCommands,
  };
  if (summary.schemaFailures > 0 || summary.createFailures > 0) {
    log.error("write.complete", summary);
  } else {
    log.info("write.complete", summary);
  }

  return { writtenPaths, executedCommands, staleEdits, createdPaths, createFailures, schemaFailures };
}

/** Counts per operation kind, plus the paths touched. */
function summarizePlan(plan: EditPlan): LogFields {
  const counts: Record<string, number> = {};
  const paths: string[] = [];
  for (const item of plan) {
    counts[item.type] = (counts[item.type] ?? 0) + 1;
    if (item.type === "file" || item.type === "create_file") paths.push(item.filePath);
  }
  return { counts, paths };
}
