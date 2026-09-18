/**
 * Tests for the unified structural validation in unifiedValidation.ts.
 *
 * Run with: npx tsx src/scripts/test-unified-validation.ts
 *
 * These cover the resolution rule and the local gate. The HydraDB round trip is
 * skipped (`skipGraphCheck`) because it needs a live database; the graph layer's
 * own behaviour is exercised by an integration run against sample-project.
 */

import { runUnifiedValidation, type ValidationChange } from "../verify/unifiedValidation";
import type { BlastRadiusResult, AffectedNode } from "../graph/blastRadius";
import type { ExpectedDelta } from "../graph/expectedDelta";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  ❌ FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✅ PASS: ${msg}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✅ PASS: ${label}`);
  } else {
    console.error(`  ❌ FAIL: ${label} — expected ${e}, got ${a}`);
    process.exitCode = 1;
  }
}

/** Build a complete BlastRadiusResult from just the nodes a test cares about. */
function blast(
  changedName: string,
  nodes: { routes?: AffectedNode[]; components?: AffectedNode[]; files?: AffectedNode[] }
): BlastRadiusResult {
  const affectedRoutes = nodes.routes ?? [];
  const affectedComponents = nodes.components ?? [];
  const affectedFiles = nodes.files ?? [];
  return {
    changedNode: {
      id: `field:${changedName}`,
      name: changedName,
      kind: "ModelField",
      filePath: "prisma/schema.prisma",
    },
    affectedRoutes,
    affectedComponents,
    affectedFiles,
    advisoryFiles: [],
    affectedFilePaths: [
      ...new Set(
        [...affectedRoutes, ...affectedComponents, ...affectedFiles].map((n) => n.filePath)
      ),
    ],
    filteredOut: [],
    staleNodes: [],
    graphMissing: false,
  };
}

function renameDelta(
  model: string,
  oldName: string,
  newName: string,
  refs: string[]
): ExpectedDelta {
  return {
    changeType: "rename",
    targetModel: model,
    targetNodeId: `field:${model}.${oldName}`,
    oldName,
    newName,
    expectedRemovedRefs: refs,
    expectedAddedRefs: refs,
  };
}

const ROOT = "/testbed";

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

async function testCleanRename() {
  console.log("\n=== Test (a): Clean rename — local check passes ===\n");

  const blastRadius = blast("Post.title", {
    routes: [
      {
        id: "route:/api/posts",
        name: "/api/posts",
        filePath: "app/api/posts/route.ts",
        reason: "selects Post.title",
      },
    ],
    components: [
      {
        id: "component:app/components/PostCard.tsx",
        name: "PostCard",
        filePath: "app/components/PostCard.tsx",
        reason: "renders Post.title",
      },
    ],
    files: [
      {
        id: "file:lib/posts.ts",
        name: "lib/posts.ts",
        filePath: "lib/posts.ts",
        reason: "imports app/api/posts/route.ts",
      },
    ],
  });

  const changes: ValidationChange[] = [
    {
      blastRadius,
      breakingFieldNames: ["title"],
      delta: renameDelta("Post", "title", "heading", blastRadius.affectedFilePaths),
    },
  ];

  const result = await runUnifiedValidation({
    changes,
    generatedFiles: [
      { path: `${ROOT}/app/api/posts/route.ts`, content: "const heading = post.heading;" },
      { path: `${ROOT}/app/components/PostCard.tsx`, content: "return <div>{post.heading}</div>;" },
      {
        path: `${ROOT}/lib/posts.ts`,
        content: "export const getPost = () => prisma.post.findMany({ select: { heading: true } });",
      },
    ],
    projectRoot: ROOT,
    skipGraphCheck: true,
  });

  assert(result.overallPassed, "overallPassed should be true");
  assertEqual(result.localCheck.missed, 0, "local check: 0 missed");
  assertEqual(result.localCheck.addressed, 3, "local check: 3 addressed");
  assert(result.summary.includes("PASSED"), "summary should include PASSED");
  console.log(`  Summary: ${result.summary}`);
}

async function testLocalCheckFailure() {
  console.log("\n=== Test (b): A leftover reference blocks the write ===\n");

  const blastRadius = blast("Post.title", {
    files: [
      {
        id: "file:lib/utils.ts",
        name: "lib/utils.ts",
        filePath: "lib/utils.ts",
        reason: "references Post.title",
      },
    ],
  });

  const result = await runUnifiedValidation({
    changes: [
      {
        blastRadius,
        breakingFieldNames: ["title"],
        delta: renameDelta("Post", "title", "heading", ["file:lib/utils.ts"]),
      },
    ],
    generatedFiles: [
      {
        path: `${ROOT}/lib/utils.ts`,
        content: "export const getPostTitle = (post: any) => post.title;",
      },
    ],
    projectRoot: ROOT,
    skipGraphCheck: true,
  });

  assert(!result.overallPassed, "overallPassed should be false");
  assertEqual(result.localCheck.missed, 1, "local check: 1 missed");
  assert(result.resolutionReason.includes("BLOCKED"), "resolution should say BLOCKED");
  assert(result.graphCheckSkipped, "graph check is skipped once local has failed");
  assert(
    result.localCheck.report.retryPrompt.includes("lib/utils.ts"),
    "retry prompt names the offending file"
  );
  console.log(`  Resolution: ${result.resolutionReason}`);
}

async function testFieldNamesDoNotCross() {
  console.log("\n=== Test (c): Two changes are checked independently ===\n");

  const postBlast = blast("Post.title", {
    files: [
      {
        id: "file:lib/posts.ts",
        name: "lib/posts.ts",
        filePath: "lib/posts.ts",
        reason: "references Post.title",
      },
    ],
  });
  const userBlast = blast("User.email", {
    files: [
      {
        id: "file:lib/users.ts",
        name: "lib/users.ts",
        filePath: "lib/users.ts",
        reason: "references User.email",
      },
    ],
  });

  const result = await runUnifiedValidation({
    changes: [
      {
        blastRadius: postBlast,
        breakingFieldNames: ["title"],
        delta: renameDelta("Post", "title", "heading", ["file:lib/posts.ts"]),
      },
      {
        blastRadius: userBlast,
        breakingFieldNames: ["email"],
        delta: renameDelta("User", "email", "contact", ["file:lib/users.ts"]),
      },
    ],
    generatedFiles: [
      // Still contains `email` — irrelevant, this file belongs to the Post change.
      {
        path: `${ROOT}/lib/posts.ts`,
        content: "export const heading = (p: any) => p.heading; export const email = 1;",
      },
      // Still contains `title` — irrelevant, this file belongs to the User change.
      {
        path: `${ROOT}/lib/users.ts`,
        content: "export const contact = (u: any) => u.contact; export const title = 1;",
      },
    ],
    projectRoot: ROOT,
    skipGraphCheck: true,
  });

  assert(result.overallPassed, "each file is checked only for its own change's field");
  assertEqual(result.localCheck.missed, 0, "local check: 0 missed");
  assertEqual(result.localCheck.addressed, 2, "local check: 2 addressed");
}

async function testAdditiveChangeIsANoOp() {
  console.log("\n=== Test (d): No breaking change => nothing to verify ===\n");

  const result = await runUnifiedValidation({
    changes: [],
    generatedFiles: [],
    projectRoot: ROOT,
    skipGraphCheck: true,
  });

  assert(result.overallPassed, "an additive change passes trivially");
  assertEqual(result.localCheck.missed, 0, "local check: 0 missed");
  assertEqual(result.localCheck.addressed, 0, "local check: 0 addressed");
}

// ---------------------------------------------------------------------------
// Run tests
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Unified Structural Validation Tests ===");

  await testCleanRename();
  await testLocalCheckFailure();
  await testFieldNamesDoNotCross();
  await testAdditiveChangeIsANoOp();

  console.log("");
  if (process.exitCode) {
    console.log("Some tests failed!");
    process.exit(1);
  }
  console.log("All tests passed!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
