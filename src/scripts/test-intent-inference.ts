/** Local, no-network tests for deterministic Prisma intent recognition. */

import { inferSchemaIntent } from "../generate/scopedEdit";

const schema = `
model User {
  id Int @id
  posts Post[]
}

model Post {
  id Int @id
}
`;

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

console.log("Local schema intent recognition");

ok(
  JSON.stringify(inferSchemaIntent("remove post model", schema)) ===
    JSON.stringify([{ type: "schema", model: "Post", op: "remove_model" }]),
  "recognises a model removal regardless of casing"
);
ok(
  JSON.stringify(inferSchemaIntent("delete the model User", schema)) ===
    JSON.stringify([{ type: "schema", model: "User", op: "remove_model" }]),
  "recognises model-first phrasing"
);
ok(inferSchemaIntent("remove Comment model", schema) === null, "never invents a model absent from the schema");
ok(inferSchemaIntent("remove post model") === null, "requires an actual schema before bypassing the model");
ok(inferSchemaIntent("add a headline to Post", schema) === null, "leaves non-removal requests to the model");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exitCode = failures === 0 ? 0 : 1;
