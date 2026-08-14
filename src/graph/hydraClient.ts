import dotenv from "dotenv";
import path from "path";
import { HydraDBClient, HydraDBError } from "@hydradb/sdk";

// Resolve .env from the tool's own root regardless of cwd.
// Compiled entrypoint sits at dist/index.js; hydraClient.js is at dist/graph/hydraClient.js
// — two levels up from __dirname lands at the package root where .env lives.
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

export const client = new HydraDBClient({ token: process.env.HYDRA_DB_API_KEY });

export const DATABASE = process.env.HYDRA_DB_DATABASE ?? "";
export const COLLECTION = process.env.HYDRA_DB_COLLECTION ?? "";

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

export async function waitForIndexed(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  if (!DATABASE) throw new Error("HYDRA_DB_DATABASE is not set");

  const pending = new Set(ids);
  const started = Date.now();

  while (pending.size > 0) {
    if (Date.now() - started > MAX_WAIT_MS) {
      throw new Error(
        `Timed out after ${MAX_WAIT_MS / 1000}s waiting for HydraDB indexing. Still pending: ${[...pending].join(", ")}`
      );
    }

    let envelope;
    try {
      envelope = await client.context.status({
        database: DATABASE,
        collection: COLLECTION || undefined,
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

    if (pending.size === 0) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
