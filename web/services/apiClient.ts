import { invoke } from "@tauri-apps/api/core";

type QueryValue = string | number | boolean | null | undefined;

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

export function invokeOrApi<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  apiCall: () => Promise<T>,
): Promise<T> {
  if (isTauriRuntime()) {
    return args === undefined ? invoke<T>(command) : invoke<T>(command, args);
  }
  return apiCall();
}

export function toQueryString(params: Record<string, QueryValue>): string {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      searchParams.set(key, String(value));
    }
  });
  const query = searchParams.toString();
  return query ? `?${query}` : "";
}

export async function apiGet<T>(
  path: string,
  query?: Record<string, QueryValue>,
): Promise<T> {
  return apiRequest<T>(path + (query ? toQueryString(query) : ""));
}

export async function apiJson<T>(
  path: string,
  method: "POST" | "PUT" | "PATCH",
  body?: unknown,
): Promise<T> {
  return apiRequest<T>(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function apiNoContent(
  path: string,
  options?: RequestInit,
): Promise<void> {
  await apiRequest<void>(path, options, false);
}

export async function apiDelete(path: string): Promise<void> {
  await apiNoContent(path, { method: "DELETE" });
}

async function apiRequest<T>(
  path: string,
  options?: RequestInit,
  expectsJson = true,
): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) {
    throw new Error(await getErrorMessage(response));
  }
  if (response.status === 204 || !expectsJson) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

async function getErrorMessage(response: Response): Promise<string> {
  const body = await response.text();
  return body || `HTTP ${response.status}: ${response.statusText}`;
}
