/**
 * Tests for config.ts — the single source of truth for environment variables.
 *
 * The module's promises are all about failure modes, and none of them were
 * covered: that a missing variable fails loudly at the operation needing it
 * rather than as a downstream 401, that every missing name appears in one
 * message, that importing the module never throws, and that an empty value is
 * treated as absent rather than sent to the API. Run with:
 *   npm run test:config
 *
 * config.ts caches (dotenv at module load, plus cachedHydraConfig), so each
 * case re-requires it through require.cache to get a clean module. Two details
 * make that hermetic:
 *   - dotenv.config is stubbed to a recorder, so the developer's real .env can
 *     never leak in and change the result.
 *   - "absent" is spelled as an empty string in process.env. normalize() maps
 *     "" and undefined to the same thing, and dotenv skips keys that already
 *     exist, so this survives even if the stub above ever stops taking effect.
 */

import path from "path";
import dotenv from "dotenv";

// ---------------------------------------------------------------------------
// Stub dotenv before config.ts is ever loaded
// ---------------------------------------------------------------------------

/** Paths dotenv.config was asked to load, one entry per fresh require. */
const dotenvCalls: Array<string | undefined> = [];

(dotenv as any).config = (options?: { path?: string }) => {
  dotenvCalls.push(options?.path);
  return { parsed: {} };
};

const CONFIG_MODULE = require.resolve("../config");
type ConfigModule = typeof import("../config");

const KEYS = [
  "HYDRA_DB_API_KEY",
  "HYDRA_DB_DATABASE",
  "HYDRA_DB_COLLECTION",
  "OPENROUTER_API_KEY",
] as const;

type EnvState = Partial<Record<(typeof KEYS)[number], string>>;

/** Whatever the developer actually has set, restored at the end of the run. */
const savedEnv = new Map<string, string | undefined>(KEYS.map((k) => [k, process.env[k]]));

/**
 * Load a pristine copy of config.ts against exactly `state`. Any key not named
 * is set to "" — absent as far as normalize() is concerned.
 */
function freshConfig(state: EnvState): ConfigModule {
  for (const key of KEYS) process.env[key] = state[key] ?? "";
  delete require.cache[CONFIG_MODULE];
  return require("../config") as ConfigModule;
}

const FULL_ENV: EnvState = {
  HYDRA_DB_API_KEY: "hydra-key-abc123",
  HYDRA_DB_DATABASE: "graphyti_db",
  HYDRA_DB_COLLECTION: "code_graph",
  OPENROUTER_API_KEY: "openrouter-key-xyz789",
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = true;

function fail(label: string, detail: string): void {
  console.log(`  ❌ FAIL  ${label}`);
  console.log(`           ${detail}`);
  passed = false;
}

function pass(label: string, note = ""): void {
  console.log(`  ✅ PASS  ${label}${note ? `  ${note}` : ""}`);
}

function check(label: string, condition: boolean, detail: string): void {
  if (condition) pass(label);
  else fail(label, detail);
}

/** Run `fn`, returning its thrown Error, or null if it unexpectedly succeeded. */
function captureThrow(fn: () => unknown): Error | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err as Error;
  }
}

// ---------------------------------------------------------------------------
// 1. Importing config must never throw, whatever the environment
// ---------------------------------------------------------------------------

console.log("\n=== IMPORT IS ALWAYS SAFE ===");

{
  // The docstring's promise: commands needing no credentials (graphyti init,
  // --legacy-context) must still run on a machine with a blank .env.
  const err = captureThrow(() => freshConfig({}));
  check("importing with a blank environment does not throw", err === null, `threw: ${err?.message}`);
}

{
  const before = dotenvCalls.length;
  const config = freshConfig(FULL_ENV);
  const loaded = dotenvCalls.slice(before);
  check(
    "dotenv is loaded once, from the package root",
    loaded.length === 1 && loaded[0] === config.ENV_PATH,
    `calls=${JSON.stringify(loaded)} ENV_PATH=${config.ENV_PATH}`
  );
  // ENV_PATH is __dirname/../.env, so it must sit beside package.json — one
  // level above src/ (and above dist/ once compiled).
  check(
    "ENV_PATH points at the tool's own root, not the cwd",
    path.basename(config.ENV_PATH) === ".env" &&
      path.resolve(config.ENV_PATH) === path.resolve(__dirname, "..", "..", ".env"),
    `ENV_PATH=${config.ENV_PATH}`
  );
}

