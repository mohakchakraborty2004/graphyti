/**
 * Blast radius + structural verification tests.
 *
 * Run with: npx tsx src/scripts/test-blast-radius.ts
 *
 * These run against a real fixture project on disk and a real extracted graph.
 * No HydraDB, no LLM — everything asserted here is deterministic.
 *
 * The properties under test are the ones that were actually broken:
 *   - a field rename must not drag in dependents of neighbouring models
 *   - a file that never names the symbol must not be reported as affected
 *   - a bare word match with no graph edge is advisory, never enforced
 *   - one file must appear once, not once per node kind that owns it
 *   - verification must catch a file that still names the old field
 *   - two breaking changes must not be checked against each other's fields
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { extractAll } from "../extract";
import { adjacencyFromEdges, saveGraphMap, toGraphMapEntry, type GraphMap } from "../graph/ingest";
import { computeBlastRadius, blastRadiusSize } from "../graph/blastRadius";
import { verifyStructuralChange } from "../verify/verifyChange";
import { computeExpectedDelta } from "../graph/expectedDelta";
import { resolveProjectPath } from "../utils/paths";
import {
  validateEditPlan,
  applySchemaEdit,
  applyScopedEdits,
  pruneRedundantSteps,
  StaleEditError,
} from "../generate/scopedEdit";
import { findFieldReferences } from "../verify/symbolRefs";

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

let failures = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    console.log(`  PASS  ${msg}`);
  } else {
    console.error(`  FAIL  ${msg}`);
    failures++;
  }
}

function assertSetEqual(actual: string[], expected: string[], label: string): void {
  const a = [...actual].sort();
  const e = [...expected].sort();
  if (JSON.stringify(a) === JSON.stringify(e)) {
    console.log(`  PASS  ${label}`);
  } else {
    console.error(`  FAIL  ${label}`);
    console.error(`        expected ${JSON.stringify(e)}`);
    console.error(`        actual   ${JSON.stringify(a)}`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const FILES: Record<string, string> = {
  "tsconfig.json": JSON.stringify(
    { compilerOptions: { jsx: "react-jsx", target: "ES2022", module: "ESNext", strict: true } },
    null,
    2
  ),

  "prisma/schema.prisma": `datasource db {
  provider = "postgresql"
}

model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
  phone String
  posts Post[]
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  authorId Int?
  author   User?  @relation(fields: [authorId], references: [id])
}
`,

  "app/api/users/route.ts": `import { prisma } from "../../../lib/prisma";

export async function GET() {
  const users = await prisma.user.findMany({ select: { id: true, email: true } });
  return Response.json(users);
}
`,

  "app/api/posts/route.ts": `import { prisma } from "../../../lib/prisma";

export async function GET() {
  const posts = await prisma.post.findMany({ select: { id: true, title: true, authorId: true } });
  return Response.json(posts);
}
`,

  "app/posts/page.tsx": `"use client";
import { useEffect, useState } from "react";

export default function PostsPage() {
  const [posts, setPosts] = useState<any[]>([]);
  useEffect(() => {
    fetch("/api/posts").then((r) => r.json()).then(setPosts);
  }, []);
  return <div>{posts.map((p) => <h2 key={p.id}>{p.title}</h2>)}</div>;
}
`,

  // The false-positive trap: names "title" in page metadata, but has no graph
  // edge to Post.title. A blind text sweep would enforce a change here and
  // block every correct rename of Post.title.
  "app/layout.tsx": `export const metadata = { title: "Fixture App" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,

  // Renders post.title but fetches /api/users, which queries User — so the
  // extractor cannot pin `title` to a model and emits no edge at all. A
  // graph-only radius loses this file; it still breaks on a rename.
  "components/UserList.tsx": `"use client";
import { useEffect, useState } from "react";

interface Post { id: number; title?: string | null }
interface User { id: number; email: string; posts?: Post[] }

export default function UserList() {
  const [users, setUsers] = useState<User[]>([]);
  useEffect(() => {
    fetch("/api/users").then((r) => r.json()).then(setUsers);
  }, []);
  return <ul>{users.map((u) => <li key={u.id}>{u.posts?.map((p) => p.title)}</li>)}</ul>;
}
`,

  // Names "title" only as a parameter. Nothing here breaks when Post.title is
  // renamed, so it must stay out of the enforced set.
  "lib/format.ts": `export function formatTitle(title: string): string {
  return title.trim();
}
`,

  "lib/prisma.ts": `export const prisma: any = {};
`,
};

function buildFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphyti-blast-"));
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
  }

  // Build the local graph cache exactly the way init-graph does, minus HydraDB.
  const { nodes, edges } = extractAll(root);
  const adj = adjacencyFromEdges(edges);
  const map: GraphMap = {};
  for (const node of nodes) {
    map[node.id] = toGraphMapEntry(node, adj.get(node.id) ?? [], nodes);
  }
  saveGraphMap(root, map);
  return root;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testUnreferencedFieldHasEmptyRadius(root: string) {
  console.log("\n=== Renaming a field nothing references ===\n");

  const result = await computeBlastRadius({ model: "User", field: "phone" }, root, {
    checkRemote: false,
  });

  // No source file in the fixture contains `phone`. The honest answer is zero.
  // The old undirected 3-hop walk from `model:User` returned four files here:
  // both routes and both components, reached through `Post.author -> User`.
  assertSetEqual(result.affectedFilePaths, [], "User.phone affects no files");
  assert(blastRadiusSize(result) === 0, "blast radius size is 0");
  assert(
    !result.affectedFilePaths.includes("app/api/posts/route.ts"),
    "does not leak into /api/posts through the Post.author relation"
  );
  assert(
    !result.affectedFilePaths.includes("app/posts/page.tsx"),
    "does not leak into app/posts/page.tsx"
  );
  assert(result.staleNodes.length === 0, "no stale nodes in a freshly extracted graph");
}

async function testReferencedFieldRadius(root: string) {
  console.log("\n=== Renaming a field that is genuinely used ===\n");

  const result = await computeBlastRadius({ model: "Post", field: "title" }, root, {
    checkRemote: false,
  });

  assertSetEqual(
    result.affectedFilePaths,
    ["app/api/posts/route.ts", "app/posts/page.tsx", "components/UserList.tsx"],
    "Post.title affects the route that selects it, the page that renders it, and the unlinked component that also renders it"
  );

  // Precision: a word match in a non-field position must not be enforced.
  assert(
    !result.affectedFilePaths.includes("app/layout.tsx"),
    "app/layout.tsx is NOT enforced — its `metadata = { title }` is not a field reference"
  );
  assert(
    result.advisoryFiles.some((f) => f.filePath === "app/layout.tsx"),
    "app/layout.tsx is surfaced as advisory instead"
  );
  assert(
    !result.affectedFilePaths.includes("lib/format.ts"),
    "lib/format.ts is NOT enforced — `title` there is a parameter name"
  );
  assert(
    !result.affectedFilePaths.includes("app/api/users/route.ts"),
    "the unrelated users route is excluded"
  );

  // Recall: a real consumer the extractor could not link is still enforced.
  const userList = [
    ...result.affectedRoutes,
    ...result.affectedComponents,
    ...result.affectedFiles,
  ].find((n) => n.filePath === "components/UserList.tsx");
  assert(
    userList !== undefined && /no graph edge/.test(userList.reason),
    "UserList.tsx is enforced and its reason explains the missing edge"
  );

  const everyNode = [
    ...result.affectedRoutes,
    ...result.affectedComponents,
    ...result.affectedFiles,
  ];
  assert(
    new Set(everyNode.map((n) => n.filePath)).size === everyNode.length,
    "each file appears exactly once, not once per node kind"
  );
}

async function testVerificationCatchesLeftovers(root: string) {
  console.log("\n=== Verification of a rename ===\n");

  const blastRadius = await computeBlastRadius({ model: "Post", field: "title" }, root, {
    checkRemote: false,
  });

  const routeAbs = path.join(root, "app/api/posts/route.ts");
  const pageAbs = path.join(root, "app/posts/page.tsx");
  const listAbs = path.join(root, "components/UserList.tsx");

  const fixed = (abs: string, to = "heading") =>
    fs.readFileSync(abs, "utf-8").replace(/\btitle\b/g, to);

  const passing = verifyStructuralChange(
    [{ blastRadius, oldFields: ["title"] }],
    [
      { path: routeAbs, content: fixed(routeAbs) },
      { path: pageAbs, content: fixed(pageAbs) },
      { path: listAbs, content: fixed(listAbs) },
    ],
    root
  );
  assert(passing.missed.length === 0, "all files updated => 0 missed");
  assert(passing.addressed.length === 3, "all files updated => 3 addressed");

  const partial = verifyStructuralChange(
    [{ blastRadius, oldFields: ["title"] }],
    [
      { path: routeAbs, content: fixed(routeAbs) },
      { path: listAbs, content: fixed(listAbs) },
    ],
    root
  );
  assert(partial.missed.length === 1, "one file left behind => 1 missed");
  assert(
    partial.missed[0]?.filePath === "app/posts/page.tsx",
    "the missed file is the one that was not regenerated"
  );
  assert(
    partial.retryPrompt.includes("app/posts/page.tsx"),
    "retry prompt names the missed file"
  );

  // `\btitle\b` must not match inside `titleText` — otherwise a rename to a
  // superstring would be reported as never having happened.
  const superstring = verifyStructuralChange(
    [{ blastRadius, oldFields: ["title"] }],
    [
      { path: routeAbs, content: fixed(routeAbs, "titleText") },
      { path: pageAbs, content: fixed(pageAbs, "titleText") },
      { path: listAbs, content: fixed(listAbs, "titleText") },
    ],
    root
  );
  assert(
    superstring.missed.length === 0,
    "renaming title -> titleText is not mistaken for a leftover title"
  );

  // Verification must use the same predicate as the radius. A leftover in a
  // non-field position (a parameter named `title`) is not a dangling reference.
  const paramOnly = verifyStructuralChange(
    [{ blastRadius, oldFields: ["title"] }],
    [
      { path: routeAbs, content: fixed(routeAbs) },
      { path: listAbs, content: fixed(listAbs) },
      {
        path: pageAbs,
        content: `${fixed(pageAbs)}\nexport function pad(title: string) { return title; }\n`,
      },
    ],
    root
  );
  assert(
    paramOnly.missed.length === 0,
    "a parameter named title is not counted as a leftover field reference"
  );

  // ...but a genuine leftover member access is.
  const realLeftover = verifyStructuralChange(
    [{ blastRadius, oldFields: ["title"] }],
    [
      { path: routeAbs, content: fixed(routeAbs) },
      { path: listAbs, content: fixed(listAbs) },
      { path: pageAbs, content: `${fixed(pageAbs)}\nconst x = somePost.title;\n` },
    ],
    root
  );
  assert(
    realLeftover.missed.length === 1,
    "a leftover `somePost.title` member access is caught"
  );
}

function testSymbolReferenceKinds() {
  console.log("\n=== Which occurrences count as a field reference ===\n");

  const counts = (src: string, file = "x.tsx") => findFieldReferences(src, file, "title").length;

  assert(counts("const t = post.title;") === 1, "property access counts");
  assert(counts('const t = post["title"];') === 1, "element access counts");
  assert(counts("const { title } = post;") === 1, "destructuring counts");
  assert(counts("const { title: h } = post;") === 1, "renamed destructuring counts");
  assert(counts("interface P { title?: string }") === 1, "type member counts");
  assert(
    counts("prisma.post.findMany({ select: { title: true } });") === 1,
    "an object key inside a call argument counts"
  );
  assert(
    counts("prisma.post.findMany({ where: { author: { posts: { some: { title: 'x' } } } } });") === 1,
    "a deeply nested key inside a call argument counts"
  );

  assert(
    counts('export const metadata = { title: "App" };') === 0,
    "a plain object literal key does NOT count"
  );
  assert(
    counts("export function f(title: string) { return title; }") === 0,
    "a parameter name and its uses do NOT count"
  );
  assert(counts("const titleText = 1;") === 0, "a superstring does NOT count");
  assert(counts("const formatTitle = 1;") === 0, "a substring in another name does NOT count");

  // Unparsable content must fail towards over-reporting, never towards silence.
  assert(
    findFieldReferences("const x = { title: <<<>>>", "broken.ts", "title").length > 0,
    "unparsable content that names the field is treated as a reference"
  );
  assert(
    findFieldReferences("title = 1", "notes.md", "title").length > 0,
    "a non-TypeScript file falls back to a word match"
  );
}

async function testNoCrossContamination(root: string) {
  console.log("\n=== Two breaking changes at once ===\n");

  const postBlast = await computeBlastRadius({ model: "Post", field: "title" }, root, {
    checkRemote: false,
  });
  const userBlast = await computeBlastRadius({ model: "User", field: "email" }, root, {
    checkRemote: false,
  });

  // Rename BOTH fields everywhere, then check each radius against its own
  // field only. Every file in either radius must be supplied, or an unsupplied
  // one is judged on its unmodified disk content and reported as missed.
  const rename = (rel: string) =>
    fs
      .readFileSync(path.join(root, rel), "utf-8")
      .replace(/\btitle\b/g, "heading")
      .replace(/\bemail\b/g, "contact");

  const everyPath = [
    ...new Set([...postBlast.affectedFilePaths, ...userBlast.affectedFilePaths]),
  ];
  assert(everyPath.length > 0, "the two radii together cover at least one file");

  const result = verifyStructuralChange(
    [
      { blastRadius: postBlast, oldFields: ["title"] },
      { blastRadius: userBlast, oldFields: ["email"] },
    ],
    everyPath.map((rel) => ({ path: path.join(root, rel), content: rename(rel) })),
    root
  );

  assert(result.missed.length === 0, "both changes verified together => 0 missed");
  assert(
    result.addressed.length === new Set(result.addressed.map((e) => e.filePath)).size,
    "no duplicate entries when a file sits in two radii"
  );

  // The real cross-contamination check: leave `email` in place while fixing
  // only `title`. The Post change must not be failed by a lingering `email`,
  // and the User change must catch it — which is only possible if the two are
  // kept apart. Flattening the field names, as the callers used to do, blamed
  // the miss on whichever radius happened to be first.
  const titleOnly = everyPath.map((rel) => ({
    path: path.join(root, rel),
    content: fs.readFileSync(path.join(root, rel), "utf-8").replace(/\btitle\b/g, "heading"),
  }));

  const postOnly = verifyStructuralChange(
    [{ blastRadius: postBlast, oldFields: ["title"] }],
    titleOnly,
    root
  );
  assert(
    postOnly.missed.length === 0,
    "the Post change passes even though `email` is untouched"
  );

  const userOnly = verifyStructuralChange(
    [{ blastRadius: userBlast, oldFields: ["email"] }],
    titleOnly,
    root
  );
  assert(
    userOnly.missed.length > 0,
    "the User change still fails on the untouched `email`"
  );
}

function testPathNormalisation(root: string) {
  console.log("\n=== Path handling ===\n");

  const rootName = path.basename(root);

  const doubled = resolveProjectPath(`${rootName}/components/UserList.tsx`, root);
  assert(doubled?.rel === "components/UserList.tsx", "duplicated project-root prefix is stripped");
  assert(doubled?.corrected === true, "the correction is reported to the caller");

  const plain = resolveProjectPath("components/UserList.tsx", root);
  assert(plain?.rel === "components/UserList.tsx", "a normal relative path is untouched");
  assert(plain?.corrected === false, "an untouched path is not flagged as corrected");

  assert(resolveProjectPath("../outside.ts", root) === null, "a parent escape is refused");
  assert(resolveProjectPath("", root) === null, "an empty path is refused");

  // A genuinely new file under a same-named subdirectory must survive: the
  // prefix is only stripped when doing so lands on a file that exists.
  const newFile = resolveProjectPath(`${rootName}/brand-new.ts`, root);
  assert(
    newFile?.rel === `${rootName}/brand-new.ts`,
    "a new path is not rewritten just because it starts with the root name"
  );
}

function testPlanGuards() {
  console.log("\n=== Edit-plan guards ===\n");

  const schemaAsText = validateEditPlan([
    {
      type: "file",
      filePath: "prisma/schema.prisma",
      edits: [{ filePath: "prisma/schema.prisma", oldText: "phone String", newText: "phoneNo String" }],
    },
  ]);
  assert(!schemaAsText.ok, "a text edit on schema.prisma is rejected");
  assert(
    !schemaAsText.ok && schemaAsText.reason.includes('"type":"schema"'),
    "the rejection tells the model which shape to use instead"
  );

  const escaping = validateEditPlan([
    { type: "create_file", filePath: "../evil.ts", content: "", reason: "x" },
  ]);
  assert(!escaping.ok, "a path escaping the project root is rejected");

  const absolute = validateEditPlan([
    { type: "file", filePath: "/etc/passwd", edits: [{ filePath: "/etc/passwd", oldText: "a", newText: "b" }] },
  ]);
  assert(!absolute.ok, "an absolute path is rejected");

  const good = validateEditPlan([
    { type: "schema", model: "User", op: "rename_field", fieldName: "phone", newFieldName: "phoneNo" },
    {
      type: "file",
      filePath: "components/UserList.tsx",
      edits: [{ filePath: "components/UserList.tsx", oldText: "a", newText: "b" }],
    },
  ]);
  assert(good.ok, "a well-formed plan still passes");
}

function testSchemaEditIsPure(root: string) {
  console.log("\n=== applySchemaEdit({ write: false }) ===\n");

  const schemaPath = path.join(root, "prisma/schema.prisma");
  const before = fs.readFileSync(schemaPath, "utf-8");

  const proposed = applySchemaEdit(
    before,
    { type: "schema", model: "Post", op: "add_field", fieldName: "slug", fieldType: "String?" },
    schemaPath,
    root,
    { write: false }
  );

  assert(proposed.includes("slug"), "the proposed schema contains the new field");
  assert(
    fs.readFileSync(schemaPath, "utf-8") === before,
    "the file on disk is byte-identical afterwards"
  );

  // Applying twice from the same source must not accumulate — this is the
  // duplicate-field bug that came from verification committing its preview.
  const twice = applySchemaEdit(
    proposed,
    { type: "schema", model: "Post", op: "add_field", fieldName: "slug", fieldType: "String?" },
    schemaPath,
    root,
    { write: false }
  );
  const occurrences = (twice.match(/\bslug\b/g) ?? []).length;
  assert(occurrences === 2, `applying add_field to an already-edited schema duplicates (${occurrences}) — proving preview must not write`);
  assert(
    fs.readFileSync(schemaPath, "utf-8") === before,
    "disk is still untouched after the second preview"
  );
}

// ---------------------------------------------------------------------------
// Removing a model must be a complete, verifiable operation
// ---------------------------------------------------------------------------

function testModelRemoval(root: string) {
  console.log("\n=== Removing a Prisma model ===\n");

  const schemaPath = path.join(root, "prisma/schema.prisma");
  const onDisk = fs.readFileSync(schemaPath, "utf-8");
  const source = `datasource db {\n  provider = "postgresql"\n}\n\nmodel User {\n  id Int @id\n  likes LikeDislike[]\n}\n\nmodel Post {\n  id Int @id\n  likes LikeDislike[]\n}\n\nmodel LikeDislike {\n  id Int @id\n  user User @relation(fields: [userId], references: [id])\n  userId Int\n  post Post @relation(fields: [postId], references: [id])\n  postId Int\n}\n`;
  const edit = { type: "schema" as const, model: "LikeDislike", op: "remove_model" as const };
  const proposed = applySchemaEdit(source, edit, schemaPath, root, { write: false });

  assert(!proposed.includes("model LikeDislike"), "the target model block is removed");
  assert(!proposed.includes("LikeDislike[]"), "inverse relation fields are removed with the model");
  assert(
    fs.readFileSync(schemaPath, "utf-8") === onDisk,
    "remove_model preview leaves the working schema untouched"
  );

  const blast = {
    changedNode: { id: "model:LikeDislike", name: "LikeDislike", kind: "PrismaModel", filePath: "prisma/schema.prisma" },
    affectedRoutes: [],
    affectedComponents: [],
    affectedFiles: [{ id: "file:lib/likes.ts", name: "lib/likes.ts", filePath: "lib/likes.ts", reason: "uses LikeDislike" }],
    advisoryFiles: [],
    affectedFilePaths: ["lib/likes.ts"],
    filteredOut: [],
    staleNodes: [],
    graphMissing: false,
  };
  const delta = computeExpectedDelta(edit, blast, root);
  assert(
    delta.changeType === "remove" && delta.targetNodeId === "model:LikeDislike",
    "remove_model has a model-level expected delta instead of throwing Unknown op"
  );

  const missed = verifyStructuralChange(
    [{ blastRadius: blast, oldFields: [], removedModel: "LikeDislike" }],
    [{ path: path.join(root, "lib/likes.ts"), content: "const item: LikeDislike | null = null;" }],
    root
  );
  assert(missed.missed.length === 1, "local validation blocks a dangling removed-model reference");

  const addressed = verifyStructuralChange(
    [{ blastRadius: blast, oldFields: [], removedModel: "LikeDislike" }],
    [{ path: path.join(root, "lib/likes.ts"), content: "export const likesRemoved = true;" }],
    root
  );
  assert(addressed.addressed.length === 1, "local validation clears the file once the model reference is gone");
}

// ---------------------------------------------------------------------------
// A stale graph must not silently answer "nothing is affected"
// ---------------------------------------------------------------------------

async function testStaleGraphStillFindsDependents(root: string) {
  console.log("\n=== A graph that has never seen the field ===\n");

  const mapPath = path.join(root, ".dbagent", "graph-map.json");
  const original = fs.readFileSync(mapPath, "utf-8");

  // Drop every node for Post — field AND model — the way a graph left over from
  // before the model existed, or from a half-finished rename, would look.
  const map: GraphMap = JSON.parse(original);
  for (const id of Object.keys(map)) {
    if (id === "model:Post" || id.startsWith("field:Post.")) delete map[id];
  }
  fs.writeFileSync(mapPath, JSON.stringify(map, null, 2), "utf-8");

  try {
    const result = await computeBlastRadius({ model: "Post", field: "title" }, root, {
      checkRemote: false,
    });

    // The old code returned an empty radius here. That let a rename through
    // with "nothing else to update", and verification then had nothing to
    // verify — so every consumer broke silently. The syntactic scan must still
    // run when the graph cannot help.
    assert(result.graphMissing, "the result is flagged as coming from a stale graph");
    assertSetEqual(
      result.affectedFilePaths,
      ["app/api/posts/route.ts", "app/posts/page.tsx", "components/UserList.tsx"],
      "the dependents are still found by scanning source"
    );
    assert(blastRadiusSize(result) === 3, "blast radius size is 3, not 0");
    assert(
      !result.affectedFilePaths.includes("app/layout.tsx"),
      "precision holds without the graph — metadata title stays advisory"
    );
    assert(
      !result.affectedFilePaths.includes("lib/format.ts"),
      "precision holds without the graph — a parameter named title stays advisory"
    );
    assert(
      result.changedNode.filePath === "prisma/schema.prisma",
      "the radius still anchors on the schema file"
    );

    const healthy = await computeBlastRadius({ model: "User", field: "phone" }, root, {
      checkRemote: false,
    });
    assert(!healthy.graphMissing, "a field the graph does know is not flagged");
  } finally {
    fs.writeFileSync(mapPath, original, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// An edit a previous step already made is satisfied, not stale
// ---------------------------------------------------------------------------

function testAlreadyAppliedEditsAreNotStale() {
  console.log("\n=== Re-applying an edit that is already in place ===\n");

  const after = "const x = { headline: 1 };\n";

  // Exactly what a multi-step plan does: step 2 quotes the pre-rename text of a
  // file step 1 has already rewritten. The old code threw StaleEditError, which
  // aborted the whole plan over work that had been done correctly.
  const already = applyScopedEdits(
    after,
    [{ filePath: "a.ts", oldText: "title: 1", newText: "headline: 1" }],
    "a.ts"
  );
  assert(already === after, "an already-applied edit is a no-op, not an error");

  // A genuinely stale edit — neither old nor new text present — must still throw.
  let threw = false;
  try {
    applyScopedEdits(
      after,
      [{ filePath: "a.ts", oldText: "caption: 1", newText: "subtitle: 1" }],
      "a.ts"
    );
  } catch (err) {
    threw = err instanceof StaleEditError;
  }
  assert(threw, "an edit whose newText is absent too still raises StaleEditError");

  // A mixed batch applies the outstanding edit and skips the finished one.
  const mixed = applyScopedEdits(
    "const a = { headline: 1, body: 2 };\n",
    [
      { filePath: "a.ts", oldText: "title: 1", newText: "headline: 1" },
      { filePath: "a.ts", oldText: "body: 2", newText: "content: 2" },
    ],
    "a.ts"
  );
  assert(
    mixed === "const a = { headline: 1, content: 2 };\n",
    "the outstanding edit in a mixed batch is still applied"
  );
}

// ---------------------------------------------------------------------------
// A file operation with nothing in it is not an operation
// ---------------------------------------------------------------------------

function testEmptyFileOpsAreDropped() {
  console.log("\n=== File operations with no edits ===\n");

  const onlyEmpty = validateEditPlan([{ type: "file", filePath: "a.ts", edits: [] }]);
  assert(onlyEmpty.ok, "a plan of no-op file operations is valid");
  assert(
    onlyEmpty.ok && onlyEmpty.plan.length === 0,
    "...but it normalises to an empty plan, so the caller reports no change"
  );

  const mixed = validateEditPlan([
    { type: "file", filePath: "a.ts", edits: [] },
    {
      type: "file",
      filePath: "b.ts",
      edits: [{ filePath: "b.ts", oldText: "x", newText: "y" }],
    },
  ]);
  assert(
    mixed.ok && mixed.plan.length === 1,
    "a real operation alongside a no-op survives on its own"
  );

  // Edits that are individually empty collapse the operation too.
  const hollow = validateEditPlan([
    { type: "file", filePath: "a.ts", edits: [{ filePath: "a.ts", oldText: "", newText: "" }] },
  ]);
  assert(
    hollow.ok && hollow.plan.length === 0,
    "an operation whose only edit is blank is dropped as well"
  );
}

// ---------------------------------------------------------------------------
// The classifier must not plan the propagation the radius already does
// ---------------------------------------------------------------------------

function testPropagationStepsArePruned() {
  console.log("\n=== Pruning propagation-only steps ===\n");

  const split = pruneRedundantSteps({
    decomposable: true,
    steps: [
      { description: "Rename User.phone field to phoneNo in Prisma schema", kind: "structural_edit" },
      { description: "Update phone references in apiClient and user routes", kind: "structural_edit" },
    ],
  });
  assert(split.steps.length === 1, "the propagation follow-up is dropped");
  assert(!split.decomposable, "a plan reduced to one step is no longer decomposable");
  assert(
    split.steps[0]!.description.includes("Rename"),
    "the step that does the real work is the one kept"
  );

  const usages = pruneRedundantSteps({
    decomposable: true,
    steps: [
      { description: "Remove Post.status", kind: "structural_edit" },
      { description: "Fix the components that use status", kind: "structural_edit" },
    ],
  });
  assert(usages.steps.length === 1, "a step naming the components that use X is recognised too");

  // Genuinely independent work must survive.
  const independent = pruneRedundantSteps({
    decomposable: true,
    steps: [
      { description: "Add a Tag model to the schema", kind: "structural_edit" },
      { description: "Create app/api/tags/route.ts", kind: "new_file" },
    ],
  });
  assert(independent.steps.length === 2, "independent steps are left alone");

  const newFile = pruneRedundantSteps({
    decomposable: true,
    steps: [
      { description: "Rename Post.title to heading", kind: "structural_edit" },
      { description: "Create a component that renders heading", kind: "new_file" },
    ],
  });
  assert(newFile.steps.length === 2, "a new_file step is never pruned, whatever it is called");

  const single = pruneRedundantSteps({
    decomposable: false,
    steps: [{ description: "Update the title references", kind: "structural_edit" }],
  });
  assert(single.steps.length === 1, "a lone step is never pruned away to nothing");
}

// ---------------------------------------------------------------------------
// Creating a file must actually be expressible
// ---------------------------------------------------------------------------

function testNewFileCreationIsExpressible() {
  console.log("\n=== Creating a new file ===\n");

  // The documented shape must validate.
  const direct = validateEditPlan([
    {
      type: "create_file",
      filePath: "components/PostSummary.tsx",
      content: "export default function PostSummary() { return null; }\n",
      reason: "renders the summary",
    },
  ]);
  assert(direct.ok, "a create_file operation validates");

  // The old shape the prompt used to ask for — a lone edit with an empty
  // oldText — died on ScopedEditSchema's min(1), which failed every new_file
  // step with "Too small: expected string to have >=1 characters". It must now
  // be converted rather than rejected.
  const legacy = validateEditPlan([
    {
      type: "file",
      filePath: "components/PostSummary.tsx",
      edits: [
        {
          filePath: "components/PostSummary.tsx",
          oldText: "",
          newText: "export default function PostSummary() { return null; }\n",
        },
      ],
    },
  ]);
  assert(legacy.ok, "the legacy empty-oldText shape no longer fails validation");
  assert(
    legacy.ok && legacy.plan.length === 1 && legacy.plan[0]!.type === "create_file",
    "…it is converted into a create_file operation"
  );
  assert(
    legacy.ok &&
      legacy.plan[0]!.type === "create_file" &&
      legacy.plan[0]!.content.includes("PostSummary"),
    "…carrying the full file content"
  );

  // A blank oldText mixed into a real edit batch is dropped, not fatal.
  const mixed = validateEditPlan([
    {
      type: "file",
      filePath: "a.ts",
      edits: [
        { filePath: "a.ts", oldText: "", newText: "junk" },
        { filePath: "a.ts", oldText: "x", newText: "y" },
      ],
    },
  ]);
  assert(mixed.ok, "a batch containing a blank oldText still validates");
  assert(
    mixed.ok && mixed.plan[0]!.type === "file" && mixed.plan[0]!.edits.length === 1,
    "…with the unusable edit dropped and the real one kept"
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Blast radius & structural verification tests ===");

  const root = buildFixture();
  console.log(`\nFixture: ${root}`);

  try {
    await testUnreferencedFieldHasEmptyRadius(root);
    await testReferencedFieldRadius(root);
    await testVerificationCatchesLeftovers(root);
    await testNoCrossContamination(root);
    testSymbolReferenceKinds();
    testPathNormalisation(root);
    testPlanGuards();
    testSchemaEditIsPure(root);
    testModelRemoval(root);
    await testStaleGraphStillFindsDependents(root);
    testAlreadyAppliedEditsAreNotStale();
    testEmptyFileOpsAreDropped();
    testPropagationStepsArePruned();
    testNewFileCreationIsExpressible();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log("");
  if (failures > 0) {
    console.error(`${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("All blast-radius tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
