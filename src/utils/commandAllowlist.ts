/**
 * Allowlist matcher for LLM-generated shell commands.
 *
 * The code-generation model (see utils/agent.ts) is asked to emit `command`
 * actions alongside file writes. Those strings are model output, so they are
 * never executed as free-form shell. Every command must match one of exactly
 * three shapes:
 *
 *   npm install <pkg> [<pkg>...]        (optionally -D / --save-dev / -E / --save-exact)
 *   npx prisma generate
 *   npx prisma migrate dev --name <name>
 *
 * Matching is structural, not substring-based: the raw string is first rejected
 * if it contains any character outside a conservative charset (so no quoting,
 * no substitution, no chaining, no redirection can survive), then tokenised and
 * checked token-by-token against the rule for its verb. The caller executes the
 * canonical `argv` this module returns — never the original string.
 */

export type AllowedRule = "npm install" | "npx prisma generate" | "npx prisma migrate dev";

export interface AllowedCommand {
  ok: true;
  /** Canonical argv rebuilt from validated tokens. Execute this, not the input. */
  argv: string[];
  /** Canonical single-line form of `argv`, for printing in the confirmation prompt. */
  display: string;
  /** Which allowlist rule matched. */
  rule: AllowedRule;
}

export interface RejectedCommand {
  ok: false;
  /** Human-readable explanation of why the command was refused. */
  reason: string;
}

export type CommandCheck = AllowedCommand | RejectedCommand;

/** Shown to the user whenever a command is rejected. */
export const ALLOWLIST_HELP: readonly string[] = [
  "npm install <pkg> [<pkg>...]   (optional -D / --save-dev / -E / --save-exact)",
  "npx prisma generate",
  "npx prisma migrate dev --name <name>",
];

/**
 * Every character a legal command can contain. Anything else — quotes, `;`,
 * `&&`, `|`, `>`, backticks, `$(...)`, newlines, backslashes — is a hard reject
 * before tokenisation, so the tokens below are guaranteed shell-inert.
 *
 * `^` and `~` are deliberately excluded even though npm accepts them in version
 * ranges: `^` is cmd.exe's escape character, so on Windows a shell-invoked
 * `zod@^3.23.8` would silently arrive at npm as `zod@3.23.8`. Rejecting ranges
 * outright keeps behaviour identical on every platform.
 */
const SAFE_CHARS = /^[A-Za-z0-9@._/=+\- \t]*$/;
const UNSAFE_CHAR = /[^A-Za-z0-9@._/=+\- \t]/g;

/**
 * npm package spec: optional `@scope/`, lowercase name, optional exact version
 * or dist-tag. Range syntax (`^1.2.3`, `~1.2`, `>=1.0`, `1 || 2`) is not
 * accepted — pin an exact version or use a tag.
 */
const PKG_SPEC =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@(?:latest|next|canary|beta|\d+(?:\.\d+){0,2}(?:-[A-Za-z0-9.]+)?))?$/;

/** Flags accepted alongside `npm install`. */
const INSTALL_FLAGS = new Set(["-D", "--save-dev", "-E", "--save-exact"]);

/** Prisma migration name: `--name add_post_heading`. */
const MIGRATION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function reject(reason: string): RejectedCommand {
  return { ok: false, reason };
}

function allow(argv: string[], rule: AllowedRule): AllowedCommand {
  return { ok: true, argv, display: argv.join(" "), rule };
}

/**
 * Validate a model-generated command string against the allowlist.
 *
 * @returns `{ ok: true, argv, display, rule }` when it matches a rule exactly,
 *          otherwise `{ ok: false, reason }` explaining the refusal.
 */
export function parseAllowedCommand(raw: unknown): CommandCheck {
  if (typeof raw !== "string") {
    return reject(`Command is not a string (got ${typeof raw}).`);
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return reject("Command is empty.");
  }
  if (trimmed.length > 512) {
    return reject(`Command is ${trimmed.length} characters long — refusing anything over 512.`);
  }

  if (!SAFE_CHARS.test(trimmed)) {
    const offending = [...new Set(trimmed.match(UNSAFE_CHAR) ?? [])];
    const bad = offending.map((c) => JSON.stringify(c)).join(", ");

    // Version ranges are the one benign case that lands here — give it a
    // specific hint instead of the generic shell-operator message.
    if (offending.every((c) => c === "^" || c === "~")) {
      return reject(
        `Version ranges (${bad}) are not accepted — pin an exact version instead, ` +
          `e.g. "zod@3.23.8", or drop the version to take the latest.`
      );
    }

    return reject(
      `Command contains character(s) that are never allowed: ${bad}. ` +
        `Shell operators, quoting and substitution are not permitted — a command must be a plain ` +
        `space-separated invocation.`
    );
  }

  const argv = trimmed.split(/[ \t]+/).filter(Boolean);

  switch (argv[0]) {
    case "npm":
      return checkNpm(argv);
    case "npx":
      return checkNpx(argv);
    default:
      return reject(
        `Only "npm" and "npx" commands are allowed — this one starts with "${argv[0]}".`
      );
  }
}