// ---------------------------------------------------------------------------
// 2. requireHydraConfig — the happy path
// ---------------------------------------------------------------------------

console.log("\n=== requireHydraConfig: PRESENT ===");

{
  const config = freshConfig(FULL_ENV);
  const hydra = config.requireHydraConfig();
  check(
    "returns all three values",
    hydra.apiKey === "hydra-key-abc123" &&
      hydra.database === "graphyti_db" &&
      hydra.collection === "code_graph",
    JSON.stringify(hydra)
  );
}

{
  const config = freshConfig({ ...FULL_ENV, HYDRA_DB_API_KEY: "  padded-key  " });
  check(
    "values are trimmed",
    config.requireHydraConfig().apiKey === "padded-key",
    JSON.stringify(config.requireHydraConfig().apiKey)
  );
}

{
  const config = freshConfig(FULL_ENV);
  const first = config.requireHydraConfig();
  const second = config.requireHydraConfig();
  check("repeat calls return the cached object", first === second, "identity differed");
}

// ---------------------------------------------------------------------------
// 3. The collection is optional — and "" must mean default, never ""
// ---------------------------------------------------------------------------

console.log("\n=== COLLECTION IS OPTIONAL ===");

for (const [label, value] of [
  ["absent", undefined],
  ["empty string", ""],
  ["whitespace only", "   "],
] as Array<[string, string | undefined]>) {
  const config = freshConfig({
    HYDRA_DB_API_KEY: "k",
    HYDRA_DB_DATABASE: "d",
    HYDRA_DB_COLLECTION: value,
  });
  const { collection } = config.requireHydraConfig();
  // undefined makes the SDK omit the field; "" would be sent as a real value.
  check(
    `collection ${label} → undefined, not ""`,
    collection === undefined,
    `got ${JSON.stringify(collection)}`
  );
}

// ---------------------------------------------------------------------------
// 4. requireHydraConfig — the failure modes
// ---------------------------------------------------------------------------

console.log("\n=== requireHydraConfig: MISSING ===");

{
  const config = freshConfig({ HYDRA_DB_DATABASE: "d", OPENROUTER_API_KEY: "o" });
  const err = captureThrow(() => config.requireHydraConfig());
  check(
    "missing API key throws and names it",
    err !== null && /HYDRA_DB_API_KEY/.test(err.message),
    `err=${err?.message}`
  );
  check(
    "and does not name the variable that was set",
    err !== null && !/HYDRA_DB_DATABASE/.test(err.message),
    `err=${err?.message}`
  );
}

{
  const config = freshConfig({ HYDRA_DB_API_KEY: "k", OPENROUTER_API_KEY: "o" });
  const err = captureThrow(() => config.requireHydraConfig());
  check(
    "missing database throws and names it",
    err !== null && /HYDRA_DB_DATABASE/.test(err.message),
    `err=${err?.message}`
  );
}

{
  // The whole point of collecting Zod issues: one message naming both, instead
  // of fixing one variable and re-running to discover the next.
  const config = freshConfig({});
  const err = captureThrow(() => config.requireHydraConfig());
  check(
    "both missing → one error naming both",
    err !== null &&
      /HYDRA_DB_API_KEY/.test(err.message) &&
      /HYDRA_DB_DATABASE/.test(err.message),
    `err=${err?.message}`
  );
  check(
    "the error says where to fix it",
    err !== null && err.message.includes(config.ENV_PATH) && /re-run/.test(err.message),
    `err=${err?.message}`
  );
  check(
    "each name appears once, not once per Zod issue",
    err !== null && (err.message.match(/HYDRA_DB_API_KEY/g) ?? []).length === 1,
    `err=${err?.message}`
  );
}

