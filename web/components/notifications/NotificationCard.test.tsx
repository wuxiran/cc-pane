import "@/i18n";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useQuickTerminalSessionStore } from "@/stores/useQuickTerminalSessionStore";
import type { NotificationRecord } from "@/stores/useNotificationStore";

// 动作层（notificationActions）已单独充分测试；这里 mock 掉，隔离验证组件的
// 渲染与交互编排：定位文案、按钮条件显示、接管成功才 dismiss。
const locateNotificationSession = vi.fn();
const focusNotificationSession = vi.fn();
const handleAdoptQuickTerminal = vi.fn();
vi.mock("./notificationActions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./notificationActions")>();
  return {
    ...actual,
    locateNotificationSession: (...args: unknown[]) => locateNotificationSession(...args),
    focusNotificationSession: (...args: unknown[]) => focusNotificationSession(...args),
    handleAdoptQuickTerminal: (...args: unknown[]) => handleAdoptQuickTerminal(...args),
  };
});

import NotificationCard from "./NotificationCard";

function makeRecord(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: "n1",
    kind: "turn_end",
    title: "任务完成",
    body: "done",
    timestamp: Date.now(),
    read: false,
    sessionId: "s-1",
    ...overrides,
  };
}

function renderCard(overrides: Partial<NotificationRecord> = {}) {
  const onDismiss = vi.fn();
  const record = makeRecord(overrides);
  render(
    <TooltipProvider>
      <NotificationCard record={record} onDismiss={onDismiss} />
    </TooltipProvider>,
  );
  return { onDismiss, record };
}

beforeEach(() => {
  vi.clearAllMocks();
  useQuickTerminalSessionStore.getState().resetForTest();
  focusNotificationSession.mockResolvedValue(true);
  handleAdoptQuickTerminal.mockResolvedValue(true);
  locateNotificationSession.mockReturnValue(null);
});

describe("NotificationCard 快捷终端定位 (F1.4)", () => {
  it("会话住在快捷终端：显示「快捷终端窗口」+「在主窗口打开」+「聚焦会话」", () => {
    locateNotificationSession.mockReturnValue({ kind: "quickTerminal" });

    renderCard();

    expect(screen.getByText(/快捷终端窗口/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "在主窗口打开" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "聚焦会话" })).toBeInTheDocument();
  });

  it("布局内会话：显示布局/窗格，不出现「在主窗口打开」", () => {
    locateNotificationSession.mockReturnValue({
      kind: "layout",
      layoutName: "Layout A",
      paneIndex: 2,
    });

    renderCard();

    expect(screen.getByText(/Layout A/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "在主窗口打开" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "聚焦会话" })).toBeInTheDocument();
  });

  it("定位不到（无布局、无快捷终端登记）：既不显示定位文案也不显示「在主窗口打开」", () => {
    locateNotificationSession.mockReturnValue(null);

    renderCard();

    expect(screen.queryByText(/快捷终端窗口/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "在主窗口打开" })).not.toBeInTheDocument();
  });

  it("快捷终端登记后到：卡片重算定位，长出「在主窗口打开」（订阅 store 的意义）", () => {
    // 挂载时定位不到。
    locateNotificationSession.mockReturnValue(null);
    renderCard();
    expect(screen.queryByRole("button", { name: "在主窗口打开" })).not.toBeInTheDocument();

    // 快捷终端登记到达：store 变化触发重渲染，回退命中。
    locateNotificationSession.mockReturnValue({ kind: "quickTerminal" });
    act(() => {
      useQuickTerminalSessionStore
        .getState()
        .setSession({ sessionId: "s-1", projectPath: "/repo" });
    });

    expect(screen.getByRole("button", { name: "在主窗口打开" })).toBeInTheDocument();
  });
});

describe("NotificationCard 接管交互 (F1.4)", () => {
  // 接管失败时保留卡片（用户还能重试或改走聚焦）
  it.each([
    { adopted: true, dismissed: true },
    { adopted: false, dismissed: false },
  ])("点「在主窗口打开」：接管结果 $adopted → dismiss=$dismissed", async ({ adopted, dismissed }) => {
    locateNotificationSession.mockReturnValue({ kind: "quickTerminal" });
    handleAdoptQuickTerminal.mockResolvedValue(adopted);
    const { onDismiss } = renderCard();

    fireEvent.click(screen.getByRole("button", { name: "在主窗口打开" }));
    await vi.waitFor(() => expect(handleAdoptQuickTerminal).toHaveBeenCalled());

    if (dismissed) expect(onDismiss).toHaveBeenCalledWith("n1");
    else expect(onDismiss).not.toHaveBeenCalled();
  });

  it("点「聚焦会话」：立即 dismiss（聚焦结果与 dismiss 无关，沿用 F7.3 口径）", () => {
    locateNotificationSession.mockReturnValue({ kind: "quickTerminal" });
    const { onDismiss } = renderCard();

    fireEvent.click(screen.getByRole("button", { name: "聚焦会话" }));

    expect(focusNotificationSession).toHaveBeenCalledWith("s-1");
    expect(onDismiss).toHaveBeenCalledWith("n1");
  });
});
