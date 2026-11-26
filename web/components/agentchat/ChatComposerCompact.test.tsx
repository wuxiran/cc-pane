// 右侧面板窄版输入框：外观对齐 CompactStartPage，且不挂全局 composer 样式类
// （那组样式带 540px 容器查询，会把窄版顶回大输入框的尺寸）；窗格版保持原样。
import "@/i18n";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import ChatComposer from "./ChatComposer";

vi.mock("@/services/runtime", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauriRuntime: () => true,
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

function renderComposer(compact: boolean, extra: { header?: React.ReactNode; toolbar?: React.ReactNode } = {}) {
  return render(
    <TooltipProvider>
      <ChatComposer
        chatId={compact ? "compact-chat" : "pane-chat"}
        cwd="/repo"
        phase="ready"
        generating={false}
        availableCommands={[]}
        compact={compact}
        {...extra}
      />
    </TooltipProvider>,
  );
}

describe("ChatComposer compact look", () => {
  it("窄版：不挂全局 composer 类，截图并进「+」菜单", () => {
    const { container } = renderComposer(true);
    expect(container.querySelector("[data-composer-look]")).toHaveAttribute("data-composer-look", "compact");
    expect(container.querySelector(".agent-chat-composer")).toBeNull();
    expect(container.querySelector(".agent-chat-composer-shell")).toBeNull();
    expect(container.querySelector(".agent-chat-composer-input")).toBeNull();
    expect(screen.queryByRole("button", { name: /截图|screenshot/i })).toBeNull();
  });

  it("窄版：header 渲染在输入卡上方", () => {
    renderComposer(true, { header: <div data-testid="composer-header">bar</div> });
    const header = screen.getByTestId("composer-header");
    const input = screen.getByRole("textbox");
    expect(header.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("窗格版保持全局 composer 类与独立截图按钮", () => {
    const { container } = renderComposer(false);
    expect(container.querySelector(".agent-chat-composer")).not.toBeNull();
    expect(container.querySelector(".agent-chat-composer-shell")).not.toBeNull();
    expect(screen.getByRole("textbox")).toHaveClass("agent-chat-composer-input");
    expect(screen.getByRole("button", { name: /截图|screenshot/i })).toBeInTheDocument();
  });
});
