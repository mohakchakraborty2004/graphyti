import { API_BASE_URL, API_TOKEN } from './config';

type QueryOptions = {
  dryRun?: boolean;
};

export type GraphStatus = {
  graphReady: boolean;
  nodeCount?: number;
};

export type GraphInitResult = {
  success: boolean;
  nodeCount: number;
  edgeCount: number;
};

export type QueryResult = {
  query: string;
  filesWritten: string[];
  blastRadiusSize: number;
  verification: string;
  graphIndexUpdated: boolean;
  elapsedMs: number;
  exitCode: number;
  branch?: string;
};

function apiUrl(path: string) {
  return `${API_BASE_URL.replace(/\/$/, '')}${path}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      ...init?.headers,
    },
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`API request failed (${response.status} ${response.statusText}): ${body}`);
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    return body as T;
  }
}

export function getStatus() {
  return request<GraphStatus>('/api/status');
}

export function initGraph() {
  return request<GraphInitResult>('/api/init', { method: 'POST' });
}

export function runQuery(query: string, opts?: QueryOptions) {
  // React Native fetch has no default request timeout; longer Graphyti runs are
  // intentionally allowed to finish rather than being aborted by the client.
  return request<QueryResult>('/api/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, ...(opts?.dryRun === undefined ? {} : { dryRun: opts.dryRun }) }),
  });
}
