import { contextGatherer } from "./agent";
import { getProjectStructure, saveContextFile, shallowScan } from "./StrAnalyzer";

export default async function ContextGen(){
    //get file structure info.
    const structure = getProjectStructure();
    // console.log(structure);
    console.log("Now scanning.........")
    const scanResult = shallowScan(structure.root);

    console.log("Generating the context file.....")
    const context = await contextGatherer(structure, scanResult);
    saveContextFile(context, structure.root);

    console.log(".dbagent/context.json generated successfully, do not push the context.json to github");
}

/**
 * Format the raw string stored in context.json into an LLM-readable string
 * with the same rough shape buildString() produces: file paths, models/fields,
 * and a natural-language summary. Mirrors the format retrieveContext() returns
 * so codeGen always receives a consistent context contract.
 *
 * Handles two cases:
 *   - The stored value is valid JSON (the contextGatherer shape) — extract and
 *     format the structured fields into prose.
 *   - The stored value is plain text — return it as-is, already LLM-readable.
 */
export function formatLegacyContext(raw: string): string {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not valid JSON — treat as already-formatted plain text.
    return raw.trim();
  }

  // If JSON.parse gave us a string (double-encoded), unwrap one layer.
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return parsed.trim();
    }
  }

  if (typeof parsed !== "object" || parsed === null) {
    return String(parsed).trim();
  }

  const lines: string[] = [];

  // Header
  lines.push("=== Project Context ===");
  if (parsed.generatedAt) {
    lines.push(`Generated: ${parsed.generatedAt}`);
  }

  // Summary
  if (parsed.summary) {
    const { totalFiles, totalLines } = parsed.summary;
    lines.push(`\nSummary: ${totalFiles ?? "?"} files, ~${totalLines ?? "?"} lines of code`);
  }

  // Project structure
  if (parsed.structure) {
    const s = parsed.structure;
    lines.push("\nProject structure:");
    if (s.root)          lines.push(`  root:         ${s.root}`);
    if (s.routerType)    lines.push(`  router:       ${s.routerType}`);
    if (s.routerDir)     lines.push(`  routerDir:    ${s.routerDir}`);
    if (s.componentsDir) lines.push(`  components:   ${s.componentsDir}`);
    if (s.apiDir)        lines.push(`  apiDir:       ${s.apiDir}`);
    if (s.prismaDir)     lines.push(`  prismaDir:    ${s.prismaDir}`);
  }

  // Routes / files with descriptions
  if (parsed.routes && typeof parsed.routes === "object") {
    lines.push("\nKnown routes and files:");
    for (const [filePath, info] of Object.entries<any>(parsed.routes)) {
      const methods = Array.isArray(info.methods) ? info.methods.join(", ") : "";
      const approxLines = info.approxLines ? ` (~${info.approxLines} lines)` : "";
      const desc = info.Description ?? info.description ?? "";
      lines.push(`  ${filePath}${methods ? ` [${methods}]` : ""}${approxLines}`);
      if (desc) lines.push(`    → ${desc}`);
    }
  }

  return lines.join("\n");
}
