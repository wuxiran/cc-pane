import i18n from "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createTestWorkspace,
  resetTestDataCounter,
} from "@/test/utils/testData";
import { useWorkspacesStore } from "@/stores";
import { TooltipProvider } from "@/components/ui/tooltip";
import WorkspaceFilterBar from "./WorkspaceFilterBar";

const tt = (key: string) => String(i18n.t(`sidebar:${key}` as never));

function renderFilterBar() {
  return render(
    <TooltipProvider>
      <WorkspaceFilterBar />
    </TooltipProvider>,
  );
}

describe("WorkspaceFilterBar", () => {
  beforeEach(() => {
    resetTestDataCounter();
    useWorkspacesStore.setState({
      workspaces: [
        createTestWorkspace({ name: "api", group: "Backend", color: "green" }),
        createTestWorkspace({ name: "web", group: "Frontend", color: "blue" }),
      ],
      workspaceFilter: { query: "", colors: [], group: null },
    });
  });

  it("输入关键字更新 store", async () => {
    const user = userEvent.setup();
    renderFilterBar();

    await user.type(
      screen.getByPlaceholderText(tt("workspaceSearchPlaceholder")),
      "api",
    );

    expect(useWorkspacesStore.getState().workspaceFilter.query).toBe("api");
  });

  it("颜色 chip 支持多选和取消", async () => {
    const user = userEvent.setup();
    renderFilterBar();

    await user.click(
      screen.getByRole("button", { name: tt("workspaceFilterColorBlue") }),
    );
    await user.click(
      screen.getByRole("button", { name: tt("workspaceFilterColorGreen") }),
    );
    expect(useWorkspacesStore.getState().workspaceFilter.colors).toEqual([
      "blue",
      "green",
    ]);

    await user.click(
      screen.getByRole("button", { name: tt("workspaceFilterColorBlue") }),
    );
    expect(useWorkspacesStore.getState().workspaceFilter.colors).toEqual([
      "green",
    ]);
  });

  it("从分组 Popover 选择单个分组", async () => {
    const user = userEvent.setup();
    renderFilterBar();

    await user.click(
      screen.getByRole("button", { name: tt("workspaceGroupFilter") }),
    );
    await user.click(await screen.findByRole("button", { name: "Backend" }));

    expect(useWorkspacesStore.getState().workspaceFilter.group).toBe("Backend");
  });
});
