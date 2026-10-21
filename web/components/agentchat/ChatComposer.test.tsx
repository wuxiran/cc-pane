// 输入区附件三入口：粘贴（后端 CF_HDROP 文件清单 / 截图落盘兜底）与 Tauri
// 原生拖放。网页层剪贴板/拖放在 WebView2 下拿不到文件，组件依赖后端命令，
// 这里全部按 Tauri 运行时 mock。
import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { screenshotService } from "@/services/screenshotService";
import { handleErrorSilent } from "@/utils/errorHandler";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import ChatComposer from "./ChatComposer";

vi.mock("@/services/runtime", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauriRuntime: () => true,
}));
vi.mock("@/services/screenshotService", () => ({
  screenshotService: { saveClipboardImage: vi.fn(), saveImageAttachment: vi.fn(), trigger: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("@/utils/assetUrl", () => ({ toAssetUrl: (path: string) => `asset://local/${encodeURIComponent(path)}` }));

vi.mock("@/utils/errorHandler", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  handleErrorSilent: vi.fn(),
}));

type DropPayload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };
let dropHandler: ((event: { payload: DropPayload }) => void) | null = null;
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: (event: { payload: DropPayload }) => void) => {
      dropHandler = handler;
      return Promise.resolve(() => {});
    },
  }),
}));

const CHAT = "tab-composer-test";

function mockInvoke(clipboardPaths: string[]) {
  vi.mocked(invoke).mockImplementation(((command: string) => {
    if (command === "read_clipboard_file_paths") return Promise.resolve(clipboardPaths);
    return Promise.resolve(null);
  }) as typeof invoke);
}

function renderComposer() {
  return render(
    <TooltipProvider>
      <ChatComposer
        chatId={CHAT}
        cwd="C:\\proj"
        phase="ready"
        generating={false}
        availableCommands={[]}
      />
    </TooltipProvider>,
  );
}

function pasteData(overrides: { text?: string; imageFiles?: File[] } = {}) {
  const files = overrides.imageFiles ?? [];
  return {
    clipboardData: {
      items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
      files,
      getData: (type: string) => (type === "text/plain" ? overrides.text ?? "" : ""),
    },
  };
}

beforeEach(() => {
  dropHandler = null;
  vi.clearAllMocks();
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  useAgentChatStore.getState().dropChat(CHAT);
  useAgentChatStore.getState().setSnapshot(CHAT, { chatId: CHAT, engineId: "claude", phase: "ready" });
  document.elementFromPoint = (() => null) as unknown as typeof document.elementFromPoint;
});

