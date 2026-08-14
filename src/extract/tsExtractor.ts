import * as fs from "fs";
import * as path from "path";
import {
  Node,
  Project,
  SyntaxKind,
  ts,
  type CallExpression,
  type ObjectLiteralExpression,
  type SourceFile,
} from "ts-morph";
import {
  extractWarn,
  toPosix,
  type ApiRoute,
  type ComponentFetch,
  type FileImport,
  type PrismaModel,
  type RouteModelUsage,
} from "./types";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
const PRISMA_OPS = new Set([
  "findMany",
  "findFirst",
  "findUnique",
  "findFirstOrThrow",
  "findUniqueOrThrow",
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);
const QUERY_ARG_KEYS = new Set(["select", "data", "where", "include"]);
const WRAPPER_HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "request"]);
const ARRAY_CALLBACK_METHODS = new Set(["map", "filter", "forEach", "flatMap", "find", "some", "every"]);
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "coverage"]);

export interface TsExtractResult {
  imports: FileImport[];
  routes: ApiRoute[];
  routeModelUsages: RouteModelUsage[];
  componentFetches: ComponentFetch[];
}

export function listSourceFiles(projectRoot: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && SOURCE_EXT.has(path.extname(entry.name))) {
        results.push(full);
      }
    }
  }

  walk(projectRoot);
  results.sort((a, b) => toPosix(a).localeCompare(toPosix(b)));
  return results;
}

function rel(projectRoot: string, absPath: string): string {
  return toPosix(path.relative(projectRoot, absPath));
}

function createProject(projectRoot: string): Project {
  const tsconfig = path.join(projectRoot, "tsconfig.json");
  if (fs.existsSync(tsconfig)) {
    return new Project({
      tsConfigFilePath: tsconfig,
      skipAddingFilesFromTsConfig: true,
    });
  }
  return new Project({
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  });
}

function isInsideNodeModules(filePath: string): boolean {
  return toPosix(filePath).split("/").includes("node_modules");
}

function collectImports(sourceFile: SourceFile, projectRoot: string): FileImport[] {
  const fromFile = rel(projectRoot, sourceFile.getFilePath());
  const imports: FileImport[] = [];
  const seen = new Set<string>();

  const add = (toAbs: string | undefined) => {
    if (!toAbs || isInsideNodeModules(toAbs)) return;
    const toFile = rel(projectRoot, toAbs);
    if (!toFile || toFile.startsWith("..")) return;
    const key = `${fromFile}->${toFile}`;
    if (seen.has(key)) return;
    seen.add(key);
    imports.push({ fromFile, toFile });
  };

  for (const decl of sourceFile.getImportDeclarations()) {
    const spec = decl.getModuleSpecifierValue();
    const resolved = decl.getModuleSpecifierSourceFile();
    if (resolved) {
      add(resolved.getFilePath());
      continue;
    }
    const fallback = tryResolveFromSpecifier(sourceFile, spec);
    if (fallback) {
      add(fallback);
      continue;
    }
    if (isLocalSpecifier(spec)) {
      extractWarn(`Could not resolve import "${spec}" in ${fromFile} — skipping`);
    }
  }

  for (const decl of sourceFile.getExportDeclarations()) {
    const spec = decl.getModuleSpecifierValue();
    if (!spec) continue;
    const resolved = decl.getModuleSpecifierSourceFile();
    if (resolved) {
      add(resolved.getFilePath());
      continue;
    }
    const fallback = tryResolveFromSpecifier(sourceFile, spec);
    if (fallback) {
      add(fallback);
      continue;
    }
    if (isLocalSpecifier(spec)) {
      extractWarn(`Could not resolve re-export "${spec}" in ${fromFile} — skipping`);
    }
  }

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (expr.getKind() !== SyntaxKind.ImportKeyword) continue;
    const arg = call.getArguments()[0];
    if (!arg) continue;
    if (!Node.isStringLiteral(arg) && !Node.isNoSubstitutionTemplateLiteral(arg)) {
      extractWarn(`Dynamic import() in ${fromFile} — skipping`);
      continue;
    }
    const spec = arg.getLiteralText();
    const resolved = tryResolveFromSpecifier(sourceFile, spec);
    if (resolved) add(resolved);
    else if (isLocalSpecifier(spec)) {
      extractWarn(`Could not resolve dynamic import "${spec}" in ${fromFile} — skipping`);
    }
  }

  return imports;
}

