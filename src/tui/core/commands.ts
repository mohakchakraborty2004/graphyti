/**
 * Slash commands and their matching (§19) — pure, so ranking is verifiable.
 */

export interface Command {
  name: string;
  description: string;
  /** Extra terms that should match this command. */
  aliases?: string[];
}

export const COMMANDS: Command[] = [
  { name: "/help", description: "Show what graphyti can do" },
  { name: "/clear", description: "Clear the conversation" },
  { name: "/dry-run", description: "Toggle preview-only mode", aliases: ["dryrun", "preview"] },
  { name: "/debug", description: "Toggle internal detail" },
  { name: "/doctor", description: "Check environment and credentials" },
  { name: "/init-graph", description: "Re-initialize the code graph", aliases: ["init", "refresh"] },
  { name: "/exit", description: "Quit graphyti", aliases: ["quit"] },
];

/**
 * Filter and rank commands against a query.
 *
 * Exact beats prefix beats substring beats description-only. The ranking exists
 * so the first Enter press is predictable: typing `/cl` must select `/clear`,
 * not whichever command happens to mention "clear" in its description.
 */
export function filterCommands(query: string): Command[] {
  const needle = query.replace(/^\//, "").toLowerCase().trim();
  if (needle.length === 0) return COMMANDS;

  const scored = COMMANDS.map((command) => {
    const name = command.name.replace(/^\//, "").toLowerCase();
    const terms = [name, ...(command.aliases ?? [])];

    let score = -1;
    for (const term of terms) {
      if (term === needle) score = Math.max(score, 3);
      else if (term.startsWith(needle)) score = Math.max(score, 2);
      else if (term.includes(needle)) score = Math.max(score, 1);
    }
    if (score < 0 && command.description.toLowerCase().includes(needle)) score = 0;

    return { command, score };
  }).filter((entry) => entry.score >= 0);

  scored.sort(
    (a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name)
  );
  return scored.map((entry) => entry.command);
}
