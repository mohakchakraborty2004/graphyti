import { HydraDBClient, HydraDBError } from "@hydradb/sdk";
import { env, requireHydraConfig } from "../config";

// ../config loads .env from the package root before this module's body runs.
// The token is read unvalidated so that importing this module never throws;
// every operation below gates on requireHydraConfig() instead.
export const client = new HydraDBClient({ token: env.hydraDbApiKey });

const POLL_MS = 2000;
const MAX_WAIT_MS = 60_000;
const READY = new Set(["graph_creation", "completed"]);
const FAILED = new Set(["errored", "failed"]);

function requestIdFrom(meta: { requestId?: string } | undefined, err?: HydraDBError): string {
  if (meta?.requestId) return meta.requestId;
  const headerId = err?.rawResponse?.headers?.get("x-request-id") ?? err?.rawResponse?.headers?.get("X-Request-Id");
  return headerId ?? "unknown";
}

export function hydraErrorMessage(
  prefix: string,
  opts: {
    errorCode?: string;
    errorMessage?: string;
    requestId?: string;
    id?: string;
    indexingStatus?: string;
  }
): string {
  const parts = [prefix];
  if (opts.id) parts.push(`id=${opts.id}`);
  if (opts.indexingStatus) parts.push(`indexingStatus=${opts.indexingStatus}`);
  parts.push(`error_code=${opts.errorCode ?? "unknown"}`);
  parts.push(`request_id=${opts.requestId ?? "unknown"}`);
  if (opts.errorMessage) parts.push(opts.errorMessage);
  return parts.join(" ");
}

export interface WaitForIndexedOptions {
  /**
   * When false, a timeout returns the still-pending ids instead of throwing.
   *
   * HydraDB can leave an id in `queued` indefinitely for reasons that have
   * nothing to do with the correctness of what we uploaded. Callers that hold
   * state worth keeping (the local graph cache, a staged verification) must not
   * lose it to a remote stall, so they opt out and degrade to a warning.
   */
  throwOnTimeout?: boolean;
}

/**
 * Block until every id reports a ready indexing status.
 *
 * @returns the ids still pending when the wait gave up — empty on full success.
 */
export async function waitForIndexed(
  ids: string[],
  opts: WaitForIndexedOptions = {}
): Promise<string[]> {
  if (ids.length === 0) return [];
  const throwOnTimeout = opts.throwOnTimeout ?? true;
  const { database, collection } = requireHydraConfig();

  const pending = new Set(ids);
  const started = Date.now();

  while (pending.size > 0) {
    if (Date.now() - started > MAX_WAIT_MS) {
      if (throwOnTimeout) {
        throw new Error(
          `Timed out after ${MAX_WAIT_MS / 1000}s waiting for HydraDB indexing. Still pending: ${[...pending].join(", ")}`
        );
      }
      return [...pending];
    }

    let envelope;
    try {
      envelope = await client.context.status({
        database,
        collection,
        ids: [...pending],
      });
    } catch (err) {
      const hydraErr = err instanceof HydraDBError ? err : undefined;
      throw new Error(
        hydraErrorMessage("HydraDB context.status failed.", {
          errorCode: hydraErr?.statusCode != null ? String(hydraErr.statusCode) : "STATUS_FAILED",
          errorMessage: hydraErr?.message ?? (err instanceof Error ? err.message : String(err)),
          requestId: requestIdFrom(undefined, hydraErr),
        })
      );
    }

    const requestId = requestIdFrom(envelope.meta);
    if (envelope.error?.code || envelope.success === false) {
      throw new Error(
        hydraErrorMessage("HydraDB context.status returned an error.", {
          errorCode: envelope.error?.code,
          errorMessage: envelope.error?.message,
          requestId,
        })
      );
    }

    for (const status of envelope.data?.statuses ?? []) {
      const id = status.id;
      if (!id || !pending.has(id)) continue;
      const indexingStatus = (status.indexingStatus ?? "").toLowerCase();

      if (FAILED.has(indexingStatus) || status.success === false) {
        throw new Error(
          hydraErrorMessage("HydraDB indexing failed.", {
            id,
            indexingStatus: status.indexingStatus,
            errorCode: status.errorCode || envelope.error?.code,
            errorMessage: status.errorMessage || status.message,
            requestId,
          })
        );
      }

      if (READY.has(indexingStatus)) {
        pending.delete(id);
      }
    }

    if (pending.size === 0) return [];
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return [];
}
