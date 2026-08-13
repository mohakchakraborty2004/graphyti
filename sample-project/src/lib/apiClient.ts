export function apiGet(path: string): Promise<Response> {
  return fetch(path);
}