function isLocalSpecifier(spec: string): boolean {
  if (spec.startsWith("@/generated")) return false;
  return spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@/");
}

function isLocallyImported(ident: import("ts-morph").Identifier): boolean {
  const name = ident.getText();
  for (const imp of ident.getSourceFile().getImportDeclarations()) {
    if (!isLocalSpecifier(imp.getModuleSpecifierValue())) continue;
    if (imp.getDefaultImport()?.getText() === name) return true;
    if (imp.getNamespaceImport()?.getText() === name) return true;
    for (const named of imp.getNamedImports()) {
      const local = named.getAliasNode()?.getText() ?? named.getName();
      if (local === name) return true;
    }
  }
  return false;
}

function tryResolveFromSpecifier(sourceFile: SourceFile, spec: string): string | undefined {
  const project = sourceFile.getProject();
  const compilerOptions = project.getCompilerOptions();
  const host = project.getModuleResolutionHost?.() ?? ts.createCompilerHost(compilerOptions);
  const resolved = ts.resolveModuleName(
    spec,
    sourceFile.getFilePath(),
    compilerOptions,
    host
  );
  return resolved.resolvedModule?.resolvedFileName;
}

function filePathToRoute(relativePosix: string): string | null {
  const p = toPosix(relativePosix);
  const appMatch = p.match(/(?:^|\/)app\/api\/(.+)\/route\.(ts|tsx|js|jsx)$/i);
  if (appMatch) {
    const segments = appMatch[1]
      .split("/")
      .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")) && !seg.startsWith("@"));
    return `/api/${segments.join("/")}`;
  }
  const pagesMatch = p.match(/(?:^|\/)pages\/api\/(.+)\.(ts|tsx|js|jsx)$/i);
  if (pagesMatch) {
    let rest = pagesMatch[1];
    if (rest === "index") return "/api";
    if (rest.endsWith("/index")) rest = rest.slice(0, -"/index".length);
    return `/api/${rest}`;
  }
  return null;
}

function isApiRouteFile(relativePosix: string): boolean {
  return filePathToRoute(relativePosix) !== null;
}

function isComponentFile(relativePosix: string): boolean {
  const ext = path.posix.extname(toPosix(relativePosix));
  if (ext !== ".tsx" && ext !== ".jsx") return false;
  return !isApiRouteFile(relativePosix);
}

function exportedHttpMethods(sourceFile: SourceFile): string[] {
  const methods = new Set<string>();
  for (const name of HTTP_METHODS) {
    const fn = sourceFile.getFunction(name);
    if (fn?.isExported()) methods.add(name);
    const variable = sourceFile.getVariableDeclaration(name);
    if (variable) {
      const stmt = variable.getVariableStatement();
      if (stmt?.isExported()) methods.add(name);
    }
  }
  return [...methods];
}

function pagesApiMethods(sourceFile: SourceFile): string[] {
  const methods = new Set<string>();
  for (const bin of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (
      bin.getOperatorToken().getKind() !== SyntaxKind.EqualsEqualsEqualsToken &&
      bin.getOperatorToken().getKind() !== SyntaxKind.EqualsEqualsToken
    ) {
      continue;
    }
    const left = bin.getLeft();
    const right = bin.getRight();
    const isMethodAccess =
      Node.isPropertyAccessExpression(left) && left.getName() === "method";
    if (!isMethodAccess) continue;
    if (Node.isStringLiteral(right) || Node.isNoSubstitutionTemplateLiteral(right)) {
      const value = right.getLiteralText().toUpperCase();
      if ((HTTP_METHODS as readonly string[]).includes(value)) methods.add(value);
    }
  }
  return [...methods];
}

