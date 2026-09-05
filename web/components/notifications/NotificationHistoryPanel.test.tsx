import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  useNotificationStore,
  type NotificationRecord,
} from "@/stores/useNotificationStore";
import NotificationCard from "./NotificationCard";
import NotificationHistoryPanel from "./NotificationHistoryPanel";

describe("NotificationHistoryPanel a11y", () => {
  afterEach(() => {
    useNotificationStore.setState({
      notifications: [],
      activeToastIds: [],
      historyOpen: false,
    });
  });

  it("面板根带稳定 id，供铃铛 aria-controls 引用", () => {
    useNotificationStore.setState({ notifications: [] });
    render(
      <TooltipProvider>
        <NotificationHistoryPanel />
      </TooltipProvider>,
    );

    expect(screen.getByTestId("notification-history-panel")).toHaveAttribute(
      "id",
      "notification-history-panel",
    );
  });

  it("过滤器按钮带 aria-pressed 并随选中联动", () => {
    useNotificationStore.setState({ notifications: [] });
    render(
      <TooltipProvider>
        <NotificationHistoryPanel />
      </TooltipProvider>,
    );

    const all = screen.getByRole("button", { name: "全部" });
    const errors = screen.getByRole("button", { name: "错误" });
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(errors).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(errors);
    expect(all).toHaveAttribute("aria-pressed", "false");
    expect(errors).toHaveAttribute("aria-pressed", "true");
  });
});

describe("NotificationCard a11y", () => {
  it("展开/收起按钮带 aria-expanded 并随状态联动", () => {
    const record: NotificationRecord = {
      id: "n1",
      kind: "turn_end",
      title: "任务完成",
      // 超过 EXPANDABLE_BODY_LENGTH（56）才渲染展开按钮
      body: "这是一段足够长的通知正文，用来触发展开全文按钮的出现。".repeat(4),
      timestamp: Date.now(),
      read: false,
    };
    render(
      <TooltipProvider>
        <NotificationCard record={record} onDismiss={() => {}} />
      </TooltipProvider>,
    );

    const expandToggle = screen.getByRole("button", { name: "展开全文" });
    expect(expandToggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(expandToggle);
    expect(screen.getByRole("button", { name: "收起" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});
