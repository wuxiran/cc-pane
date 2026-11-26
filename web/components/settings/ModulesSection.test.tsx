import "@/i18n";
import i18n from "i18next";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  createDefaultModulePreferences,
  useModulePrefsStore,
} from "@/stores/useModulePrefsStore";
import { MODULE_REGISTRY } from "@/modules/registry";
import ModulesSection from "./ModulesSection";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key as never, {
  ns: "settings",
  ...options,
});

function renderSection() {
  return render(
    <TooltipProvider>
      <ModulesSection />
    </TooltipProvider>,
  );
}

describe("ModulesSection", () => {
  beforeEach(() => {
    useModulePrefsStore.setState({ preferences: createDefaultModulePreferences() });
  });

  it("renders configurable modules with an enabled switch and position menu", () => {
    renderSection();

    const configurableModuleCount = MODULE_REGISTRY.filter((module) => module.configurable !== false).length;
    expect(screen.getAllByTestId(/^module-setting-/)).toHaveLength(configurableModuleCount);
    expect(screen.queryByTestId("module-setting-orchestration")).not.toBeInTheDocument();
    // 每个模块一个启用开关，外加 aiPanel 独有的自动打开 + 允许 AI 请求弹框两个开关
    expect(screen.getAllByRole("switch")).toHaveLength(configurableModuleCount + 2);
    expect(screen.getAllByTestId(/^module-position-trigger-/)).toHaveLength(configurableModuleCount);
  });

  it("updates enabled independently from placement", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("switch", {
      name: t("modules.enabledLabel", { module: "TodoList" }),
    }));

    expect(useModulePrefsStore.getState().preferences.todo).toEqual({
      enabled: false,
      position: "activityBar",
    });
  });

  it("moves a module to hidden while keeping the command fallback enabled", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByTestId("module-position-trigger-todo"));
    await user.click(screen.getByRole("menuitemradio", {
      name: t("modules.positions.hidden"),
    }));

    expect(useModulePrefsStore.getState().preferences.todo).toEqual({
      enabled: true,
      position: "hidden",
    });
  });

  // autoOpen 默认关、allowAiDialog 默认开：两者的出厂默认值都是产品决策
  it.each([
    ["modules.autoOpenLabel", "autoOpen", false],
    ["modules.allowAiDialogLabel", "allowAiDialog", true],
  ] as const)("toggles the AI panel %s switch away from its shipped default", async (label, key, shipped) => {
    const user = userEvent.setup();
    renderSection();

    const toggle = screen.getByRole("switch", { name: t(label) });
    if (shipped) expect(toggle).toBeChecked();
    else expect(toggle).not.toBeChecked();
    await user.click(toggle);

    expect(useModulePrefsStore.getState().preferences.aiPanel[key]).toBe(!shipped);
  });
});
