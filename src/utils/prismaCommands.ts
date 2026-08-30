/**
 * Prisma follow-up commands shared by the CLI and Ink pipelines.
 *
 * A schema edit is not complete until the migration and generated client are
 * current. Keeping this in one module prevents the interactive UI from
 * silently diverging from the CLI and leaving those steps to the user.
 */

import type { EditPlan, SchemaEdit } from "../generate/scopedEdit";
import { parseAllowedCommand, type AllowedRule } from "./commandAllowlist";

function schemaEditsOf(actions: EditPlan): SchemaEdit[] {
  return actions.filter((action): action is SchemaEdit => action.type === "schema");
}

function hasAllowedCommand(actions: EditPlan, rule: AllowedRule): boolean {
  return actions.some((action) => {
    if (action.type !== "command") return false;
    const parsed = parseAllowedCommand(action.command);
    return parsed.ok && parsed.rule === rule;
  });
}

/**
 * Append the required Prisma lifecycle commands after a schema edit.
 *
 * Only an already-valid, already-allowlisted command satisfies the duplicate
 * check. A malformed model command such as `prisma migrate reset` must not
 * suppress the safe migration the pipeline itself adds.
 */
export function injectPrismaCommands(actions: EditPlan): void {
  const schemaOps = schemaEditsOf(actions);
  if (schemaOps.length === 0) return;

  const migrationName = schemaOps
    .map((op) => {
      const field = op.fieldName ?? op.model;
      switch (op.op) {
        case "add_field": return `add_${field}`;
        case "remove_field": return `remove_${field}`;
        case "rename_field": return `rename_${field}`;
        case "change_type": return `change_${field}`;
        case "create_model": return `create_${op.model}`;
        case "remove_model": return `drop_${op.model}`;
      }
    })
    .join("_")
    .slice(0, 64);

  if (!hasAllowedCommand(actions, "npx prisma migrate dev")) {
    actions.push({ type: "command", command: `npx prisma migrate dev --name ${migrationName}` });
  }
  if (!hasAllowedCommand(actions, "npx prisma generate")) {
    actions.push({ type: "command", command: "npx prisma generate" });
  }
}