function collectRoutes(sourceFile: SourceFile, projectRoot: string): ApiRoute | null {
  const filePath = rel(projectRoot, sourceFile.getFilePath());
  const routePath = filePathToRoute(filePath);
  if (!routePath) return null;

  let httpMethods = exportedHttpMethods(sourceFile);
  if (httpMethods.length === 0 && /(?:^|\/)pages\/api\//.test(filePath)) {
    httpMethods = pagesApiMethods(sourceFile);
  }
  if (httpMethods.length === 0) {
    extractWarn(`No HTTP methods detected in ${filePath}`);
  }
  httpMethods.sort((a, b) => a.localeCompare(b));
  return { routePath, filePath, httpMethods };
}

function clientAccessor(modelName: string): string {
  return modelName.charAt(0).toLowerCase() + modelName.slice(1);
}

function isPrismaIdent(node: Node): boolean {
  if (Node.isIdentifier(node)) return node.getText() === "prisma";
  if (Node.isPropertyAccessExpression(node)) return node.getName() === "prisma";
  return false;
}

function objectLiteralFieldKeys(
  obj: ObjectLiteralExpression,
  filePath: string,
  context: string
): string[] | null {
  const keys: string[] = [];
  for (const prop of obj.getProperties()) {
    if (Node.isSpreadAssignment(prop)) {
      extractWarn(`Spread in ${context} in ${filePath} — skipping object`);
      return null;
    }
    if (Node.isShorthandPropertyAssignment(prop)) {
      keys.push(prop.getName());
      continue;
    }
    if (Node.isPropertyAssignment(prop) || Node.isMethodDeclaration(prop)) {
      const nameNode = prop.getNameNode();
      if (Node.isComputedPropertyName(nameNode)) {
        extractWarn(`Computed key in ${context} in ${filePath} — skipping object`);
        return null;
      }
      if (Node.isIdentifier(nameNode) || Node.isStringLiteral(nameNode) || Node.isNoSubstitutionTemplateLiteral(nameNode)) {
        keys.push(Node.isIdentifier(nameNode) ? nameNode.getText() : nameNode.getLiteralText());
        continue;
      }
      extractWarn(`Non-literal key in ${context} in ${filePath} — skipping object`);
      return null;
    }
  }
  return keys;
}

function collectRouteModelUsages(
  sourceFile: SourceFile,
  projectRoot: string,
  models: PrismaModel[]
): RouteModelUsage[] {
  const filePath = rel(projectRoot, sourceFile.getFilePath());
  const routePath = filePathToRoute(filePath);
  if (!routePath) return [];

  const accessorToModel = new Map<string, string>();
  for (const model of models) {
    accessorToModel.set(clientAccessor(model.name), model.name);
  }

  const usages: RouteModelUsage[] = [];

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) continue;
    const operation = expr.getName();
    if (!PRISMA_OPS.has(operation)) continue;
    const modelAccess = expr.getExpression();
    if (!Node.isPropertyAccessExpression(modelAccess)) continue;
    if (!isPrismaIdent(modelAccess.getExpression())) continue;

    const accessor = modelAccess.getName();
    const modelName = accessorToModel.get(accessor);
    if (!modelName) {
      extractWarn(`Unknown Prisma model accessor prisma.${accessor}.${operation} in ${filePath} — skipping`);
      continue;
    }

    const fieldNames = extractQueryFieldNames(call, filePath, `${modelName}.${operation}`);
    usages.push({ routePath, filePath, modelName, operation, fieldNames });
  }

  return usages;
}

