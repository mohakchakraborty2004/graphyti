/**
 * Differential + property tests for the TUI text engine.
 *
 * Measurement is differential-tested against the exact `string-width` build that
 * Ink's renderer resolves, because layout math that disagrees with the renderer
 * by even one column is the root cause of every misaligned border. Ambiguous
 * -width glyphs are excluded from the comparison and asserted separately.
 *
 * Wrapping is property-tested: for any input and any width, no output line may
 * exceed the width. That invariant is what makes horizontal overflow impossible
 * rather than merely unlikely.
 */


import { pathToFileURL } from "url";
import path from "path";
import fs from "fs";
import {
  visualWidth,
  wrapText,
  wrapPath,
  truncateEnd,
  truncateMiddle,
  padEnd,
  cells,
} from "../tui/core/text";
import { UI_SYMBOLS, SPINNER_FRAMES, WIDE_UNSAFE } from "../tui/theme/tokens";

let failures = 0;
let checks = 0;

function ok(condition: boolean, label: string, detail?: string) {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
  }
}

function section(name: string) {
  console.log(`\n${name}`);
}

// ── Load the string-width Ink actually uses ──────────────────────────────────

/**
 * Resolve the `string-width` build Ink's renderer actually loads.
 *
 * npm may hoist it to the root or nest it under `ink/node_modules` depending on
 * version conflicts, and Ink's `exports` map blocks resolving through the
 * package — so probe the filesystem directly, preferring the nested copy since
 * that is the one Ink resolves when both exist.
 */
async function loadInkStringWidth(): Promise<{ fn: (s: string) => number; from: string } | null> {
  const modules = path.join(process.cwd(), "node_modules");
  const candidates = [
    path.join(modules, "ink", "node_modules", "string-width", "index.js"),
    path.join(modules, "string-width", "index.js"),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const mod = await import(pathToFileURL(candidate).href);
    return { fn: mod.default as (s: string) => number, from: candidate };
  }
  return null;
}

const CORPUS = [
  "",
  "hello world",
  "a",
  " ",
  "src/auth/session.ts",
  "npm run build -- --verbose",
  "https://example.com/a/b/c?query=1&other=2",
  "café",
  "café",
  "日本語テキスト",
  "한국어",
  "中文字符",
  "👍",
  "👨‍👩‍👦",
  "🚀 deploy",
  "ééé",
  "​zero",
  "ＦＵＬＬＷＩＤＴＨ",
  "mixed 日本 abc 👍 def",
  "─│┌┐└┘├┤┬┴┼",
  "╭╮╯╰",
  "❯ You",
  "● Agent",
  "✓ done",
  "✗ failed",
  "→ next",
  "· bullet",
  "…",
  "▸▾↑↓",
  "█",
  ...SPINNER_FRAMES,
];

async function testMeasurementAgainstInk() {
  section("measurement — differential vs Ink's string-width");

  const loaded = await loadInkStringWidth();
  if (!loaded) {
    console.log("  SKIP  could not resolve Ink's string-width");
    return;
  }
  const inkWidth = loaded.fn;
  console.log(`  using ${path.relative(process.cwd(), loaded.from)}`);

  const ambiguous = new Set<string>(WIDE_UNSAFE);

  for (const sample of CORPUS) {
    if ([...ambiguous].some((g) => sample.includes(g))) continue;
    const mine = visualWidth(sample);
    const theirs = inkWidth(sample);
    ok(
      mine === theirs,
      `width agrees on ${JSON.stringify(sample)}`,
      `ours=${mine} ink=${theirs}`
    );
  }

  // Every glyph in our vocabulary must be exactly one cell — that is the
  // property that lets us pad and align without measuring at call sites.
  for (const [name, glyph] of Object.entries(UI_SYMBOLS)) {
    const expected = name === "branch" || name === "branchLast" ? 2 : 1;
    ok(
      visualWidth(glyph) === expected,
      `symbol ${name} (${glyph}) is ${expected} cell(s)`,
      `got ${visualWidth(glyph)}`
    );
    ok(
      inkWidth(glyph) === expected,
      `symbol ${name} (${glyph}) is ${expected} cell(s) per Ink`,
      `got ${inkWidth(glyph)}`
    );
  }

  for (const frame of SPINNER_FRAMES) {
    ok(visualWidth(frame) === 1, `spinner frame ${frame} is 1 cell`);
  }

  const frameWidths = new Set(SPINNER_FRAMES.map(visualWidth));
  ok(frameWidths.size === 1, "all spinner frames share one width (no reflow)");
}

