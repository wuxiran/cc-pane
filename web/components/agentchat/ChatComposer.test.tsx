// 输入区附件三入口：粘贴（后端 CF_HDROP 文件清单 / 截图落盘兜底）与 Tauri
// 原生拖放。网页层剪贴板/拖放在 WebView2 下拿不到文件，组件依赖后端命令，
// 这里全部按 Tauri 运行时 mock。
import "@/i18n";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { screenshotService } from "@/services/screenshotService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import ChatComposer from "./ChatComposer";

vi.mock("@/services/runtime", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauriRuntime: () => true,
}));
vi.mock("@/services/screenshotService", () => ({
  screenshotService: { saveClipboardImage: vi.fn() },
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
  useAgentChatStore.getState().dropChat(CHAT);
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
    vi.mocked(screenshotService.saveClipboardImage).mockResolvedValue({
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
    expect(screenshotService.saveClipboardImage).toHaveBeenCalled();
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
});
