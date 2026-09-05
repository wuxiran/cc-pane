import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  useNotificationStore,
  type NotificationRecord,
} from "@/stores/useNotificationStore";
import NotificationBellButton from "./NotificationBellButton";

function unreadRecord(id: string): NotificationRecord {
  return {
    id,
    kind: "turn_end",
    title: "任务完成",
    timestamp: Date.now(),
    read: false,
  };
}

function renderBell() {
  return render(
    <TooltipProvider>
      <NotificationBellButton />
    </TooltipProvider>,
  );
}

describe("NotificationBellButton a11y", () => {
  afterEach(() => {
    useNotificationStore.setState({
      notifications: [],
      activeToastIds: [],
      historyOpen: false,
    });
  });

  it("无未读时使用 tooltip 文案作可访问名，并暴露折叠态与被控面板", () => {
    useNotificationStore.setState({ notifications: [], historyOpen: false });
    renderBell();

    const bell = screen.getByRole("button", { name: "通知中心" });
    expect(bell).toHaveAttribute("type", "button");
    expect(bell).toHaveAttribute("aria-expanded", "false");
    expect(bell).toHaveAttribute("aria-controls", "notification-history-panel");
  });

  it("未读数并入可访问名，角标 aria-hidden 不重复播报", () => {
    useNotificationStore.setState({
      notifications: [unreadRecord("a"), unreadRecord("b")],
      historyOpen: false,
    });
    renderBell();

    screen.getByRole("button", { name: "通知中心，2 条未读" });
    // 角标数字只作为视觉提示存在；计数已由 aria-label 承载
    expect(screen.getByText("2")).toHaveAttribute("aria-hidden", "true");
  });

  it("aria-expanded 随 historyOpen 联动，点击切换面板", () => {
    useNotificationStore.setState({ notifications: [], historyOpen: false });
    renderBell();

    const bell = screen.getByRole("button", { name: "通知中心" });
    fireEvent.click(bell);

    expect(useNotificationStore.getState().historyOpen).toBe(true);
    expect(bell).toHaveAttribute("aria-expanded", "true");
  });
});
