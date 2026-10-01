import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Single source of truth for every environment variable graphyti reads.
 *
 * Two rules this module exists to enforce:
 *   1. `.env` is loaded exactly once, from the tool's own root. graphyti runs as
 *      a global CLI inside somebody else's project, so `process.cwd()` is never
 *      our package root and cannot be used to find `.env`.
 *   2. A missing variable fails once, loudly, at the operation that needs it —
 *      never as an opaque 401 from a downstream SDK, and never silently as an
 *      empty-string default that gets sent to the API.
 *
 * Importing this module never throws. Validation happens in the `require*`
 * helpers so commands that need no credentials (`graphyti init`,
 * `--legacy-context`) still run on a machine with a blank `.env`.
 */

/**
 * config.js compiles to dist/config.js, so one level up is the package root.
 * The same holds for src/config.ts under ts-node.
 */
export const ENV_PATH = path.join(__dirname, "..", ".env");

// dotenv v17 prints a promotional "injected env" line by default. The TUI
// owns the terminal surface, so dependency chatter must never appear above the
// prompt or look like an agent error.
dotenv.config({ path: ENV_PATH, quiet: true });

/** A `.env` line like `FOO=` yields "" — that is absent, not configured. */
function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Every variable, normalized. All optional: read these directly only when an
 * absent value is genuinely acceptable, otherwise go through a `require*` helper.
 */
export const env = {
  hydraDbApiKey: normalize(process.env.HYDRA_DB_API_KEY),
  hydraDbDatabase: normalize(process.env.HYDRA_DB_DATABASE),
  hydraDbCollection: normalize(process.env.HYDRA_DB_COLLECTION),
  openrouterApiKey: normalize(process.env.OPENROUTER_API_KEY),
  openrouterModel: normalize(process.env.OPENROUTER_MODEL),
  /**
   * Where run logs are written. A path (absolute, or relative to the target
   * project) or `off`. Unset means the default
   * `<projectRoot>/.dbagent/logs/graphyti.log`. Read by `utils/logger.ts` at
   * configure time, never validated here: a log destination is not credentials,
   * and a bad value must degrade to "logging off", not fail the run.
   */
  graphytiLog: normalize(process.env.GRAPHYTI_LOG),
} as const;

export interface HydraConfig {
  apiKey: string;
  database: string;
  /**
   * `undefined` means "the database's default collection" — pass it straight
   * through so the SDK omits the field rather than sending an empty string.
   */
  collection: string | undefined;
}

const hydraSchema = z.object({
  HYDRA_DB_API_KEY: z.string().min(1),
  HYDRA_DB_DATABASE: z.string().min(1),
});

const openrouterSchema = z.object({
  OPENROUTER_API_KEY: z.string().min(1),
});

const openrouterModelSchema = z.object({
  OPENROUTER_MODEL: z.string().min(1),
});

/** Name every missing variable in one message instead of failing on the first. */
function missingConfigError(error: z.ZodError): Error {
  const names = [...new Set(error.issues.map((issue) => String(issue.path[0])))];
  return new Error(
    `Missing required configuration: ${names.join(", ")}. ` +
      `Set ${names.length === 1 ? "it" : "them"} in ${ENV_PATH} and re-run.`
  );
}

let cachedHydraConfig: HydraConfig | undefined;

/**
 * Credentials for any HydraDB call. Call this at the top of an operation that
 * talks to HydraDB — it validates the API key too, which the old
 * `if (!database) throw` guards did not.
 *
 * @throws if HYDRA_DB_API_KEY or HYDRA_DB_DATABASE is missing.
 */
export function requireHydraConfig(): HydraConfig {
  if (cachedHydraConfig) return cachedHydraConfig;

  const parsed = hydraSchema.safeParse({
    HYDRA_DB_API_KEY: env.hydraDbApiKey,
    HYDRA_DB_DATABASE: env.hydraDbDatabase,
  });
  if (!parsed.success) throw missingConfigError(parsed.error);

  cachedHydraConfig = {
    apiKey: parsed.data.HYDRA_DB_API_KEY,
    database: parsed.data.HYDRA_DB_DATABASE,
    collection: env.hydraDbCollection,
  };
  return cachedHydraConfig;
}

/**
 * @throws if OPENROUTER_API_KEY is missing.
 */
export function requireOpenRouterApiKey(): string {
  const parsed = openrouterSchema.safeParse({ OPENROUTER_API_KEY: env.openrouterApiKey });
  if (!parsed.success) throw missingConfigError(parsed.error);
  return parsed.data.OPENROUTER_API_KEY;
}

/** The model is an explicit deployment setting; there is no provider fallback. */
export function requireOpenRouterModel(): string {
  const parsed = openrouterModelSchema.safeParse({ OPENROUTER_MODEL: env.openrouterModel });
  if (!parsed.success) throw missingConfigError(parsed.error);
  return parsed.data.OPENROUTER_MODEL;
}

/** Human-readable config state for debug logs. Never prints secret values. */
export function configSummary(): string {
  const secret = (value: string | undefined) => (value ? "set" : "MISSING");
  return [
    `database=${env.hydraDbDatabase ?? "MISSING"}`,
    `collection=${env.hydraDbCollection ?? "(default)"}`,
    `HYDRA_DB_API_KEY=${secret(env.hydraDbApiKey)}`,
    `OPENROUTER_API_KEY=${secret(env.openrouterApiKey)}`,
    `OPENROUTER_MODEL=${env.openrouterModel ?? "MISSING"}`,
    // Not a credential — the destination is worth showing when a run produced
    // no log file, or produced one somewhere unexpected.
    `GRAPHYTI_LOG=${env.graphytiLog ?? "(default .dbagent/logs/graphyti.log)"}`,
  ].join(" ");
}