function testMeasurementBasics() {
  section("measurement — basics");

  ok(visualWidth("") === 0, "empty string is 0");
  ok(visualWidth("abc") === 3, "ascii is 1 cell per char");
  ok(visualWidth("日本語") === 6, "CJK is 2 cells per char");
  ok(visualWidth("👍") === 2, "emoji presentation is 2 cells");
  ok(visualWidth("é") === 1, "combining mark adds no width");
  ok(visualWidth("​") === 0, "zero-width space is 0");
  ok(visualWidth("[31mred[39m") === 3, "ANSI escapes are ignored");
  ok(visualWidth("⚠") === 1, "bare U+26A0 is narrow");
  ok(visualWidth("⚠️") === 2, "U+26A0 + VS16 is wide");

  const clusters = cells("a日👍");
  ok(clusters.length === 3, "cells() segments by grapheme");
  ok(
    clusters.map((c) => c.width).join(",") === "1,2,2",
    "cells() reports per-grapheme widths",
    clusters.map((c) => c.width).join(",")
  );

  ok(visualWidth(padEnd("ab", 5)) === 5, "padEnd reaches exact width");
  ok(visualWidth(padEnd("日本", 5)) === 5, "padEnd accounts for wide chars");
  ok(padEnd("abcdef", 3) === "abcdef", "padEnd never truncates");
}

const WRAP_CORPUS = [
  "",
  "short",
  "the quick brown fox jumps over the lazy dog and keeps running for a while",
  "src/components/very/very/very/very/long/path/to/a/file/somewhere/deep.ts",
  "https://registry.example.com/api/v2/packages/@scope/name/-/name-1.2.3.tgz",
  "supercalifragilisticexpialidociousandthensomemoretexttomakeitreallylong",
  "line one\nline two\nline three",
  "  indented\n    more indented\n\tttabbed",
  "日本語のテキストはとても長いので折り返しが必要になります",
  "mixed 日本語 and english text that needs to wrap somewhere sensible",
  "trailing spaces    \n   leading spaces",
  "a\n\n\nb",
  "Error: spawn npm ENOENT\n    at ChildProcess._handle.onexit (node:internal/child_process:286:19)",
  "👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍",
  "{\"key\":\"value\",\"nested\":{\"a\":1,\"b\":[1,2,3]},\"long\":\"aaaaaaaaaaaaaaaaaaaa\"}",
];

const WIDTHS = [1, 2, 3, 5, 8, 12, 20, 30, 40, 50, 60, 80, 100, 120, 160];

function testWrapInvariants() {
  section("wrapping — invariants across widths 1..160");

  for (const width of WIDTHS) {
    for (const sample of WRAP_CORPUS) {
      for (const indent of [0, 2, 5, 7]) {
        for (const preserveIndent of [false, true]) {
          const lines = wrapText(sample, width, { indent, preserveIndent });

          for (const line of lines) {
            const w = visualWidth(line);
            ok(
              w <= width,
              `wrap w=${width} indent=${indent} preserve=${preserveIndent} stays in bounds`,
              `line width ${w} > ${width}: ${JSON.stringify(line)} (input ${JSON.stringify(sample.slice(0, 40))})`
            );
            ok(
              !line.includes("\n"),
              "wrapped line contains no newline",
              JSON.stringify(line)
            );
          }
        }
      }
    }
  }
}