{
  // A key present but blank is the case a plain `if (!process.env.X) throw`
  // would catch, and an `?? ""` default would silently send to the API.
  const config = freshConfig({ HYDRA_DB_API_KEY: "   ", HYDRA_DB_DATABASE: "d" });
  const err = captureThrow(() => config.requireHydraConfig());
  check(
    "whitespace-only credential counts as missing",
    err !== null && /HYDRA_DB_API_KEY/.test(err.message),
    `err=${err?.message}`
  );
}

{
  // Failure must not be cached as success, or a later call could get a
  // half-built config.
  const config = freshConfig({});
  captureThrow(() => config.requireHydraConfig());
  const second = captureThrow(() => config.requireHydraConfig());
  check("a failed lookup keeps throwing", second !== null, "second call did not throw");
}

// ---------------------------------------------------------------------------
// 5. requireOpenRouterApiKey
// ---------------------------------------------------------------------------

console.log("\n=== requireOpenRouterApiKey ===");

{
  const config = freshConfig(FULL_ENV);
  check(
    "returns the key when set",
    config.requireOpenRouterApiKey() === "openrouter-key-xyz789",
    JSON.stringify(config.requireOpenRouterApiKey())
  );
}

{
  const config = freshConfig({ HYDRA_DB_API_KEY: "k", HYDRA_DB_DATABASE: "d" });
  const err = captureThrow(() => config.requireOpenRouterApiKey());
  check(
    "missing key throws and names OPENROUTER_API_KEY",
    err !== null && /OPENROUTER_API_KEY/.test(err.message),
    `err=${err?.message}`
  );
}

{
  // Hydra credentials being present must not make the OpenRouter check pass, and
  // vice versa — they are independent gates.
  const config = freshConfig({ OPENROUTER_API_KEY: "o" });
  check(
    "OpenRouter key alone does not satisfy the Hydra gate",
    captureThrow(() => config.requireHydraConfig()) !== null,
    "requireHydraConfig did not throw"
  );
  check(
    "…and the OpenRouter gate still passes",
    config.requireOpenRouterApiKey() === "o",
    "requireOpenRouterApiKey failed"
  );
}

// ---------------------------------------------------------------------------
// 6. configSummary must never print a secret
// ---------------------------------------------------------------------------

console.log("\n=== configSummary ===");

{
  const config = freshConfig(FULL_ENV);
  const summary = config.configSummary();
  check(
    "no secret value appears in the summary",
    !summary.includes("hydra-key-abc123") && !summary.includes("openrouter-key-xyz789"),
    `summary=${summary}`
  );
  check(
    "secrets are reported as set/MISSING",
    /HYDRA_DB_API_KEY=set/.test(summary) && /OPENROUTER_API_KEY=set/.test(summary),
    `summary=${summary}`
  );
  check(
    "non-secret values are shown",
    /database=graphyti_db/.test(summary) && /collection=code_graph/.test(summary),
    `summary=${summary}`
  );
}

{
  const config = freshConfig({ HYDRA_DB_DATABASE: "d" });
  const summary = config.configSummary();
  check(
    "missing secrets are flagged MISSING",
    /HYDRA_DB_API_KEY=MISSING/.test(summary) && /OPENROUTER_API_KEY=MISSING/.test(summary),
    `summary=${summary}`
  );
  check(
    "an absent collection reads as (default)",
    /collection=\(default\)/.test(summary),
    `summary=${summary}`
  );
}

{
  // configSummary is for debug logging, so it must work before anything is
  // validated — never throw on a blank environment.
  const config = freshConfig({});
  const err = captureThrow(() => config.configSummary());
  check("configSummary never throws", err === null, `threw: ${err?.message}`);
}

// ---------------------------------------------------------------------------
// Restore the developer's real environment
// ---------------------------------------------------------------------------

for (const [key, value] of savedEnv) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
delete require.cache[CONFIG_MODULE];

console.log(
  passed ? `\n✅ Config behaved as expected` : `\n❌ Some config cases failed`
);
process.exit(passed ? 0 : 1);