describe("ChatComposer 附件与粘贴", () => {
  it("粘贴资源管理器复制的文件：后端文件清单 → resource_link 附件 chip", async () => {
    mockInvoke(["C:\\repo\\notes.md"]);
    renderComposer();
    await act(async () => {
      fireEvent.paste(screen.getByRole("textbox"), pasteData());
    });
    expect(await screen.findByText("notes.md")).toBeInTheDocument();
  });

  it("粘贴纯文本：剪贴板没有文件时照常插到光标处", async () => {
    mockInvoke([]);
    renderComposer();
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.paste(textarea, pasteData({ text: "hello" }));
    });
    expect(textarea.value).toContain("hello");
  });

  it("引擎不支持内嵌图：粘贴图片落盘转文件引用，不再丢弃", async () => {
    mockInvoke([]);
    vi.mocked(screenshotService.saveImageAttachment).mockResolvedValue({
      filePath: "C:\\shots\\paste-1.png",
      width: 2,
      height: 1,
    });
    renderComposer();
    const file = new File(["img"], "pasted.png", { type: "image/png" });
    await act(async () => {
      fireEvent.paste(screen.getByRole("textbox"), pasteData({ imageFiles: [file] }));
    });
    expect(await screen.findByText("paste-1.png")).toBeInTheDocument();
    expect(screenshotService.saveImageAttachment).toHaveBeenCalledWith("aW1n");
    expect(screenshotService.saveClipboardImage).not.toHaveBeenCalled();
  });

  it("Tauri 原生拖放：drop 落在输入区内时路径转附件", async () => {
    mockInvoke([]);
    renderComposer();
    const textarea = screen.getByRole("textbox");
    document.elementFromPoint = (() =>
      textarea) as unknown as typeof document.elementFromPoint;
    await vi.waitFor(() => expect(dropHandler).not.toBeNull());
    act(() => {
      dropHandler?.({
        payload: { type: "drop", paths: ["C:\\dir\\report.pdf"], position: { x: 4, y: 8 } },
      });
    });
    expect(await screen.findByText("report.pdf")).toBeInTheDocument();
  });

  it("HTML5 image drop persists the dropped bytes instead of reading unrelated clipboard contents", async () => {
    mockInvoke([]);
    vi.mocked(screenshotService.saveImageAttachment).mockResolvedValue({ filePath: "/tmp/dropped.png", width: 2, height: 1 });
    const { container } = renderComposer();
    const file = new File(["drop"], "actual.png", { type: "image/png" });
    fireEvent.drop(container.querySelector(".agent-chat-composer-shell")!, { dataTransfer: { files: [file] } });
    expect(await screen.findByText("dropped.png")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "dropped.png" })).toBeInTheDocument();
    expect(screenshotService.saveImageAttachment).toHaveBeenCalledWith("ZHJvcA==");
    expect(screenshotService.saveClipboardImage).not.toHaveBeenCalled();
  });

  it("rejects oversized image files before allocating a FileReader/base64 payload", () => {
    renderComposer();
    const file = new File(["small"], "large.png", { type: "image/png" });
    Object.defineProperty(file, "size", { value: 10 * 1024 * 1024 + 1 });
    const read = vi.spyOn(FileReader.prototype, "readAsDataURL");
    fireEvent.paste(screen.getByRole("textbox"), pasteData({ imageFiles: [file] }));
    expect(read).not.toHaveBeenCalled();
    expect(screenshotService.saveImageAttachment).not.toHaveBeenCalled();
    expect(useAgentChatStore.getState().chats[CHAT].items).toEqual(expect.arrayContaining([expect.objectContaining({ type: "notice" })]));
    read.mockRestore();
  });

  it("keeps an inline pasted image as an unsent preview and removes it without sending", async () => {
    useAgentChatStore.getState().setSnapshot(CHAT, { chatId: CHAT, engineId: "claude", phase: "ready", agentCapabilities: { promptCapabilities: { image: true } } });
    renderComposer();
    fireEvent.paste(screen.getByRole("textbox"), pasteData({ imageFiles: [new File(["image"], "pasted.png", { type: "image/png" })] }));
    expect(await screen.findByRole("img", { name: "pasted.png" })).toHaveAttribute("src", "data:image/png;base64,aW1hZ2U=");
    expect(screenshotService.saveImageAttachment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "移除附件" }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("prompt_acp_chat", expect.anything());
  });

  it("disables native region capture on Linux", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Linux x86_64" });
    renderComposer();
    const button = screen.getByRole("button", { name: "截图暂仅支持 macOS 和 Windows" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(screenshotService.trigger).not.toHaveBeenCalled();
  });

  it("starts a capture from the composer without submitting a prompt", async () => {
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: "截图并附加到对话" }));
    await waitFor(() => expect(screenshotService.trigger).toHaveBeenCalledOnce());
    expect(invoke).not.toHaveBeenCalledWith("prompt_acp_chat", expect.anything());
  });
});

describe("ChatComposer complete prompt retry", () => {
  it("retries an attachment-only turn instead of an earlier text question", async () => {
    mockInvoke(["C:\\repo\\report#100%.txt"]);
    useAgentChatStore.getState().addUserMessage(CHAT, "older question");
    const view = renderComposer();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    await act(async () => fireEvent.paste(screen.getByRole("textbox"), pasteData()));
    expect(await screen.findByText("report#100%.txt")).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送" })));
    const first = vi.mocked(invoke).mock.calls.find(([command]) => command === "prompt_acp_chat");
    expect(first?.[1]).toEqual({ chatId: CHAT, blocks: [{ type: "resource_link", uri: "file:///C:/repo/report%23100%25.txt", name: "report#100%.txt" }] });
    const items = useAgentChatStore.getState().chats[CHAT].items;
    const user = items[items.length - 1];
    expect(user?.type === "user" && user.text).toBe("");
    expect(user?.type === "user" && user.promptBlocks).toEqual((first?.[1] as { blocks: unknown[] }).blocks);
    act(() => useAgentChatStore.getState().setSnapshot(CHAT, { chatId: CHAT, engineId: "claude", phase: "ready" }));
    view.unmount(); renderComposer();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "重试上一轮" })));
    const calls = vi.mocked(invoke).mock.calls.filter(([command]) => command === "prompt_acp_chat");
    expect(calls).toHaveLength(2);
    expect(calls[1][1]).toEqual(calls[0][1]);
  });

  it("retains original image and resource blocks rather than rebuilding them with the current cwd", async () => {
    mockInvoke([]);
    const blocks = [
      { type: "image", mimeType: "image/png", data: "AA==" },
      { type: "resource_link", uri: "file:///old-project/source%23%3F%25.txt", name: "source#?%.txt" },
      { type: "text", text: "read @source#?%.txt and this screenshot" },
    ];
    useAgentChatStore.getState().addUserMessage(CHAT, "read @source#?%.txt and this screenshot", [
      { name: "screenshot.png", kind: "image", mimeType: "image/png", data: "AA==" },
    ], blocks);
    renderComposer();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "重试上一轮" })));
    expect(invoke).toHaveBeenCalledWith("prompt_acp_chat", { chatId: CHAT, blocks });
    const items = useAgentChatStore.getState().chats[CHAT].items;
    const user = items[items.length - 1];
    expect(user?.type === "user" && user.attachments?.[0].name).toBe("screenshot.png");
    expect(user?.type === "user" && user.promptBlocks).toEqual(blocks);
  });
});


