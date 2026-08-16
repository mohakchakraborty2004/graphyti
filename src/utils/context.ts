import { contextGatherer } from "./agent";
import { getProjectStructure, saveContextFile, shallowScan } from "./StrAnalyzer";
import { info, sym } from "../cli/theme";
import ora from "ora";

/**
 * FALLBACK ONLY — the flat context.json approach, superseded by the code graph.
 */
export default async function ContextGen(){
    const structure = getProjectStructure();
    const scanSpin = ora({ text: "Scanning project files...", color: "cyan" }).start();
    const scanResult = shallowScan(structure.root);
    scanSpin.succeed(`Scan complete — ${Object.keys(scanResult).length} files`);

    const genSpin = ora({ text: "Generating context file...", color: "cyan" }).start();
    const context = await contextGatherer(structure, scanResult);
    saveContextFile(context, structure.root);
    genSpin.succeed(".dbagent/context.json generated");
    console.log(`    ${info("ℹ")} Do not push context.json to github`);
}

/**
 * FALLBACK ONLY — format the raw string stored in context.json into an
 * LLM-readable string with the same rough shape buildString() produces: file
 * paths, models/fields, and a natural-language summary.
 */
export function formatLegacyContext(raw: string): string {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw.trim();
  }

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

  lines.push("=== Project Context ===");
  if (parsed.generatedAt) {
    lines.push(`Generated: ${parsed.generatedAt}`);
  }

  if (parsed.summary) {
    const { totalFiles, totalLines } = parsed.summary;
    lines.push(`\nSummary: ${totalFiles ?? "?"} files, ~${totalLines ?? "?"} lines of code`);
  }

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

  if (parsed.routes && typeof parsed.routes === "object") {
    lines.push("\nKnown routes and files:");
    for (const [filePath, routeInfo] of Object.entries<any>(parsed.routes)) {
      const methods = Array.isArray(routeInfo.methods) ? routeInfo.methods.join(", ") : "";
      const approxLines = routeInfo.approxLines ? ` (~${routeInfo.approxLines} lines)` : "";
      const desc = routeInfo.Description ?? routeInfo.description ?? "";
      lines.push(`  ${filePath}${methods ? ` [${methods}]` : ""}${approxLines}`);
      if (desc) lines.push(`    → ${desc}`);
    }
  }

  return lines.join("\n");
}
