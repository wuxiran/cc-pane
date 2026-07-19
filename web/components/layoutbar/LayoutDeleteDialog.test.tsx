import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import LayoutDeleteDialog, { type DeleteSummary } from "./LayoutDeleteDialog";
import { usePanesStore } from "@/stores";
import { createPanel } from "@/stores/paneTreeHelpers";

const callOrder: string[] = [];

const detachOutput = vi.fn((id: string) => callOrder.push(`detachOutput:${id}`));
const detachExit = vi.fn((id: string) => callOrder.push(`detachExit:${id}`));
const killSession = vi.fn(async (id: string) => {
  callOrder.push(`killSession:${id}`);
});
const getPoppedTabs = vi.fn(() => new Map<string, string>([["tab-1", "popup-tab-1"]]));
const markTabReclaimed = vi.fn((id: string) => callOrder.push(`markReclaimed:${id}`));

vi.mock("@/services", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services")>();
  return {
    ...actual,
    terminalService: {
      detachOutput: (id: string) => detachOutput(id),
      detachExit: (id: string) => detachExit(id),
      killSession: (id: string) => killSession(id),
    },
    getPoppedTabs: () => getPoppedTabs(),
    markTabReclaimed: (id: string) => markTabReclaimed(id),
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

const closePopup = vi.fn(async () => callOrder.push("closePopup"));
const getByLabel = vi.fn(async (_label: string) => ({ close: closePopup }));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: {
    getByLabel: (label: string) => getByLabel(label),
  },
}));

const t = ((key: string) => key) as unknown as TFunction<"panes">;

function makeSummary(overrides: Partial<DeleteSummary> = {}): DeleteSummary {
  const rootPane = createPanel();
  return {
    layout: {
      id: "layout-x",
      name: "布局 X",
      kind: "normal",
      rootPane,
      activePaneId: rootPane.id,
    },
    sessionIds: ["s1", "s2"],
    poppedTabIds: ["tab-1"],
    sshCount: 0,
    restoringCount: 0,
    ...overrides,
  };
}

describe("LayoutDeleteDialog side effects", () => {
  beforeEach(() => {
    callOrder.length = 0;
    detachOutput.mockClear();
    detachExit.mockClear();
    killSession.mockClear();
    killSession.mockImplementation(async (id: string) => {
      callOrder.push(`killSession:${id}`);
    });
    getPoppedTabs.mockClear();
    getPoppedTabs.mockImplementation(() => new Map<string, string>([["tab-1", "popup-tab-1"]]));
    markTabReclaimed.mockClear();
    closePopup.mockClear();
    closePopup.mockImplementation(async () => callOrder.push("closePopup"));
    getByLabel.mockClear();
    getByLabel.mockImplementation(async () => ({ close: closePopup }));
    // isTauriRuntime() 依据该内部标记判断，置真以走弹窗关闭分支
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    usePanesStore.setState({ deleteLayout: vi.fn(() => callOrder.push("deleteLayout")) });
  });

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("确认删除后按 detach→kill→关弹窗→删布局 的顺序执行副作用", async () => {
    const user = userEvent.setup();
    render(<LayoutDeleteDialog summary={makeSummary()} onClose={() => {}} t={t} />);

    await user.click(screen.getByText("confirmDeleteLayout"));

    await waitFor(() => expect(callOrder).toContain("deleteLayout"));

    // 每个会话先 detachOutput 再 detachExit
    expect(callOrder.indexOf("detachOutput:s1")).toBeLessThan(callOrder.indexOf("detachExit:s1"));
    expect(callOrder.indexOf("detachOutput:s2")).toBeLessThan(callOrder.indexOf("detachExit:s2"));
    // 全部 detach 完成后再 kill
    expect(callOrder.indexOf("detachExit:s2")).toBeLessThan(callOrder.indexOf("killSession:s1"));
    // kill 之后关闭弹窗
    expect(Math.max(callOrder.indexOf("killSession:s1"), callOrder.indexOf("killSession:s2")))
      .toBeLessThan(callOrder.indexOf("closePopup"));
    // 关闭弹窗之后才删布局
    expect(callOrder.indexOf("closePopup")).toBeLessThan(callOrder.indexOf("deleteLayout"));
  });

  it("部分 killSession 失败时流程不中断，其余清理仍执行", async () => {
    killSession.mockImplementation(async (id: string) => {
      callOrder.push(`killSession:${id}`);
      if (id === "s1") throw new Error("kill failed");
    });
    const user = userEvent.setup();
    render(<LayoutDeleteDialog summary={makeSummary()} onClose={() => {}} t={t} />);

    await user.click(screen.getByText("confirmDeleteLayout"));

    await waitFor(() => expect(callOrder).toContain("deleteLayout"));
    expect(callOrder).toContain("killSession:s2");
    expect(callOrder).toContain("closePopup");
    expect(callOrder).toContain("deleteLayout");
  });

  it("弹窗关闭失败时不阻塞布局删除", async () => {
    closePopup.mockImplementation(async () => {
      throw new Error("close failed");
    });
    const user = userEvent.setup();
    render(<LayoutDeleteDialog summary={makeSummary()} onClose={() => {}} t={t} />);

    await user.click(screen.getByText("confirmDeleteLayout"));

    await waitFor(() => expect(callOrder).toContain("deleteLayout"));
    // 关闭失败后未标记回收，但仍完成删除
    expect(markTabReclaimed).not.toHaveBeenCalled();
    expect(callOrder).toContain("deleteLayout");
  });
});