function testWrapBehaviour() {
  section("wrapping — behaviour");

  const prose = wrapText(
    "I'll inspect the authentication flow and trace where the session token is being invalidated.",
    60,
    { indent: 2 }
  );
  ok(prose.length > 1, "long prose wraps to multiple lines");
  ok(
    prose.every((l) => l.startsWith("  ")),
    "every wrapped prose line carries the indent"
  );
  ok(
    prose.every((l) => visualWidth(l) <= 60),
    "wrapped prose respects width"
  );

  ok(
    wrapText("short", 60).length === 1,
    "short content is not needlessly wrapped"
  );
  ok(wrapText("short", 60)[0] === "short", "short content is unchanged");

  const hanging = wrapText("one two three four five six seven eight nine ten", 20, {
    indent: 2,
    hangingIndent: 3,
  });
  ok(hanging.length > 1, "hanging indent case wraps");
  ok(hanging[0]!.startsWith("  ") && !hanging[0]!.startsWith("     "), "first line uses base indent");
  ok(hanging[1]!.startsWith("     "), "continuation uses hanging indent");

  const code = wrapText("function f() {\n  const x = 1;\n}", 40, { preserveIndent: true });
  ok(code[1] === "  const x = 1;", "preserveIndent keeps source indentation", JSON.stringify(code[1]));

  const blanks = wrapText("a\n\nb", 20);
  ok(blanks.length === 3 && blanks[1] === "", "blank lines are preserved");

  // A token with no break opportunity must be broken rather than overflow.
  const longToken = wrapText("x".repeat(50), 10);
  ok(longToken.length === 5, "unbreakable token is hard-broken", `got ${longToken.length}`);
  ok(longToken.every((l) => visualWidth(l) === 10), "hard-broken chunks fill the width");

  // Tabs measure zero cells under our width model, so an un-expanded tab would
  // make a line measure short and then overflow once the terminal expanded it.
  // Expansion happens before wrapping; prose mode then collapses the run.
  const tabbedCode = wrapText("a\tb", 40, { normalizeWhitespace: false });
  ok(tabbedCode[0] === "a    b", "tabs are expanded to spaces", JSON.stringify(tabbedCode[0]));
  const tabbedProse = wrapText("a\tb", 40);
  ok(tabbedProse[0] === "a b", "prose mode collapses the expanded tab", JSON.stringify(tabbedProse[0]));
  ok(
    !wrapText("a\tb", 40, { normalizeWhitespace: false })[0]!.includes("\t"),
    "no tab survives into output"
  );

  // Separator-breaking is a fallback for tokens that cannot fit, not a default.
  // Applied universally it mangles ordinary prose: "Next.js" becomes "Next." on
  // one line and an orphaned "js" on the next.
  const prose2 = wrapText("Graph-grounded code generation for Next.js and Prisma.", 40);
  ok(
    prose2.every((l) => !/\.$/.test(l.trim()) || l.trim().endsWith("Prisma.")),
    "prose does not break after a full stop mid-word",
    JSON.stringify(prose2)
  );
  ok(
    prose2.join(" ").includes("Next.js"),
    "a short dotted token stays intact",
    JSON.stringify(prose2)
  );
  ok(
    wrapText("well-formed and self-contained words", 40).join(" ").includes("well-formed"),
    "a short hyphenated token stays intact"
  );

  // But a token that genuinely cannot fit must still break at a separator.
  const url = wrapText("https://registry.example.com/api/v2/packages/name-1.2.3.tgz", 24);
  ok(url.every((l) => visualWidth(l) <= 24), "over-long URL respects width");
  ok(url.length > 1, "over-long URL is broken up");
  ok(
    url.some((l) => /[/.]$/.test(l)),
    "over-long URL breaks at a separator",
    JSON.stringify(url)
  );
}

