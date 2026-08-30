import { API_BASE_URL, API_TOKEN } from './config';

type QueryOptions = {
  dryRun?: boolean;
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

export function getStatus<T = unknown>() {
  return request<T>('/api/status');
}

export function initGraph<T = unknown>() {
  return request<T>('/api/init', { method: 'POST' });
}

export function runQuery<T = unknown>(query: string, opts?: QueryOptions) {
  return request<T>('/api/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, ...(opts?.dryRun === undefined ? {} : { dryRun: opts.dryRun }) }),
  });
}
