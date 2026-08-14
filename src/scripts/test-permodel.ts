import { preWriteCheck } from "../generate/preWriteCheck";

async function run() {
  let passed = true;

  // -------------------------------------------------------------------------
  // Test 1: malformed schema (fewer models) → no blast radius, no breaking fields
  // -------------------------------------------------------------------------
  const malformedSchema = `
datasource db { provider = "postgresql" }
generator client { provider = "prisma-client-js" output = "../generated/prisma" }
model Post {
  id       Int    @id @default(autoincrement()) @relation(fields: [authorId], references: [id])
  headline String
}
`;
  const r1 = await preWriteCheck(
    [{ type: "file", directory: "prisma", fileName: "schema.prisma", content: malformedSchema, command: "", description: "" }],
    true, false, process.cwd()
  );
  const t1 = r1.blastResults.length === 0 && r1.breakingFieldNamesPerModel.length === 0;
  console.log("Test 1 — malformed schema skipped:", t1 ? "✅ PASS" : "❌ FAIL",
    `(blastResults=${r1.blastResults.length}, perModel=${r1.breakingFieldNamesPerModel.length})`);
  if (!t1) passed = false;

  // -------------------------------------------------------------------------
  // Test 2: rename Post.title → headline — breakingFieldNamesPerModel[0] = ["title"] only
  // -------------------------------------------------------------------------
  const renameSchema = `
datasource db { provider = "postgresql" }
generator client { provider = "prisma-client-js" output = "../generated/prisma" }
model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
  name  String?
  posts Post[]
}
model Post {
  id        Int       @id @default(autoincrement())
  headline  String
  content   String?
  published Boolean   @default(false)
  status    String    @default("DRAFT")
  authorId  Int
  author    User      @relation(fields: [authorId], references: [id])
  comments  Comment[]
}
model Comment {
  id     Int    @id @default(autoincrement())
  body   String
  postId Int
  post   Post   @relation(fields: [postId], references: [id])
}
`;
  const r2 = await preWriteCheck(
    [{ type: "file", directory: "prisma", fileName: "schema.prisma", content: renameSchema, command: "", description: "" }],
    true, false, process.cwd()
  );
  // Should have exactly 1 blast result for Post, with ["title"] only
  const postIdx = r2.blastResults.findIndex(br => br.changedNode.id === "model:Post");
  const postFields = postIdx >= 0 ? r2.breakingFieldNamesPerModel[postIdx] : [];
  const t2 = postIdx >= 0
    && postFields.length === 1
    && postFields[0] === "title"
    && !postFields.includes("author")
    && !postFields.includes("email");
  console.log("Test 2 — rename title→headline, Post fields:", postFields,
    t2 ? "✅ PASS" : "❌ FAIL");
  if (!t2) passed = false;

  // -------------------------------------------------------------------------
  // Test 3: no other model's fields bleed into Post's breaking list
  // -------------------------------------------------------------------------
  const userFields = r2.blastResults
    .map((br, i) => br.changedNode.id === "model:User" ? r2.breakingFieldNamesPerModel[i] : null)
    .find(Boolean) ?? [];
  const t3 = userFields.length === 0; // User had no breaking changes
  console.log("Test 3 — User has no breaking fields:", userFields,
    t3 ? "✅ PASS" : "❌ FAIL");
  if (!t3) passed = false;

  console.log(passed ? "\n✅ All tests passed" : "\n❌ Some tests failed");
  process.exit(passed ? 0 : 1);
}

run();