describe("ChatComposer failed IPC recovery", () => {
  it("retains the original prompt and shows a send failure instead of losing the request", async () => {
    const error = new Error("adapter connection lost");
    vi.mocked(invoke).mockImplementation(((command: string) => command === "prompt_acp_chat"
      ? Promise.reject(error) : Promise.resolve(null)) as typeof invoke);
    renderComposer();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "run the requested checks" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送" })));
    const items = useAgentChatStore.getState().chats[CHAT].items;
    expect(items).toEqual([
      expect.objectContaining({ type: "notice", text: "adapter connection lost" }),
    ]);
    expect(useAgentChatStore.getState().chats[CHAT].rejectedPrompt).toMatchObject({ text: "run the requested checks", promptBlocks: [{ type: "text", text: "run the requested checks" }] });
    expect(screen.getByRole("button", { name: "重试上一轮" })).toBeEnabled();
  });

  it("keeps all attachment blocks after a retry fails so a later retry is identical", async () => {
    const blocks = [
      { type: "image", mimeType: "image/png", data: "AA==" },
      { type: "resource_link", uri: "file:///project/design%23draft.pdf", name: "design#draft.pdf" },
    ];
    const attachments = [{ name: "screen.png", kind: "image" as const, mimeType: "image/png", data: "AA==" }];
    useAgentChatStore.getState().addUserMessage(CHAT, "", attachments, blocks);
    vi.mocked(invoke).mockRejectedValueOnce("retry transport unavailable").mockResolvedValue(undefined);
    const view = renderComposer();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "重试上一轮" })));
    expect(useAgentChatStore.getState().chats[CHAT].items).toContainEqual(
      expect.objectContaining({ type: "notice", text: "retry transport unavailable" }),
    );
    const users = useAgentChatStore.getState().chats[CHAT].items.filter((item) => item.type === "user");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ text: "", attachments, promptBlocks: blocks });
    expect(useAgentChatStore.getState().chats[CHAT].rejectedPrompt).toEqual({ text: "", attachments, promptBlocks: blocks });
    act(() => useAgentChatStore.getState().setSnapshot(CHAT, { chatId: CHAT, engineId: "claude", phase: "ready" }));
    view.unmount(); renderComposer();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "重试上一轮" })));
    const calls = vi.mocked(invoke).mock.calls.filter(([command]) => command === "prompt_acp_chat");
    expect(calls.map(([, args]) => args)).toEqual([{ chatId: CHAT, blocks }, { chatId: CHAT, blocks }]);
  });

  it("does not pretend a generating turn stopped when cancel IPC fails", async () => {
    const error = new Error("cancel channel unavailable");
    useAgentChatStore.getState().setSnapshot(CHAT, { chatId: CHAT, engineId: "claude", phase: "generating" });
    useAgentChatStore.getState().appendStreamText(CHAT, "assistant", "still running");
    vi.mocked(invoke).mockImplementation(((command: string) => command === "cancel_acp_chat"
      ? Promise.reject(error) : Promise.resolve(null)) as typeof invoke);
    render(<TooltipProvider><ChatComposer chatId={CHAT} cwd="C:\\proj" phase="generating" generating availableCommands={[]} /></TooltipProvider>);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "停止" })));
    expect(invoke).toHaveBeenCalledWith("cancel_acp_chat", { chatId: CHAT });
    expect(handleErrorSilent).toHaveBeenCalledWith(error, "cancel acp chat turn");
    expect(useAgentChatStore.getState().chats[CHAT].snapshot?.phase).toBe("generating");
    expect(useAgentChatStore.getState().chats[CHAT].items).toHaveLength(1);
    expect(screen.getByRole("button", { name: "停止" })).toBeEnabled();
  });
});

describe("ChatComposer draft attachment lifetime", () => {
  it("keeps text and file attachments across panel remounts", async () => {
    mockInvoke(["C:\\repo\\report.pdf"]);
    const view = renderComposer();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "summarize the report" } });
    await act(async () => fireEvent.paste(screen.getByRole("textbox"), pasteData()));
    expect(await screen.findByText("report.pdf")).toBeInTheDocument();
    view.unmount(); renderComposer();
    expect(screen.getByRole("textbox")).toHaveValue("summarize the report");
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
  });

  it("does not resurrect an attachment after explicit chat close", async () => {
    let resolvePaths!: (paths: string[]) => void;
    vi.mocked(invoke).mockImplementation(((command: string) => command === "read_clipboard_file_paths"
      ? new Promise<string[]>((resolve) => { resolvePaths = resolve; }) : Promise.resolve(null)) as typeof invoke);
    const view = renderComposer();
    await act(async () => fireEvent.paste(screen.getByRole("textbox"), pasteData()));
    view.unmount();
    useAgentChatStore.getState().dropChat(CHAT);
    await act(async () => resolvePaths(["C:\\repo\\late.pdf"]));
    renderComposer();
    expect(screen.queryByText("late.pdf")).toBeNull();
  });
});
