import "@/i18n";
import i18n from "i18next";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import ChatSessionHeader from "./ChatSessionHeader";

it("offers a real fork from the Agent Chat menu", async () => {
  const fork = vi.fn();
  render(
    <TooltipProvider>
      <ChatSessionHeader
        engineLabel="codex"
        generating={false}
        changesCount={0}
        showChanges={false}
        onToggleChanges={vi.fn()}
        toolsExpanded={false}
        onToggleTools={vi.fn()}
        canFork
        onFork={fork}
        canCopySessionId
        onCopySessionId={vi.fn()}
        canExport={false}
        onExport={vi.fn()}
      />
    </TooltipProvider>,
  );
  await userEvent.click(
    screen.getByRole("button", { name: i18n.t("panes:agentChatMore") }),
  );
  await userEvent.click(
    await screen.findByRole("menuitem", { name: i18n.t("panes:forkChat") }),
  );
  expect(fork).toHaveBeenCalledOnce();
});