function extractQueryFieldNames(call: CallExpression, filePath: string, context: string): string[] {
  const arg = call.getArguments()[0];
  if (!arg) return [];
  if (!Node.isObjectLiteralExpression(arg)) {
    extractWarn(`Non-object argument to ${context} in ${filePath} — skipping field keys`);
    return [];
  }

  const names = new Set<string>();
  for (const prop of arg.getProperties()) {
    if (Node.isSpreadAssignment(prop)) {
      extractWarn(`Spread in ${context} args in ${filePath} — skipping field keys from spread`);
      continue;
    }
    if (!Node.isPropertyAssignment(prop)) continue;
    const keyNode = prop.getNameNode();
    if (!Node.isIdentifier(keyNode)) continue;
    if (!QUERY_ARG_KEYS.has(keyNode.getText())) continue;
    const value = prop.getInitializer();
    if (!value || !Node.isObjectLiteralExpression(value)) {
      extractWarn(`${keyNode.getText()} is not an object literal in ${context} (${filePath}) — skipping`);
      continue;
    }
    const keys = objectLiteralFieldKeys(value, filePath, `${context}.${keyNode.getText()}`);
    if (!keys) continue;
    for (const k of keys) names.add(k);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function literalApiPath(call: CallExpression, filePath: string): string | null {
  if (!isFetchLikeCall(call)) return null;
  const arg = call.getArguments()[0];
  if (!arg) return null;
  if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) {
    const raw = arg.getLiteralText();
    const pathOnly = raw.split("?")[0];
    if (!pathOnly.startsWith("/api/") && pathOnly !== "/api") return null;
    return pathOnly;
  }
  if (Node.isTemplateExpression(arg)) {
    extractWarn(`Non-literal fetch path in ${filePath} — skipping`);
  }
  return null;
}

function isFetchLikeCall(call: CallExpression): boolean {
  const expr = call.getExpression();
  const first = call.getArguments()[0];
  const hasApiLiteral =
    first &&
    (Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first)) &&
    (() => {
      const p = first.getLiteralText().split("?")[0];
      return p.startsWith("/api/") || p === "/api";
    })();

  if (Node.isIdentifier(expr)) {
    const name = expr.getText();
    if (name === "fetch" || /fetch/i.test(name)) return true;
    return Boolean(hasApiLiteral && isLocallyImported(expr));
  }
  if (Node.isPropertyAccessExpression(expr)) {
    if (WRAPPER_HTTP_METHODS.has(expr.getName().toLowerCase()) && hasApiLiteral) return true;
  }
  return false;
}

function unwrap(node: Node): Node {
  let current = node;
  while (true) {
    if (Node.isParenthesizedExpression(current)) {
      current = current.getExpression();
      continue;
    }
    if (Node.isAwaitExpression(current)) {
      current = current.getExpression();
      continue;
    }
    if (Node.isAsExpression(current) || Node.isTypeAssertion(current) || Node.isNonNullExpression(current)) {
      current = current.getExpression();
      continue;
    }
    break;
  }
  return current;
}

function collectComponentFetches(sourceFile: SourceFile, projectRoot: string): ComponentFetch[] {
  const filePath = rel(projectRoot, sourceFile.getFilePath());
  if (!isComponentFile(filePath)) return [];

  const fetches: ComponentFetch[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const routePath = literalApiPath(call, filePath);
    if (!routePath) continue;
    const fieldNames = collectJsonFieldReads(call, filePath);
    fetches.push({ componentFile: filePath, routePath, fieldNames });
  }
  return fetches;
}

function collectJsonFieldReads(fetchCall: CallExpression, filePath: string): string[] {
  const jsonRoots = findJsonRoots(fetchCall, filePath);
  const fields = new Set<string>();
  for (const root of jsonRoots) {
    for (const name of fieldReadsFromNode(root, filePath)) fields.add(name);
  }
  return [...fields].sort((a, b) => a.localeCompare(b));
}

function findJsonRoots(fetchCall: CallExpression, filePath: string): Node[] {
  const roots: Node[] = [];
  const responseNodes = new Set<Node>([fetchCall]);

  const parent = fetchCall.getParent();
  if (parent && Node.isAwaitExpression(parent)) responseNodes.add(parent);

  for (const node of [...responseNodes]) {
    collectThenJson(node, roots, filePath);
  }

  for (const ident of identifiersBoundTo(fetchCall)) {
    for (const ref of identifierUsesInScope(ident)) {
      const access = ref.getParent();
      if (access && Node.isPropertyAccessExpression(access) && access.getExpression() === ref && access.getName() === "json") {
        const call = access.getParent();
        if (call && Node.isCallExpression(call)) roots.push(call);
      }
      if (access && Node.isPropertyAccessExpression(access) && access.getName() === "then") {
        const call = access.getParent();
        if (call && Node.isCallExpression(call)) collectThenJson(call, roots, filePath);
      }
    }
  }

  return roots;
}