// ---------------------------------------------------------------------------
// npm install <pkg> [<pkg>...]
// ---------------------------------------------------------------------------

function checkNpm(argv: string[]): CommandCheck {
  if (argv[1] !== "install") {
    return reject(
      `"${argv.slice(0, 2).join(" ")}" is not allowed — the only npm subcommand on the allowlist ` +
        `is "npm install <pkg>" (spelled out in full, not "npm i").`
    );
  }

  const rest = argv.slice(2);
  if (rest.length === 0) {
    return reject(
      `"npm install" with no package is not on the allowlist — it would install whatever ` +
        `package.json happens to contain. Name the package explicitly: "npm install <pkg>".`
    );
  }

  const packages: string[] = [];
  const flags: string[] = [];

  for (const token of rest) {
    if (token.startsWith("-")) {
      if (!INSTALL_FLAGS.has(token)) {
        return reject(
          `Flag "${token}" is not allowed on "npm install". Allowed flags: ` +
            `${[...INSTALL_FLAGS].join(", ")}.`
        );
      }
      if (!flags.includes(token)) flags.push(token);
      continue;
    }
    if (!PKG_SPEC.test(token)) {
      return reject(
        `"${token}" is not a valid package name. Expected a lowercase npm package — ` +
          `optionally scoped and optionally pinned to an exact version, e.g. "zod", ` +
          `"@prisma/client", "zod@3.23.8". Paths, URLs, git refs and version ranges are ` +
          `not accepted.`
      );
    }
    packages.push(token);
  }

  if (packages.length === 0) {
    return reject(`"npm install" was given flags but no package to install.`);
  }

  return allow(["npm", "install", ...flags, ...packages], "npm install");
}

// ---------------------------------------------------------------------------
// npx prisma generate  |  npx prisma migrate dev --name <name>
// ---------------------------------------------------------------------------

function checkNpx(argv: string[]): CommandCheck {
  if (argv[1] !== "prisma") {
    return reject(
      `"${argv.slice(0, 2).join(" ")}" is not allowed — the only npx binary on the allowlist is ` +
        `"prisma".`
    );
  }

  // npx prisma generate
  if (argv[2] === "generate") {
    if (argv.length !== 3) {
      return reject(
        `"npx prisma generate" takes no extra arguments — got ${argv.slice(3).join(" ")}.`
      );
    }
    return allow(["npx", "prisma", "generate"], "npx prisma generate");
  }

  // npx prisma migrate dev --name <name>
  if (argv[2] === "migrate") {
    if (argv[3] !== "dev") {
      return reject(
        `Only "npx prisma migrate dev --name <name>" is allowed — ` +
          `"${argv.slice(2, 4).join(" ")}" is not on the allowlist ` +
          `(reset, deploy and push are all destructive or environment-specific).`
      );
    }

    // Accept both `--name <name>` and `--name=<name>`; canonicalise to the former.
    let name: string | undefined;
    const tail = argv.slice(4);

    if (tail.length === 2 && tail[0] === "--name") {
      name = tail[1];
    } else if (tail.length === 1 && tail[0].startsWith("--name=")) {
      name = tail[0].slice("--name=".length);
    } else {
      return reject(
        `"npx prisma migrate dev" must be followed by exactly "--name <name>" — got ` +
          `"${tail.join(" ")}". Other migrate flags are not on the allowlist.`
      );
    }

    if (!MIGRATION_NAME.test(name)) {
      return reject(
        `Migration name "${name}" is not valid — use letters, digits, underscores and hyphens ` +
          `only (max 64 characters), e.g. "add_post_heading".`
      );
    }

    return allow(["npx", "prisma", "migrate", "dev", "--name", name], "npx prisma migrate dev");
  }

  return reject(
    `"${argv.slice(0, 3).join(" ")}" is not on the allowlist — only "npx prisma generate" and ` +
      `"npx prisma migrate dev --name <name>" are permitted.`
  );
}
