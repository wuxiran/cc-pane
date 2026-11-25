import "@/i18n";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SettingsSidebar from "./SettingsSidebar";
import { getVisibleSettingsPages, getVisibleSettingsPanes } from "./settingsRegistry";

const pages = getVisibleSettingsPages(getVisibleSettingsPanes({ isMac: true, isTauri: true }));

describe("SettingsSidebar titlebar inset", () => {
  it("renders a drag strip above search for the macOS overlay window", () => {
    render(
      <SettingsSidebar
        pages={pages}
        activePageId={pages[0].id}
        onSelect={vi.fn()}
        titlebarInset
        searchSlot={<input aria-label="search" />}
      />,
    );
    const inset = screen.getByTestId("settings-titlebar-inset");
    expect(inset).toHaveAttribute("data-tauri-drag-region");
    // 拖拽带必须排在搜索框之前，红绿灯才不会压住输入框
    expect(inset.compareDocumentPosition(screen.getByLabelText("search")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("omits the strip by default (dialog / non-mac)", () => {
    render(<SettingsSidebar pages={pages} activePageId={pages[0].id} onSelect={vi.fn()} />);
    expect(screen.queryByTestId("settings-titlebar-inset")).toBeNull();
  });
});
