import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQuickCommandsStore } from "@/stores";
import type { QuickCommand } from "@/types";
import QuickCommandsSection from "./QuickCommandsSection";

function command(id: string, name: string, scope: "global" | "project") {
  const value: QuickCommand = {
    id,
    name,
    kind: "terminal",
    text: "cargo test",
    appendEnter: true,
    target: "currentPane",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
  };
  return { ...value, scope } as const;
}

const load = vi.fn(async () => undefined);
const create = vi.fn(async () => command("created", "Build", "global"));
const update = vi.fn(async () => command("global-1", "Build all", "global"));
const remove = vi.fn(async () => undefined);

describe("QuickCommandsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    useQuickCommandsStore.setState({
      globalCommands: [],
      projectCommands: [],
      commands: [],
      activeProjectPath: "/repo/quick",
      loading: false,
      load,
      create,
      update,
      remove,
    });
  });

  it("uses the standard outlined add-action button", () => {
    render(<QuickCommandsSection />);

    expect(screen.getByTestId("quick-command-add")).toHaveAttribute("data-variant", "outline");
    expect(screen.getByTestId("quick-command-add")).toHaveAttribute("data-size", "sm");
  });

  it("creates, edits, and deletes quick commands", async () => {
    const user = userEvent.setup();
    const existing = command("global-1", "Build", "global");
    useQuickCommandsStore.setState({ commands: [existing] });
    render(<QuickCommandsSection />);

    await user.click(screen.getByRole("button", { name: /新增快捷命令|Add Quick Command/i }));
    await user.type(screen.getByLabelText(/名称|Name/i), "Deploy");
    await user.type(screen.getByLabelText(/内容|Content/i), "npm run deploy");
    await user.click(screen.getByRole("button", { name: /保存|Save/i }));

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: "Deploy",
      text: "npm run deploy",
      kind: "terminal",
      appendEnter: true,
      target: "currentPane",
    }), "global");

    await user.click(screen.getByRole("button", { name: /编辑 Build|Edit Build/i }));
    const nameInput = screen.getByLabelText(/名称|Name/i);
    await user.clear(nameInput);
    await user.type(nameInput, "Build all");
    await user.click(screen.getByRole("button", { name: /保存|Save/i }));

    expect(update).toHaveBeenCalledWith(
      "global-1",
      expect.objectContaining({ name: "Build all" }),
      "global",
    );

    await user.click(screen.getByRole("button", { name: /删除 Build|Delete Build/i }));

    expect(window.confirm).toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("global-1", "global");
  });

  it("disables project scope when there is no active project", async () => {
    const user = userEvent.setup();
    useQuickCommandsStore.setState({ activeProjectPath: null });
    render(<QuickCommandsSection />);

    await user.click(screen.getByRole("button", { name: /新增快捷命令|Add Quick Command/i }));
    await user.click(screen.getByRole("combobox", { name: /范围|Scope/i }));

    const projectOption = await screen.findByRole("option", { name: /项目|Project/i });
    expect(projectOption).toHaveAttribute("aria-disabled", "true");
    await waitFor(() => expect(load).toHaveBeenCalledWith(undefined));
  });
});
