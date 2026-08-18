import "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import ModuleAddMenu from "./ModuleAddMenu";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  createDefaultModulePreferences,
  useModulePrefsStore,
} from "@/stores/useModulePrefsStore";

function renderMenu() {
  return render(
    <TooltipProvider>
      <ModuleAddMenu />
    </TooltipProvider>,
  );
}

async function openMenu() {
  const user = userEvent.setup();
  renderMenu();
  await user.click(screen.getByTestId("module-add-trigger"));
  return user;
}

describe("ModuleAddMenu", () => {
  beforeEach(() => {
    useModulePrefsStore.setState({ preferences: createDefaultModulePreferences() });
  });

  it("列出可放到左栏的模块，含此前只能从右坞进入的会话历史", async () => {
    await openMenu();

    expect(await screen.findByTestId("module-add-sessionHistory")).toBeInTheDocument();
    expect(screen.getByTestId("module-add-ssh")).toBeInTheDocument();
    expect(screen.getByTestId("module-add-todo")).toBeInTheDocument();
  });

  it("不列出固定在右坞的编排模块", async () => {
    await openMenu();

    await screen.findByTestId("module-add-todo");
    expect(screen.queryByTestId("module-add-orchestration")).not.toBeInTheDocument();
    // aiPanel 没有 activityBar surface，同样不该出现在左栏候选里
    expect(screen.queryByTestId("module-add-aiPanel")).not.toBeInTheDocument();
  });

  it("勾选把会话历史放上左栏", async () => {
    const user = await openMenu();

    await user.click(await screen.findByTestId("module-add-sessionHistory"));

    expect(useModulePrefsStore.getState().preferences.sessionHistory).toMatchObject({
      enabled: true,
      position: "activityBar",
    });
  });

  it("取消勾选退回右坞而不是隐藏——与右键菜单口径一致", async () => {
    useModulePrefsStore.getState().setPosition("sessionHistory", "activityBar");
    const user = await openMenu();

    await user.click(await screen.findByTestId("module-add-sessionHistory"));

    expect(useModulePrefsStore.getState().preferences.sessionHistory).toMatchObject({
      enabled: true,
      position: "rightDock",
    });
  });

  it("对已隐藏的模块，勾选同时恢复启用状态", async () => {
    useModulePrefsStore.getState().setEnabled("todo", false);
    const user = await openMenu();

    await user.click(await screen.findByTestId("module-add-todo"));

    expect(useModulePrefsStore.getState().preferences.todo).toMatchObject({
      enabled: true,
      position: "activityBar",
    });
  });
});
