import "@/i18n";
import i18n from "i18next";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CloseGuard } from "@/lib/tabLifecycle/registry";
import { TabCloseConfirmDialog } from "./TabCloseConfirmDialog";

// 确认/取消与脏编辑器计数走 Panel.test 的真实关闭路径；这里只验列表内容。
const longTabTitle = "applications_launcher-OpenHarmony-50.3-Release (Codex)";

describe("TabCloseConfirmDialog", () => {
  it("lists each guarded tab with its full title (readable even when truncated) and the agent status", () => {
    const guards: CloseGuard[] = [
      {
        kind: "agent-busy",
        tabId: "busy-tab",
        sessionId: "session-1",
        tabTitle: longTabTitle,
        status: "active",
      },
      {
        kind: "editor-dirty",
        tabId: "dirty-tab",
        tabTitle: `${longTabTitle}-unsaved`,
      },
    ];

    render(<TabCloseConfirmDialog guards={guards} onCancel={vi.fn()} onConfirm={vi.fn()} />);

    const busyRow = screen.getByTitle(longTabTitle).closest("li")!;
    expect(busyRow).toHaveTextContent(longTabTitle);
    expect(within(busyRow).getByText(i18n.t("status.active", { ns: "panes", defaultValue: "active" }))).toBeInTheDocument();
    expect(screen.getByTitle(`${longTabTitle}-unsaved`)).toHaveTextContent(`${longTabTitle}-unsaved`);
  });

  it("stays closed when there is nothing to guard", () => {
    render(<TabCloseConfirmDialog guards={[]} onCancel={vi.fn()} onConfirm={vi.fn()} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
