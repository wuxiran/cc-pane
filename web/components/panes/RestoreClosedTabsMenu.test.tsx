import "@/i18n";
import i18n from "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { usePanesStore } from "@/stores";
import type { ClosedTabSnapshot } from "@/stores/panesStoreTypes";
import RestoreClosedTabsMenu from "./RestoreClosedTabsMenu";

function snapshot(overrides: Partial<ClosedTabSnapshot>): ClosedTabSnapshot {
  return { projectId: "p", projectPath: "/work/alpha", title: "alpha", ...overrides };
}

function openMenu() {
  render(
    <ContextMenu>
      <ContextMenuTrigger>zone</ContextMenuTrigger>
      <ContextMenuContent>
        <RestoreClosedTabsMenu paneId="pane-1" />
      </ContextMenuContent>
    </ContextMenu>,
  );
  fireEvent.contextMenu(screen.getByText("zone"));
}

function openSubmenu() {
  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: /Restore Closed Tabs \(3\)/ }));
}

describe("RestoreClosedTabsMenu", () => {
  const reopenClosedTab = vi.fn();
  const oldest = snapshot({ title: "oldest" });
  const middle = snapshot({
    title: "",
    contentType: "browser",
    browserUrl: "https://example.com/docs",
    browserPageTitle: "Docs page",
  });
  const newest = snapshot({
    title: "notes.md",
    contentType: "editor",
    filePath: "/work/alpha/notes.md",
  });

  beforeEach(async () => {
    reopenClosedTab.mockReset();
    await i18n.changeLanguage("en");
    usePanesStore.setState({ closedTabs: [oldest, middle, newest], reopenClosedTab });
  });

  it("disables the entry when nothing can be restored", async () => {
    usePanesStore.setState({ closedTabs: [] });
    openMenu();
    const item = await screen.findByRole("menuitem", { name: /Restore Closed Tabs \(0\)/ });
    expect(item).toHaveAttribute("data-disabled");
  });

  it("lists closed tabs newest first", async () => {
    openSubmenu();
    await screen.findByText("oldest");
    const rows = screen.getAllByRole("menuitem").map((row) => row.textContent ?? "");
    const position = (text: string) => rows.findIndex((row) => row.includes(text));
    expect(position("notes.md")).toBeLessThan(position("Docs page"));
    expect(position("Docs page")).toBeLessThan(position("oldest"));
  });

  it("shows where each tab came from", async () => {
    openSubmenu();
    const row = (await screen.findByText("oldest")).closest("[role='menuitem']");
    expect(row).toHaveTextContent("alpha");
    expect(row).toHaveAttribute("title", "/work/alpha");
    const browserRow = screen.getByText("Docs page").closest("[role='menuitem']");
    expect(browserRow).toHaveAttribute("title", "https://example.com/docs");
  });

  it("restores exactly the clicked tab into this pane", async () => {
    openSubmenu();
    fireEvent.click(await screen.findByText("oldest"));
    expect(reopenClosedTab).toHaveBeenCalledTimes(1);
    expect(reopenClosedTab).toHaveBeenCalledWith("pane-1", oldest);
  });
});
