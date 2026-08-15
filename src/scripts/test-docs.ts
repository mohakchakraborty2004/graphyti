/**
 * Tests that the README's `file.ts:NN` citations still point at what they claim.
 *
 * The README documents every HydraDB call site by exact line number. Those
 * numbers are the first thing to rot — the config refactor alone shifted 24 of
 * them, and a citation that has drifted onto a blank line or a bare `try {`
 * reads as documentation while pointing at nothing. Run with:
 *   npm run test:docs
 *
 * Two levels of checking, by citation kind:
 *   - Table rows (`| claim | [`src/x.ts:12`](…) |`) name a symbol in the first
 *     column. The cited line, plus a small window around it, must contain one
 *     of the identifiers backticked in that claim. This is self-maintaining:
 *     the expectation is read out of the README row, so there is no parallel
 *     table to keep in sync.
 *   - Prose citations ("Invoked by … → [`src/cli/init-graph.ts:8`]") name no
 *     symbol, so they are only checked for existence, range, and for landing on
 *     a line with actual content.
 *
 * Both kinds also assert the markdown link anchor (#Lnn) agrees with the label,
 * since a mismatch sends the reader somewhere the text does not claim.
 */

import fs from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const README = path.join(REPO_ROOT, "README.md");

let passed = true;

function fail(label: string, detail: string): void {
  console.log(`  ❌ FAIL  ${label}`);
  console.log(`           ${detail}`);
  passed = false;
}

function pass(label: string, note = ""): void {
  console.log(`  ✅ PASS  ${label}${note ? `  ${note}` : ""}`);
}

/**
 * Lines that carry no evidence of anything. A citation landing on one of these
 * is the signature of drift, not a real anchor.
 */
const CONTENT_FREE = new Set([
  "",
  "{",
  "}",
  "};",
  ");",
  "});",
  "try {",
  "} catch {",
  "let envelope;",
  "*",
  "/**",
  "*/",
]);

/** How many lines either side of the citation still count as "at" it. */
const WINDOW = 2;

interface Citation {
  file: string;
  line: number;
  /** The README line it appeared on. */
  source: string;
  /** True when the citation sits in a markdown table row. */
  isTableRow: boolean;
  /** Anchor line from the (path#Lnn) link, if the citation had one. */
  anchor?: number;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

const readmeLines = fs.readFileSync(README, "utf-8").split(/\r?\n/);
const citations: Citation[] = [];

for (const source of readmeLines) {
  const labels = [...source.matchAll(/`(src\/[A-Za-z/.\-]+\.ts):(\d+)`/g)];
  if (labels.length === 0) continue;

  for (const match of labels) {
    const file = match[1];
    const line = Number(match[2]);
    // The anchor for this same path, if the label is wrapped in a link.
    const anchorMatch = source.match(
      new RegExp(`\\(${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}#L(\\d+)\\)`)
    );
    citations.push({
      file,
      line,
      source,
      isTableRow: source.trimStart().startsWith("|"),
      anchor: anchorMatch ? Number(anchorMatch[1]) : undefined,
    });
  }
}

console.log(`\n=== README CITATIONS (${citations.length}) ===`);

if (citations.length === 0) {
  fail("parse", "no `src/*.ts:NN` citations found in README.md — did the format change?");
}

/**
 * Identifiers worth checking from a claim: whatever is backticked, minus the
 * citation itself, tokenised into identifier chains of 4+ characters.
 *
 * Dotted chains are kept whole. Splitting `client.context.status` into its
 * segments would let a bare `status` anywhere nearby satisfy the claim, which
 * is exactly the drift this file exists to catch — a citation that slid off
 * `client.context.status` onto an unrelated `result.status` must fail.
 */
function claimedSymbols(source: string, file: string): string[] {
  const spans = [...source.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1])
    .filter((span) => !span.includes(file));

  const symbols = new Set<string>();
  for (const span of spans) {
    for (const token of span.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g) ?? []) {
      if (token.length >= 4) symbols.add(token);
    }
  }
  return [...symbols];
}

const fileCache = new Map<string, string[]>();

function readSource(file: string): string[] | null {
  if (!fileCache.has(file)) {
    const abs = path.join(REPO_ROOT, file);
    if (!fs.existsSync(abs)) return null;
    fileCache.set(file, fs.readFileSync(abs, "utf-8").split(/\r?\n/));
  }
  return fileCache.get(file)!;
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

for (const citation of citations) {
  const { file, line } = citation;
  const label = `${file}:${line}`;

  const lines = readSource(file);
  if (lines === null) {
    fail(label, "cited file does not exist");
    continue;
  }

  if (line < 1 || line > lines.length) {
    fail(label, `line is out of range — ${file} has ${lines.length} lines`);
    continue;
  }

  if (citation.anchor !== undefined && citation.anchor !== line) {
    fail(label, `link anchor points at #L${citation.anchor} but the label says :${line}`);
    continue;
  }

  const text = lines[line - 1].trim();
  if (CONTENT_FREE.has(text)) {
    fail(label, `lands on a content-free line: ${JSON.stringify(lines[line - 1])}`);
    continue;
  }

  // Prose citations claim no symbol — a real line of code is all they promise.
  if (!citation.isTableRow) {
    pass(label, `(prose) ${text.slice(0, 58)}`);
    continue;
  }

  const symbols = claimedSymbols(citation.source, file);
  if (symbols.length === 0) {
    pass(label, `(no symbol claimed) ${text.slice(0, 44)}`);
    continue;
  }

  const from = Math.max(0, line - 1 - WINDOW);
  const to = Math.min(lines.length, line + WINDOW);
  const window = lines.slice(from, to).join("\n");
  const hit = symbols.find((symbol) => window.includes(symbol));

  if (hit === undefined) {
    fail(
      label,
      `none of the claimed symbols [${symbols.slice(0, 6).join(", ")}] appear within ` +
        `±${WINDOW} lines. Line reads: ${JSON.stringify(text)}`
    );
    continue;
  }

  pass(label, `${hit}`);
}

// ---------------------------------------------------------------------------
// Every path the README mentions at all must exist
// ---------------------------------------------------------------------------

console.log("\n=== README FILE REFERENCES ===");

const referenced = new Set<string>();
for (const source of readmeLines) {
  for (const match of source.matchAll(/`(src\/[A-Za-z/.\-]+\.ts)`/g)) {
    referenced.add(match[1]);
  }
}

let allExist = true;
for (const file of [...referenced].sort()) {
  if (!fs.existsSync(path.join(REPO_ROOT, file))) {
    fail(file, "referenced in README but not present in the repo");
    allExist = false;
  }
}
if (allExist) pass(`all ${referenced.size} referenced source files exist`);

console.log(
  passed ? `\n✅ README citations are accurate` : `\n❌ Some README citations have drifted`
);
process.exit(passed ? 0 : 1);
