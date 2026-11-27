import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab, TerminalPaneNode } from "@/types";

const adoptSession = vi.fn();
const forceAdoptSession = vi.fn();
const setSessionLeaseReadOnly = vi.fn();

vi.mock("@/services", () => ({
  terminalService: {
    adoptSession: (...args: unknown[]) => adoptSession(...args),
    forceAdoptSession: (...args: unknown[]) => forceAdoptSession(...args),
  },
}));

vi.mock("@/stores", () => ({
  usePanesStore: { getState: () => ({ setSessionLeaseReadOnly }) },
}));

import {
  findLeaseReadOnlySessionId,
  isForceAdoptUnsupported,
  reclaimSessionLease,
  requestLeaseReclaim,
  useLeaseReclaimStore,
} from "./leaseReclaim";

function leaf(id: string, sessionId: string | null, leaseReadOnly = false): TerminalPaneNode {
  return { type: "leaf", id, sessionId, leaseReadOnly } as TerminalPaneNode;
}

function terminalTab(root: TerminalPaneNode, activeTerminalPaneId?: string): Tab {
  return {
    id: "tab-1",
    contentType: "terminal",
    terminalRootPane: root,
    activeTerminalPaneId,
  } as Tab;
}

describe("reclaimSessionLease", () => {
  beforeEach(() => {
    adoptSession.mockReset();
    forceAdoptSession.mockReset();
    setSessionLeaseReadOnly.mockReset();
  });

  it("对侧租约已过期时普通认领即成功，不走强制抢占", async () => {
    adoptSession.mockResolvedValue(true);

    await expect(reclaimSessionLease("s1")).resolves.toBe("reclaimed");

    expect(forceAdoptSession).not.toHaveBeenCalled();
    expect(setSessionLeaseReadOnly).toHaveBeenCalledWith("s1", false);
  });

  it("普通认领被拒后强制抢占，成功即恢复可写", async () => {
    adoptSession.mockResolvedValue(false);
    forceAdoptSession.mockResolvedValue(true);

    await expect(reclaimSessionLease("s1")).resolves.toBe("reclaimed");

    expect(forceAdoptSession).toHaveBeenCalledWith("s1");
    expect(setSessionLeaseReadOnly).toHaveBeenCalledWith("s1", false);
  });

  it("普通认领抛错也继续尝试强制抢占", async () => {
    adoptSession.mockRejectedValue(new Error("boom"));
    forceAdoptSession.mockResolvedValue(true);

    await expect(reclaimSessionLease("s1")).resolves.toBe("reclaimed");
  });

  it("强制抢占仍被拒时返回 held-by-other，且不改只读状态", async () => {
    adoptSession.mockResolvedValue(false);
    forceAdoptSession.mockResolvedValue(false);

    await expect(reclaimSessionLease("s1")).resolves.toBe("held-by-other");
    expect(setSessionLeaseReadOnly).not.toHaveBeenCalled();
  });

  it("后端未注册 force 命令时返回 force-unsupported（可见降级）", async () => {
    adoptSession.mockResolvedValue(false);
    forceAdoptSession.mockRejectedValue("command force_adopt_terminal_session not found");

    await expect(reclaimSessionLease("s1")).resolves.toBe("force-unsupported");
    expect(setSessionLeaseReadOnly).not.toHaveBeenCalled();
  });

  it("其它强制抢占错误返回 failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    adoptSession.mockResolvedValue(false);
    forceAdoptSession.mockRejectedValue(new Error("daemon unreachable"));

    await expect(reclaimSessionLease("s1")).resolves.toBe("failed");
    warn.mockRestore();
  });
});

describe("isForceAdoptUnsupported", () => {
  it("只把 force 命令自身的 not found 判为不支持", () => {
    expect(isForceAdoptUnsupported("command force_adopt_terminal_session not found")).toBe(true);
    expect(isForceAdoptUnsupported(new Error("SESSION_NOT_FOUND"))).toBe(false);
    expect(isForceAdoptUnsupported("command adopt_terminal_session not found")).toBe(false);
  });
});

describe("findLeaseReadOnlySessionId", () => {
  it("非终端或无只读格子时返回 null", () => {
    expect(findLeaseReadOnlySessionId({ id: "t", contentType: "editor" } as Tab)).toBeNull();
    expect(findLeaseReadOnlySessionId(terminalTab(leaf("a", "s1")))).toBeNull();
    expect(findLeaseReadOnlySessionId(terminalTab(leaf("a", null, true)))).toBeNull();
  });

  it("优先返回激活格子的只读会话，否则第一个只读格子", () => {
    const root = {
      type: "split",
      id: "root",
      direction: "horizontal",
      children: [leaf("a", "s1", true), leaf("b", "s2", true), leaf("c", "s3")],
      sizes: [33, 33, 34],
    } as unknown as TerminalPaneNode;

    expect(findLeaseReadOnlySessionId(terminalTab(root, "b"))).toBe("s2");
    expect(findLeaseReadOnlySessionId(terminalTab(root, "c"))).toBe("s1");
  });
});

describe("requestLeaseReclaim", () => {
  it("有会话时打开确认，空会话忽略", () => {
    useLeaseReclaimStore.setState({ sessionId: null });
    requestLeaseReclaim(null);
    expect(useLeaseReclaimStore.getState().sessionId).toBeNull();

    requestLeaseReclaim("s9");
    expect(useLeaseReclaimStore.getState().sessionId).toBe("s9");

    useLeaseReclaimStore.getState().close();
    expect(useLeaseReclaimStore.getState().sessionId).toBeNull();
  });
});
