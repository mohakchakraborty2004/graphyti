/** Shared Prisma-command injection tests. Run with `npm run test:prisma-commands`. */

import type { EditPlan } from "../generate/scopedEdit";
import { injectPrismaCommands } from "../utils/prismaCommands";

let failures = 0;
let checks = 0;

function ok(condition: boolean, label: string): void {
  checks++;
  if (condition) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.error(`  FAIL  ${label}`);
  }
}

function commands(plan: EditPlan): string[] {
  return plan.filter((action) => action.type === "command").map((action) => action.command);
}

console.log("Prisma command injection");

const removal: EditPlan = [{ type: "schema", model: "LikeDislike", op: "remove_model" }];
injectPrismaCommands(removal);
ok(
  JSON.stringify(commands(removal)) === JSON.stringify([
    "npx prisma migrate dev --name drop_LikeDislike",
    "npx prisma generate",
  ]),
  "a removed model schedules migration and client generation"
);

injectPrismaCommands(removal);
ok(commands(removal).length === 2, "running injection twice never duplicates Prisma commands");

const malformed: EditPlan = [
  { type: "schema", model: "Post", op: "add_field", fieldName: "headline", fieldType: "String?" },
  { type: "command", command: "npx prisma migrate reset" },
];
injectPrismaCommands(malformed);
ok(
  commands(malformed).includes("npx prisma migrate dev --name add_headline") &&
    commands(malformed).includes("npx prisma generate"),
  "a malformed model command cannot suppress the safe Prisma follow-up commands"
);

const noSchema: EditPlan = [{ type: "command", command: "npm install zod" }];
injectPrismaCommands(noSchema);
ok(commands(noSchema).length === 1, "a non-schema request gains no Prisma commands");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exitCode = failures === 0 ? 0 : 1;