function collectThenJson(node: Node, roots: Node[], filePath: string): void {
  let current: Node | undefined = unwrap(node);
  while (current && Node.isCallExpression(current)) {
    const expr = current.getExpression();
    if (Node.isPropertyAccessExpression(expr) && expr.getName() === "json") {
      roots.push(current);
      return;
    }
    if (Node.isPropertyAccessExpression(expr) && expr.getName() === "then") {
      const cb = current.getArguments()[0];
      if (!cb || (!Node.isArrowFunction(cb) && !Node.isFunctionExpression(cb))) {
        extractWarn(`.then callback is not a simple function in ${filePath} — skipping JSON tracking`);
        return;
      }
      const body = cb.getBody();
      const returned = Node.isBlock(body)
        ? body.getStatements().flatMap((s) => (Node.isReturnStatement(s) && s.getExpression() ? [s.getExpression()!] : []))
        : [body];
      for (const r of returned) {
        const u = unwrap(r);
        if (Node.isCallExpression(u)) {
          const inner = u.getExpression();
          if (Node.isPropertyAccessExpression(inner) && inner.getName() === "json") {
            roots.push(u);
          }
        }
      }
      current = current.getParent() && Node.isPropertyAccessExpression(current.getParent()!)
        ? current.getParent()!.getParent()
        : undefined;
      continue;
    }
    break;
  }
}

function identifiersBoundTo(expr: Node): import("ts-morph").Identifier[] {
  let current: Node | undefined = expr;
  while (current) {
    const parent = current.getParent();
    if (!parent) break;
    if (
      Node.isParenthesizedExpression(parent) ||
      Node.isAwaitExpression(parent) ||
      Node.isAsExpression(parent) ||
      Node.isTypeAssertion(parent) ||
      Node.isNonNullExpression(parent)
    ) {
      current = parent;
      continue;
    }
    if (Node.isVariableDeclaration(parent)) {
      const name = parent.getNameNode();
      if (Node.isIdentifier(name)) return [name];
    }
    break;
  }
  return [];
}

function identifierUsesInScope(declared: import("ts-morph").Identifier): import("ts-morph").Identifier[] {
  const name = declared.getText();
  const scope =
    declared.getFirstAncestorByKind(SyntaxKind.Block) ??
    declared.getFirstAncestorByKind(SyntaxKind.SourceFile);
  if (!scope) return [];
  const uses: import("ts-morph").Identifier[] = [];
  for (const id of scope.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id === declared || id.getText() !== name) continue;
    const parent = id.getParent();
    if (Node.isVariableDeclaration(parent) && parent.getNameNode() === id) continue;
    if (Node.isParameterDeclaration(parent) && parent.getNameNode() === id) continue;
    if (Node.isFunctionDeclaration(parent) && parent.getNameNode() === id) continue;
    uses.push(id);
  }
  return uses;
}

