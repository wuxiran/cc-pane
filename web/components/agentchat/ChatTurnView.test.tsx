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

it("routes both user attachments and agent inline image blocks to the file-tab action", async () => {
  const user = userEvent.setup();
  const open = vi.fn().mockResolvedValue(true);
  const attachment = { name: "input.png", path: "/project/input.png", data: "AA==", mimeType: "image/png" };
  const turns = groupChatItems([
    { type: "user", id: "user-image", at: 1, text: "Review this", attachments: [attachment] },
    { type: "image", id: "reply-image", at: 2, mimeType: "image/png", data: "Ag==" },
  ]);
  render(<>{turns.map((turn) => <ChatTurnView key={turn.id} turn={turn} engineLabel="Codex" streaming={false} chatId="fixture"
    onOpenLocation={vi.fn()} onOpenAttachment={open} onPlanToTodo={vi.fn()} />)}</>);
  await user.click(screen.getByRole("button", { name: "在标签页中打开 input.png" }));
  expect(open).toHaveBeenCalledWith(attachment);
  await user.click(screen.getByRole("button", { name: "在标签页中打开 agent-output" }));
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ data: "Ag==", mimeType: "image/png", kind: "image" }));
});
