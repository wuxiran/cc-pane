import type { PtySessionId } from "@/types/ids";

export interface SessionScopedResource {
  name: string;
  dispose(sessionId: PtySessionId): void;
}

const resources = new Map<string, SessionScopedResource>();

export function registerSessionScopedResource(resource: SessionScopedResource): void {
  resources.set(resource.name, resource);
}

export function disposeSessionScopedResources(sessionId: PtySessionId): void {
  for (const resource of resources.values()) {
    try {
      resource.dispose(sessionId);
    } catch (error) {
      console.warn(`[session-resource] failed to dispose ${resource.name}:`, error);
    }
  }
}

export function registeredSessionScopedResourceNames(): string[] {
  return [...resources.keys()].sort();
}