function fieldReadsFromNode(jsonCall: Node, filePath: string): string[] {
  const fields = new Set<string>();
  const work: Node[] = [jsonCall];
  const seen = new Set<Node>();

  while (work.length) {
    const node = work.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);

    const parent = node.getParent();
    if (!parent) continue;

    if (
      Node.isParenthesizedExpression(parent) ||
      Node.isAsExpression(parent) ||
      Node.isTypeAssertion(parent) ||
      Node.isNonNullExpression(parent) ||
      Node.isAwaitExpression(parent)
    ) {
      work.push(parent);
      continue;
    }

    if (
      Node.isVariableDeclaration(parent) &&
      parent.getInitializer() &&
      (parent.getInitializer() === node || unwrap(parent.getInitializer()!) === unwrap(node) || unwrap(parent.getInitializer()!) === node)
    ) {
      const name = parent.getNameNode();
      if (Node.isIdentifier(name)) {
        collectReadsFromIdentifier(name, fields, work, filePath);
      } else if (Node.isObjectBindingPattern(name)) {
        collectBindingNames(name, fields, filePath);
      } else if (Node.isArrayBindingPattern(name)) {
        extractWarn(`Array destructure of JSON in ${filePath} — skipping ambiguous element fields`);
      }
      continue;
    }

    if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === node) {
      const prop = parent.getName();
      if (prop === "then") {
        const call = parent.getParent();
        if (call && Node.isCallExpression(call)) {
          const cb = call.getArguments()[0];
          if (cb && (Node.isArrowFunction(cb) || Node.isFunctionExpression(cb))) {
            const params = cb.getParameters();
            const first = params[0]?.getNameNode();
            if (first && Node.isIdentifier(first)) {
              collectReadsFromIdentifier(first, fields, work, filePath);
            } else if (first && Node.isObjectBindingPattern(first)) {
              collectBindingNames(first, fields, filePath);
            } else {
              extractWarn(`Ambiguous .then JSON callback in ${filePath} — skipping`);
            }
          }
        }
        continue;
      }
      if (ARRAY_CALLBACK_METHODS.has(prop)) {
        const call = parent.getParent();
        if (call && Node.isCallExpression(call)) {
          const cb = call.getArguments()[0];
          if (cb && (Node.isArrowFunction(cb) || Node.isFunctionExpression(cb))) {
            const first = cb.getParameters()[0]?.getNameNode();
            if (first && Node.isIdentifier(first)) {
              collectReadsFromIdentifier(first, fields, work, filePath);
            } else {
              extractWarn(`Ambiguous array callback in ${filePath} — skipping`);
            }
          }
        }
        continue;
      }
      fields.add(prop);
      continue;
    }

    if (Node.isCallExpression(parent) && parent.getExpression() === node) {
      continue;
    }

    if (Node.isCallExpression(parent) && parent.getArguments().some((a) => unwrap(a) === node)) {
      extractWarn(`JSON result passed as argument in ${filePath} — skipping further field tracking`);
      continue;
    }
  }

  return [...fields];
}

function collectBindingNames(
  pattern: import("ts-morph").ObjectBindingPattern,
  fields: Set<string>,
  filePath: string
): void {
  for (const element of pattern.getElements()) {
    if (element.getDotDotDotToken()) {
      extractWarn(`Rest binding of JSON in ${filePath} — skipping rest fields`);
      continue;
    }
    const propName = element.getPropertyNameNode();
    if (propName && Node.isComputedPropertyName(propName)) {
      extractWarn(`Computed destructure key in ${filePath} — skipping`);
      continue;
    }
    fields.add(element.getName());
  }
}

function collectReadsFromIdentifier(
  ident: import("ts-morph").Identifier,
  fields: Set<string>,
  work: Node[],
  filePath: string
): void {
  for (const ref of identifierUsesInScope(ident)) {
    if (ref === ident) continue;
    const parent = ref.getParent();
    if (!parent) continue;

    if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === ref) {
      const prop = parent.getName();
      if (ARRAY_CALLBACK_METHODS.has(prop)) {
        const call = parent.getParent();
        if (call && Node.isCallExpression(call)) {
          const cb = call.getArguments()[0];
          if (cb && (Node.isArrowFunction(cb) || Node.isFunctionExpression(cb))) {
            const first = cb.getParameters()[0]?.getNameNode();
            if (first && Node.isIdentifier(first)) {
              collectReadsFromIdentifier(first, fields, work, filePath);
            } else {
              extractWarn(`Ambiguous array callback in ${filePath} — skipping`);
            }
          }
        }
        continue;
      }
      if (prop === "then" || prop === "json") {
        work.push(parent);
        continue;
      }
      fields.add(prop);
      continue;
    }

    if (Node.isElementAccessExpression(parent) && parent.getExpression() === ref) {
      const arg = parent.getArgumentExpression();
      if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) {
        fields.add(arg.getLiteralText());
      } else if (arg && Node.isNumericLiteral(arg)) {
        work.push(parent);
      } else {
        extractWarn(`Dynamic index access on JSON in ${filePath} — skipping`);
      }
      continue;
    }

    if (Node.isVariableDeclaration(parent) && parent.getInitializer()) {
      const init = unwrap(parent.getInitializer()!);
      if (init === ref) {
        const name = parent.getNameNode();
        if (Node.isIdentifier(name)) {
          collectReadsFromIdentifier(name, fields, work, filePath);
        } else if (Node.isObjectBindingPattern(name)) {
          collectBindingNames(name, fields, filePath);
        } else if (Node.isArrayBindingPattern(name)) {
          extractWarn(`Array destructure of JSON in ${filePath} — skipping ambiguous element fields`);
        }
      }
      continue;
    }

    if (Node.isCallExpression(parent) && parent.getArguments().some((a) => a === ref || unwrap(a) === ref)) {
      extractWarn(`JSON identifier passed as argument in ${filePath} — skipping further tracking for that use`);
    }
  }
}

