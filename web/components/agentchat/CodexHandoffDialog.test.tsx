import "@/i18n";
import i18n from "i18next";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { codexDesktopService } from "@/services/codexDesktopService";
import { acquireChatDraft, useAgentChatDraftStore } from "@/stores/useAgentChatDraftStore";
import CodexHandoffDialog from "./CodexHandoffDialog";

vi.mock("@/services/codexDesktopService", () => ({ codexDesktopService: { open: vi.fn() } }));
beforeEach(async () => {
  await i18n.changeLanguage("en"); vi.clearAllMocks();
  useAgentChatDraftStore.setState({ drafts: {} });
});

it("hands off the reviewed draft once and preserves the source conversation", async () => {
  const token = acquireChatDraft("source");
  useAgentChatDraftStore.getState().setText("source", token, "Check the plan\nOnly review.");
  let resolve!: (value: string) => void;
  vi.mocked(codexDesktopService.open).mockReturnValue(new Promise((done) => { resolve = done; }));
  render(<CodexHandoffDialog cwd="/actual/worktree" chatId="source" onClose={vi.fn()} />);
  const button = screen.getByRole("button", { name: "Open Codex draft" });
  fireEvent.click(button); fireEvent.click(button);
  expect(codexDesktopService.open).toHaveBeenCalledOnce();
  expect(codexDesktopService.open).toHaveBeenCalledWith({ cwd: "/actual/worktree", prompt: "Check the plan\nOnly review." });
  await act(async () => { resolve("codex://new?path=fixture"); });
  expect(await screen.findByRole("status")).toHaveTextContent("Click Send in Codex to start execution");
  expect(screen.queryByRole("button", { name: "Open Codex draft" })).not.toBeInTheDocument();
  expect(useAgentChatDraftStore.getState().drafts.source.text).toBe("Check the plan\nOnly review.");
});

it("keeps task text available when the desktop cannot open", async () => {
  vi.mocked(codexDesktopService.open).mockRejectedValue(new Error("Desktop unavailable"));
  render(<CodexHandoffDialog cwd="/repo" onClose={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "My task" } });
  fireEvent.click(screen.getByRole("button", { name: "Open Codex draft" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Desktop unavailable"));
  expect(screen.getByRole("textbox")).toHaveValue("My task");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("does not open an empty or oversized UTF-8 task", () => {
  render(<CodexHandoffDialog cwd="/repo" onClose={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Open Codex draft" })).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "中".repeat(3000) } });
  expect(screen.getByRole("button", { name: "Open Codex draft" })).toBeDisabled();
  expect(codexDesktopService.open).not.toHaveBeenCalled();
});

it("prefills the captured selection as a quote block before any draft text", async () => {
  const token = acquireChatDraft("source");
  useAgentChatDraftStore.getState().setText("source", token, "draft text");
  vi.mocked(codexDesktopService.open).mockResolvedValue("codex://new");
  render(<CodexHandoffDialog cwd="/repo" chatId="source" selection={"line one\nline two"} onClose={vi.fn()} />);
  const textarea = screen.getByRole("textbox");
  expect(textarea).toHaveValue("> line one\n> line two\n\n");
  fireEvent.change(textarea, { target: { value: "> line one\n> line two\n\nFix this." } });
  fireEvent.click(screen.getByRole("button", { name: "Open Codex draft" }));
  await waitFor(() => expect(codexDesktopService.open).toHaveBeenCalledWith({ cwd: "/repo", prompt: "> line one\n> line two\n\nFix this." }));
});

it("truncates an oversized selection and points to a plan file instead of failing", () => {
  render(<CodexHandoffDialog cwd="/repo" selection={"中".repeat(5000)} onClose={vi.fn()} />);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value.endsWith("> …\n\n")).toBe(true);
  expect(screen.getByText(/Save the full content to a plan file/)).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: `${(screen.getByRole("textbox") as HTMLTextAreaElement).value}Go.` } });
  expect(screen.getByRole("button", { name: "Open Codex draft" })).toBeEnabled();
});

it("quotes the last reply ahead of the typed instruction on demand", () => {
  render(<CodexHandoffDialog cwd="/repo" lastReply="Final answer" onClose={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Implement it." } });
  fireEvent.click(screen.getByRole("button", { name: "Quote last reply" }));
  expect(screen.getByRole("textbox")).toHaveValue("> Final answer\n\nImplement it.");
});

it("hides the quote-last-reply shortcut when there is no reply", () => {
  render(<CodexHandoffDialog cwd="/repo" onClose={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Quote last reply" })).not.toBeInTheDocument();
});