function testPathWrapping() {
  section("wrapping — paths break at separators");

  const long = "src/components/very/very/very/long/path/file.ts";
  const lines = wrapPath(long, 24);
  ok(lines.every((l) => visualWidth(l) <= 24), "wrapped path respects width");
  ok(lines.join("") === long, "wrapped path loses no characters", lines.join("|"));
  ok(
    lines.slice(0, -1).every((l) => /[/\\]$/.test(l)),
    "path breaks after a separator",
    lines.join(" | ")
  );

  ok(wrapPath("src/a.ts", 40)[0] === "src/a.ts", "short path is not wrapped");

  const noSep = wrapPath("a".repeat(30), 10);
  ok(noSep.every((l) => visualWidth(l) <= 10), "separator-less path is hard-broken");
  ok(noSep.join("") === "a".repeat(30), "separator-less path loses nothing");

  const indented = wrapPath(long, 24, 5);
  ok(indented.every((l) => visualWidth(l) <= 24), "indented path respects total width");
  ok(indented.every((l) => l.startsWith("     ")), "indented path keeps its indent");
}

function testTruncation() {
  section("truncation");

  ok(truncateEnd("hello world", 8) === "hello w…", "truncateEnd appends ellipsis");
  ok(visualWidth(truncateEnd("hello world", 8)) === 8, "truncateEnd hits exact width");
  ok(truncateEnd("short", 20) === "short", "truncateEnd leaves short text alone");
  ok(visualWidth(truncateEnd("日本語テキスト", 5)) <= 5, "truncateEnd never splits a wide glyph");

  const mid = truncateMiddle("src/very/long/path/to/file.ts", 20);
  ok(visualWidth(mid) <= 20, "truncateMiddle respects width");
  ok(mid.includes("…"), "truncateMiddle marks the elision");
  ok(mid.startsWith("src/"), "truncateMiddle keeps the head");
  ok(mid.endsWith(".ts"), "truncateMiddle keeps the tail");

  for (const w of [0, 1, 2, 3, 4, 5]) {
    ok(visualWidth(truncateEnd("abcdefghij", w)) <= w, `truncateEnd degenerate w=${w}`);
    ok(visualWidth(truncateMiddle("abcdefghij", w)) <= w, `truncateMiddle degenerate w=${w}`);
  }
}

function testFuzz() {
  section("wrapping — fuzz");

  const alphabet = [
    "a", "bb", "ccc", " ", "\n", "/", ".", "-", "_", "日", "👍", "é",
    "\t", "…", "x".repeat(15), "https://", "src/", "​",
  ];

  // Deterministic LCG so a failure is reproducible.
  let seed = 0x2545f491;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let i = 0; i < 3000; i++) {
    const len = 1 + Math.floor(next() * 20);
    let input = "";
    for (let j = 0; j < len; j++) {
      input += alphabet[Math.floor(next() * alphabet.length)];
    }
    const width = 1 + Math.floor(next() * 120);
    const indent = Math.floor(next() * 8);

    const lines = wrapText(input, width, { indent });
    for (const line of lines) {
      const w = visualWidth(line);
      if (w > width) {
        ok(false, "fuzz: wrapped line exceeded width", `w=${w} max=${width} indent=${indent} input=${JSON.stringify(input)}`);
        return;
      }
    }

    const pathLines = wrapPath(input.replace(/[\n\t]/g, ""), width, indent);
    for (const line of pathLines) {
      const w = visualWidth(line);
      if (w > width) {
        ok(false, "fuzz: wrapped path exceeded width", `w=${w} max=${width} indent=${indent} input=${JSON.stringify(input)}`);
        return;
      }
    }
  }
  ok(true, "3000 fuzz cases stayed within bounds");
}

async function main() {
  console.log("TUI text engine — measurement and wrapping");

  testMeasurementBasics();
  await testMeasurementAgainstInk();
  testWrapInvariants();
  testWrapBehaviour();
  testPathWrapping();
  testTruncation();
  testFuzz();

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
