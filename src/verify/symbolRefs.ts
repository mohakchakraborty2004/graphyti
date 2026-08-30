import ts from "typescript";
import { referencesIdentifier } from "../utils/paths";

/**
 * Does this file reference a model field, in a position that a rename breaks?
 *
 * A bare word-boundary search cannot tell `post.title` from a page's
 * `export const metadata = { title: "..." }`. Enforcing every word match blocks
 * correct runs; enforcing only what the code graph linked misses real consumers
 * the extractor could not disambiguate — `UserList.tsx` renders `post.title`
 * through a route that queries `User`, so the extractor drops the edge, and the
 * file silently falls out of the blast radius.
 *
 * This splits the difference with syntax, which is deterministic and needs no
 * type information: a reference counts when the identifier appears where a
 * field name can appear.
 *
 *   post.title                          property access
 *   post["title"]                       element access
 *   const { title } = post              destructuring
 *   interface Post { title?: string }   type member
 *   findMany({ select: { title: true }})object key inside a call argument
 *
 * and does not count when it is merely a name in scope:
 *
 *   export const metadata = { title: "…" }   object literal, not a call argument
 *   function formatTitle(title: string)      parameter name
 */
export type ReferenceKind =
  | "property-access"
  | "element-access"
  | "destructuring"
  | "type-member"
  | "call-argument-key"
  | "identifier";

export interface SymbolReference {
  kind: ReferenceKind;
  /** 1-indexed line in the file. */
  line: number;
}

const TS_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"]);

function scriptKindFor(filePath: string): ts.ScriptKind {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "tsx") return ts.ScriptKind.TSX;
  if (ext === "jsx") return ts.ScriptKind.JSX;
  if (ext === "js" || ext === "mjs" || ext === "cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isParsableSource(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return TS_EXTENSIONS.has(ext);
}

/**
 * True when this object-literal member sits inside a call argument.
 *
 * `prisma.post.findMany({ select: { title: true } })` qualifies; a plain
 * `const metadata = { title: "…" }` does not. Walks up through nested object
 * literals and property assignments so arbitrarily deep query shapes still
 * resolve to the call that owns them.
 */
function insideCallArgument(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    const parent: ts.Node | undefined = current.parent;
    if (!parent) return false;
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      return (parent.arguments ?? []).some((arg) => arg === current);
    }
    if (
      ts.isObjectLiteralExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isParenthesizedExpression(parent)
    ) {
      current = parent;
      continue;
    }
    return false;
  }
  return false;
}

function nameOf(node: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

/**
 * Every syntactic reference to `fieldName` in `content`.
 *
 * Falls back to a word-boundary match for non-TypeScript files and for content
 * that fails to parse — over-reporting is the safe direction for a check whose
 * job is to stop a dangling reference reaching disk.
 */
export function findFieldReferences(
  content: string,
  filePath: string,
  fieldName: string
): SymbolReference[] {
  if (!fieldName) return [];

  if (!isParsableSource(filePath)) {
    return referencesIdentifier(content, fieldName)
      ? [{ kind: "property-access", line: 0 }]
      : [];
  }

  // Nothing can match if the identifier is absent, and this skips the parse
  // for the overwhelmingly common case.
  if (!referencesIdentifier(content, fieldName)) return [];

  let source: ts.SourceFile;
  try {
    source = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      scriptKindFor(filePath)
    );
  } catch {
    return [{ kind: "property-access", line: 0 }];
  }

  const refs: SymbolReference[] = [];
  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const push = (kind: ReferenceKind, node: ts.Node) => {
    refs.push({ kind, line: lineOf(node) });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === fieldName) {
      push("property-access", node.name);
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === fieldName
    ) {
      push("element-access", node.argumentExpression);
    } else if (ts.isPropertySignature(node) && nameOf(node.name) === fieldName) {
      push("type-member", node);
    } else if (ts.isMethodSignature(node) && nameOf(node.name) === fieldName) {
      push("type-member", node);
    } else if (ts.isBindingElement(node)) {
      // `const { title } = post` and `const { title: heading } = post` — the
      // field is whichever name faces the object being destructured.
      const bound = node.propertyName ? nameOf(node.propertyName) : nameOf(node.name);
      if (bound === fieldName && ts.isObjectBindingPattern(node.parent)) {
        push("destructuring", node);
      }
    } else if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      nameOf(node.name) === fieldName &&
      insideCallArgument(node)
    ) {
      push("call-argument-key", node);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  // A parse that produced nothing but whose text clearly names the identifier
  // is treated as a reference: a syntax error must not read as "clean".
  if (refs.length === 0 && (source as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics?.length) {
    return [{ kind: "property-access", line: 0 }];
  }

  return refs;
}

/** Convenience predicate over {@link findFieldReferences}. */
export function referencesField(
  content: string,
  filePath: string,
  fieldName: string
): boolean {
  return findFieldReferences(content, filePath, fieldName).length > 0;
}

/**
 * Whole-model removals invalidate every exact identifier use: `LikeDislike`
 * types/imports and the `prisma.likeDislike` delegate alike. Unlike a field
 * rename, treating a bare model identifier as meaningful is both necessary
 * and safe.
 */
export function findIdentifierReferences(
  content: string,
  identifiers: string[]
): SymbolReference[] {
  const wanted = identifiers.filter(Boolean);
  if (wanted.length === 0) return [];
  const lines = content.split("\n");
  const refs: SymbolReference[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (wanted.some((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`).test(lines[index]))) {
      refs.push({ kind: "identifier", line: index + 1 });
    }
  }
  return refs;
}
