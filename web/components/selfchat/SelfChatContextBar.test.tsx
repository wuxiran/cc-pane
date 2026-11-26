import "@/i18n";
import i18n from "i18next";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SelfChatSession } from "@/types";
import SelfChatContextBar from "./SelfChatContextBar";

function makeSession(overrides?: Partial<SelfChatSession>): SelfChatSession {
  return {
    id: "sc-1",
    appCwd: "/tmp/app",
    ptySessionId: "pty-1",
    status: "running",
    systemPrompt: null,
    ...overrides,
  };
}

function renderBar(session: SelfChatSession, handlers?: { onRestart?: () => void; onEndSession?: () => void }) {
  return render(
    <SelfChatContextBar
      session={session}
      onRestart={handlers?.onRestart ?? vi.fn()}
      onEndSession={handlers?.onEndSession ?? vi.fn()}
    />
  );
}

describe("SelfChatContextBar", () => {
  it.each([
    ["injected once a system prompt exists, regardless of status", { systemPrompt: "prompt", status: "initializing" }, "selfChat.contextInjected", "selfChat.injecting"],
    ["injecting while initializing without a system prompt", { status: "initializing" }, "selfChat.injecting", "selfChat.notInjected"],
    ["not-injected for a running session without a system prompt", {}, "selfChat.notInjected", "selfChat.contextInjected"],
  ] as const)("badge: %s", (_label, overrides, shownKey, hiddenKey) => {
    renderBar(makeSession(overrides as Partial<SelfChatSession>));

    expect(screen.getByText(i18n.t(shownKey))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t(hiddenKey))).not.toBeInTheDocument();
  });

  it("invokes restart and end-session callbacks from the action buttons", async () => {
    const user = userEvent.setup();
    const onRestart = vi.fn();
    const onEndSession = vi.fn();
    renderBar(makeSession(), { onRestart, onEndSession });

    await user.click(screen.getByRole("button", { name: i18n.t("selfChat.restart") }));
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onEndSession).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: i18n.t("selfChat.endSession") }));
    expect(onEndSession).toHaveBeenCalledTimes(1);
  });
});
