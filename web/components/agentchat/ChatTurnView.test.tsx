import "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import ChatTurnView from "./ChatTurnView";
import { groupChatItems } from "./chatTurns";

it("copies all reply paragraphs from the shared footer without including activity text", async () => {
  const user = userEvent.setup();
  const clipboard = vi.spyOn(navigator.clipboard, "writeText");
  const [turn] = groupChatItems([
    { type: "thought", id: "thought", at: 1, doneAt: 2, text: "internal activity" },
    { type: "assistant", id: "first", at: 3, text: "First paragraph" },
    { type: "tool_call", id: "tool", at: 4, call: { toolCallId: "tool", title: "Read files", status: "completed" } },
    { type: "assistant", id: "last", at: 5, text: "Second paragraph" },
  ]);
  render(<ChatTurnView turn={turn} engineLabel="Codex" streaming={false} chatId="fixture"
    onOpenLocation={vi.fn()} onPlanToTodo={vi.fn()} />);
  expect(screen.getAllByRole("button", { name: "复制" })).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "复制" }));
  expect(clipboard).toHaveBeenCalledWith("First paragraph\n\nSecond paragraph");
});
