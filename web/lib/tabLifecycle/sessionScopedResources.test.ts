import { afterEach, describe, expect, it } from "vitest";
import { useContextUsageStore } from "@/stores/useContextUsageStore";
import { useTerminalInputActivityStore } from "@/stores/useTerminalInputActivityStore";
import "@/stores/useTerminalRestoreLogStore";
import { useTerminalStatusStore } from "@/stores/useTerminalStatusStore";
import { asPtySessionId } from "@/types/ids";
import type { TerminalStatusInfo } from "@/types";
import {
  disposeSessionScopedResources,
  registeredSessionScopedResourceNames,
} from "./sessionScopedResources";

const STORE_MODULES = import.meta.glob("../../stores/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const REGISTERED_SESSION_MAP_STORES = {
  "useContextUsageStore.ts": "contextUsage",
  "useTerminalStatusStore.ts": "terminalStatus",
} as const;

const MAP_STORE_EXEMPTIONS = {
  "useFileTreeStore.ts": "local file-tree node index, not keyed by sessionId",
  "useOrchestratorStore.ts": "task binding node index, not keyed by sessionId",
  "useShortcutsStore.ts": "shortcut action registry, not keyed by sessionId",
} as const;

function storeFileName(path: string): string {
  return path.replace(/^\.\.\/\.\.\/stores\//, "");
}

function mapStringStoreCandidates(): string[] {
  return Object.entries(STORE_MODULES)
    .map(([path, content]) => [storeFileName(path), content] as const)
    .filter(([path]) => !/\.test\.ts$/.test(path))
    .filter(([, content]) => /\bMap<string,\s*/.test(content))
    .map(([path]) => path)
    .sort();
}

function statusInfo(sessionId: string): TerminalStatusInfo {
  return { sessionId, status: "idle", lastOutputAt: 0, updatedAt: 0 };
}

afterEach(() => {
  useContextUsageStore.setState({
    sessionId: null,
    snapshot: null,
    lastReady: null,
    loading: false,
    requestId: 0,
    sessions: new Map(),
  });
  useTerminalStatusStore.setState({ statusMap: new Map() });
  useTerminalInputActivityStore.setState({ entries: {} });
});

describe("sessionScopedResources", () => {
  it("registers every known session-scoped store resource", () => {
    expect(registeredSessionScopedResourceNames()).toEqual(expect.arrayContaining([
      "contextUsage",
      "terminalInputActivity",
      "terminalRestoreLog",
      "terminalStatus",
    ]));
  });

  it("disposes registered per-session state for one session only", () => {
    const cacheEntry = { snapshot: null, lastReady: null, loading: false, requestId: 0 };
    useContextUsageStore.setState({
      sessionId: "s1",
      sessions: new Map([
        ["s1", cacheEntry],
        ["other", cacheEntry],
      ]),
    });
    useTerminalStatusStore.setState({
      statusMap: new Map([
        ["s1", statusInfo("s1")],
        ["other", statusInfo("other")],
      ]),
    });
    useTerminalInputActivityStore.getState().recordInput("s1", "working", 100);
    useTerminalInputActivityStore.getState().recordInput("other", "working", 100);

    disposeSessionScopedResources(asPtySessionId("s1"));

    expect(useContextUsageStore.getState().sessionId).toBeNull();
    expect(useContextUsageStore.getState().sessions.has("s1")).toBe(false);
    expect(useContextUsageStore.getState().sessions.has("other")).toBe(true);
    expect(useTerminalStatusStore.getState().statusMap.has("s1")).toBe(false);
    expect(useTerminalStatusStore.getState().statusMap.has("other")).toBe(true);
    expect(useTerminalInputActivityStore.getState().getEntry("s1")).toBeUndefined();
    expect(useTerminalInputActivityStore.getState().getEntry("other")).toBeDefined();

    useTerminalInputActivityStore.getState().clearSession("other");
  });

  it("keeps every Map<string, store either registered or explicitly exempted", () => {
    const candidates = mapStringStoreCandidates();
    const allowed = [
      ...Object.keys(REGISTERED_SESSION_MAP_STORES),
      ...Object.keys(MAP_STORE_EXEMPTIONS),
    ].sort();

    expect(candidates).toEqual(allowed);
    for (const [file, resourceName] of Object.entries(REGISTERED_SESSION_MAP_STORES)) {
      expect(
        registeredSessionScopedResourceNames(),
        `${file} must self-register ${resourceName}`,
      ).toContain(resourceName);
    }
    for (const [file, reason] of Object.entries(MAP_STORE_EXEMPTIONS)) {
      expect(reason, `${file} exemption needs a reason`).toMatch(/\S/);
    }
  });
});
