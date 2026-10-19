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

it("keeps the refined header layout while offering fork review from the origin button and menu", async () => {
  const review = vi.fn();
  const { container } = render(<TooltipProvider><ChatSessionHeader
    engineLabel="codex" workspaceMenu={<button>Workspace</button>}
    generating={false} changesCount={0} showChanges={false} onToggleChanges={vi.fn()}
    toolsExpanded={false} onToggleTools={vi.fn()} canFork onFork={vi.fn()}
    hasForkOrigin onReviewFork={review} canCopySessionId onCopySessionId={vi.fn()}
    canExport={false} onExport={vi.fn()}
  /></TooltipProvider>);
  expect(container.querySelector(".agent-chat-header-identity")).toBeInTheDocument();
  expect(container.querySelector(".agent-chat-header-workspace")).toHaveTextContent("Workspace");
  await userEvent.click(screen.getByRole("button", { name: i18n.t("panes:forkReviewTitle") }));
  expect(review).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: i18n.t("panes:agentChatMore") }));
  await userEvent.click(await screen.findByRole("menuitem", { name: i18n.t("panes:forkReviewTitle") }));
  expect(review).toHaveBeenCalledTimes(2);
});
