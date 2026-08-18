import "@/i18n";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CloseGuard } from "@/lib/tabLifecycle/registry";
import { TabCloseConfirmDialog } from "./TabCloseConfirmDialog";

const longTabTitle = "applications_launcher-OpenHarmony-50.3-Release (Codex)";

describe("TabCloseConfirmDialog", () => {
  it("keeps long guarded tab titles inside the dialog width", () => {
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

    render(
      <TabCloseConfirmDialog guards={guards} onCancel={vi.fn()} onConfirm={vi.fn()} />,
    );

    const busyTitle = screen.getByTitle(longTabTitle);
    expect(busyTitle).toHaveClass("min-w-0", "flex-1", "truncate");
    expect(busyTitle.closest("li")).toHaveClass("min-w-0");
    expect(busyTitle.closest("ul")).toHaveClass("min-w-0");

    const dirtyTitle = screen.getByTitle(`${longTabTitle}-unsaved`);
    expect(dirtyTitle).toHaveClass("min-w-0", "truncate");
  });
});
