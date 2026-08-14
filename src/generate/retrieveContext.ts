import { HydraDBError } from "@hydradb/sdk";
import { buildString } from "@hydradb/sdk/helpers";
import { client, DATABASE, COLLECTION } from "../graph/hydraClient";

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
    const result = await client.query({
      database: DATABASE,
      collection: COLLECTION,
      query: userQuery,
      type: "knowledge",
      queryBy: "hybrid",
      mode: "thinking",
      graphContext: true,
      maxResults: 15,
    });

    // buildString accepts the full envelope ({ success, data, error, meta })
    // and auto-unwraps .data — do not pass raw JSON to the LLM.
    return buildString(result);
  } catch (err) {
    if (err instanceof HydraDBError) {
      // Log the error code and request id per HydraDB error-handling docs,
      // then return null so the caller can fall back to legacy context.json.
      const errorCode = err.statusCode ?? "unknown";
      const requestId =
        err.rawResponse?.headers?.get("x-request-id") ??
        err.rawResponse?.headers?.get("X-Request-Id") ??
        "unknown";
      console.error(
        `❌ HydraDB retrieval failed — error_code=${errorCode} request_id=${requestId}:`,
        err.message
      );
    } else {
      console.error("❌ Unexpected error during HydraDB retrieval:", err);
    }
    return null;
  }
}