export function extractTypeScript(
  projectRoot: string,
  filePaths: string[],
  models: PrismaModel[]
): TsExtractResult {
  const project = createProject(projectRoot);
  for (const file of filePaths) {
    try {
      project.addSourceFileAtPath(file);
    } catch {
      extractWarn(`Could not add source file ${rel(projectRoot, file)} — skipping`);
    }
  }

  const imports: FileImport[] = [];
  const routes: ApiRoute[] = [];
  const routeModelUsages: RouteModelUsage[] = [];
  const componentFetches: ComponentFetch[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    if (isInsideNodeModules(sourceFile.getFilePath())) continue;
    imports.push(...collectImports(sourceFile, projectRoot));
    const route = collectRoutes(sourceFile, projectRoot);
    if (route) routes.push(route);
    routeModelUsages.push(...collectRouteModelUsages(sourceFile, projectRoot, models));
    componentFetches.push(...collectComponentFetches(sourceFile, projectRoot));
  }

  imports.sort((a, b) => a.fromFile.localeCompare(b.fromFile) || a.toFile.localeCompare(b.toFile));
  routes.sort((a, b) => a.routePath.localeCompare(b.routePath) || a.filePath.localeCompare(b.filePath));
  routeModelUsages.sort(
    (a, b) =>
      a.routePath.localeCompare(b.routePath) ||
      a.modelName.localeCompare(b.modelName) ||
      a.operation.localeCompare(b.operation)
  );
  componentFetches.sort(
    (a, b) => a.componentFile.localeCompare(b.componentFile) || a.routePath.localeCompare(b.routePath)
  );

  return { imports, routes, routeModelUsages, componentFetches };
}

/**
 * Extract TypeScript/TSX metadata from an in-memory string without touching disk.
 * Uses ts-morph createSourceFile to create a virtual file at `virtualAbsPath`
 * so that route-path inference and relative-import resolution still work correctly.
 *
 * @param projectRoot   - Absolute path to the project root (for relative path math).
 * @param virtualAbsPath - The absolute path this content *would* live at on disk.
 * @param source        - In-memory file content (not yet written to disk).
 * @param models        - Prisma models for route-model usage detection.
 */
export function extractTypeScriptFromSource(
  projectRoot: string,
  virtualAbsPath: string,
  source: string,
  models: PrismaModel[]
): TsExtractResult {
  const project = createProject(projectRoot);

  // createSourceFile registers a virtual file; overwrite=true in case it already exists
  const sourceFile = project.createSourceFile(virtualAbsPath, source, { overwrite: true });

  const imports: FileImport[] = [];
  const routes: ApiRoute[] = [];
  const routeModelUsages: RouteModelUsage[] = [];
  const componentFetches: ComponentFetch[] = [];

  if (!isInsideNodeModules(sourceFile.getFilePath())) {
    imports.push(...collectImports(sourceFile, projectRoot));
    const route = collectRoutes(sourceFile, projectRoot);
    if (route) routes.push(route);
    routeModelUsages.push(...collectRouteModelUsages(sourceFile, projectRoot, models));
    componentFetches.push(...collectComponentFetches(sourceFile, projectRoot));
  }

  return { imports, routes, routeModelUsages, componentFetches };
}

export { isComponentFile, isApiRouteFile };
