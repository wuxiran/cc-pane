/**
 * Type-only brands for ids that are all plain strings at runtime.
 *
 * Motivation: docs/69 records the launch-history bug where a launch id was
 * treated like a project id. These brands make new seams state which kind of id
 * they accept without changing storage, IPC payloads, or persisted data.
 */
export type PtySessionId = string & { readonly __brand: "PtySessionId" };
export type ResumeId = string & { readonly __brand: "ResumeId" };
export type LaunchId = string & { readonly __brand: "LaunchId" };
export type TabId = string & { readonly __brand: "TabId" };

export function asPtySessionId(value: string): PtySessionId {
  return value as PtySessionId;
}

export function asResumeId(value: string): ResumeId {
  return value as ResumeId;
}

export function asLaunchId(value: string): LaunchId {
  return value as LaunchId;
}

export function asTabId(value: string): TabId {
  return value as TabId;
}
