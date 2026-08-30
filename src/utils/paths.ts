import * as fs from "fs";
import * as path from "path";

/**
 * Normalise an LLM-produced file path into a project-relative posix path.
 *
 * LLM output is untrusted: it routinely emits absolute paths, `../` escapes,
 * backslashes, and — the failure this module exists for — a path prefixed with
 * the project directory's own name (`sample-project/components/PostCard.tsx`
 * inside `sample-project/`). Left alone, that last one silently creates a
 * duplicate directory tree and a ghost node in the graph.
 */
export interface ResolvedProjectPath {
  /** Absolute path on disk. */
  abs: string;
  /** Project-relative posix path — the form graph node ids use. */
  rel: string;
  /** True when the input needed the duplicated-root prefix stripped. */
  corrected: boolean;
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Resolve `filePath` against `projectRoot`.
 *
 * Returns null when the path escapes the project root — those are never
 * written, no matter what the model asked for.
 */
export function resolveProjectPath(
  filePath: string,
  projectRoot: string
): ResolvedProjectPath | null {
  if (typeof filePath !== "string" || filePath.trim() === "") return null;

  const absRoot = path.resolve(projectRoot);
  let candidate = toPosix(filePath.trim()).replace(/^\.\//, "");

  const resolve = (p: string): ResolvedProjectPath | null => {
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(absRoot, p);
    const rel = toPosix(path.relative(absRoot, abs));
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return { abs, rel, corrected: false };
  };

  const direct = resolve(candidate);
  if (!direct) return null;

  // Already points at something real — nothing to correct.
  if (fs.existsSync(direct.abs)) return direct;

  // The duplicated-root case: `<rootName>/x/y` inside a project whose folder is
  // `<rootName>`. Only strip when doing so lands on a file that actually exists,
  // so a genuinely new file under a same-named subdirectory is left alone.
  const rootName = path.basename(absRoot);
  const segments = direct.rel.split("/");
  if (segments.length > 1 && segments[0] === rootName) {
    const stripped = resolve(segments.slice(1).join("/"));
    if (stripped && fs.existsSync(stripped.abs)) {
      return { ...stripped, corrected: true };
    }
  }

  return direct;
}

/** True when `filePath` is a Prisma schema, whatever casing or separators it uses. */
export function isPrismaSchemaPath(filePath: string): boolean {
  return path.basename(toPosix(filePath)).toLowerCase() === "schema.prisma";
}

/** Escape a string for literal use inside a RegExp. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary identifier match.
 *
 * `\bphone\b` deliberately does NOT match inside `phoneNo`, which is what makes
 * it safe to use as the "did the rename actually land" gate.
 */
export function referencesIdentifier(content: string, identifier: string): boolean {
  if (!identifier) return false;
  return new RegExp(`\\b${escapeRegex(identifier)}\\b`).test(content);
}
