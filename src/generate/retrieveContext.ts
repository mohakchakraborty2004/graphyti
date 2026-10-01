import { HydraDBError } from "@hydradb/sdk";
import { buildString } from "@hydradb/sdk/helpers";
import { client } from "../graph/hydraClient";
import { requireHydraConfig } from "../config";
import { error as themeError } from "../cli/theme";
import { logDebug, logWarn } from "../utils/logger";

/**
 * Retrieve graph-grounded context from HydraDB for a given user query.
 *
 * Uses hybrid retrieval with thinking mode and graph context enabled.
 * Returns an LLM-ready string formatted by the SDK's buildString helper
 * (avoids hand-rolling raw JSON into the prompt).
 *
 * @param userQuery - The natural-language query from the user.
 * @returns A formatted context string, or null if HydraDB is unreachable /
 *          returns an error (caller decides whether to fall back to context.json).
 */
export async function retrieveContext(userQuery: string): Promise<string | null> {
  try {
    const { database, collection } = requireHydraConfig();
    const result = await client.query({
      database,
      collection,
      query: userQuery,
      type: "knowledge",
      queryBy: "hybrid",
      mode: "thinking",
      graphContext: true,
      maxResults: 15,
    });

    // buildString accepts the full envelope ({ success, data, error, meta })
    // and auto-unwraps .data — do not pass raw JSON to the LLM.
    const context = buildString(result);
    logDebug("context.query", { query: userQuery, lines: context.split("\n").length });
    return context;
  } catch (err) {
    if (err instanceof HydraDBError) {
      const errorCode = err.statusCode ?? "unknown";
      const requestId =
        err.rawResponse?.headers?.get("x-request-id") ??
        err.rawResponse?.headers?.get("X-Request-Id") ??
        "unknown";
      logWarn("context.queryFailed", {
        query: userQuery,
        errorCode,
        requestId,
        error: err.message,
      });
      console.error(
        `${themeError("✗")} HydraDB retrieval failed — error_code=${errorCode} request_id=${requestId}:`,
        err.message
      );
    } else {
      logWarn("context.queryFailed", { query: userQuery, error: err });
      console.error(`${themeError("✗")} Unexpected error during HydraDB retrieval:`, err);
    }
    return null;
  }
}
