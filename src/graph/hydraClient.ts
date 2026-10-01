import { HydraDBClient, HydraDBError } from "@hydradb/sdk";
import { env, requireHydraConfig } from "../config";
import { createLogger } from "../utils/logger";

// Polling an id through HydraDB's indexing queue is invisible otherwise: a stall
// looks identical to a slow success from the outside. Everything here is logged
// at debug — silent by default, `GRAPHYTI_LOG_LEVEL=debug` to watch the wait.
const log = createLogger("hydra");

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
  log.debug(`waiting for ${ids.length} id(s) to index in ${database}/${collection}`);

  while (pending.size > 0) {
    const elapsedMs = Date.now() - started;
    if (elapsedMs > MAX_WAIT_MS) {
      const stillPending = [...pending].join(", ");
      if (throwOnTimeout) {
        throw new Error(
          `Timed out after ${MAX_WAIT_MS / 1000}s waiting for HydraDB indexing. Still pending: ${stillPending}`
        );
      }
      log.debug(`giving up after ${elapsedMs}ms, returning ${pending.size} still-pending id(s): ${stillPending}`);
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
        const failure = hydraErrorMessage("HydraDB indexing failed.", {
          id,
          indexingStatus: status.indexingStatus,
          errorCode: status.errorCode || envelope.error?.code,
          errorMessage: status.errorMessage || status.message,
          requestId,
        });
        // The caller sees this as a thrown error; log it too so a debug run
        // has the request id even when the error is caught upstream.
        log.debug(failure);
        throw new Error(failure);
      }

      if (READY.has(indexingStatus)) {
        pending.delete(id);
        log.debug(`${id} ready (${status.indexingStatus}), ${pending.size} still pending`);
      }
    }

    if (pending.size === 0) {
      log.debug(`all ${ids.length} id(s) indexed after ${Date.now() - started}ms`);
      return [];
    }
    log.debug(`${pending.size} id(s) still pending after ${Date.now() - started}ms, rechecking in ${POLL_MS}ms`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return [];
}
