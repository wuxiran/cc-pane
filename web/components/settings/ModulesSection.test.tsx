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

  it("renders every registry module with an enabled switch and position menu", () => {
    renderSection();

    expect(screen.getAllByTestId(/^module-setting-/)).toHaveLength(5);
    expect(screen.getAllByRole("switch")).toHaveLength(6);
    expect(screen.getAllByTestId(/^module-position-trigger-/)).toHaveLength(5);
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

  it("keeps AI panel auto-open disabled until explicitly enabled", async () => {
    const user = userEvent.setup();
    renderSection();

    const autoOpen = screen.getByRole("switch", { name: t("modules.autoOpenLabel") });
    expect(autoOpen).not.toBeChecked();
    await user.click(autoOpen);

    expect(useModulePrefsStore.getState().preferences.aiPanel.autoOpen).toBe(true);
  });
});
