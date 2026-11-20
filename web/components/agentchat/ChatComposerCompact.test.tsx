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
  it("窄版：小圆角卡片 + 13px 输入框，不挂全局 composer 类，截图并进「+」菜单", () => {
    const { container } = renderComposer(true);
    const host = container.querySelector("[data-composer-look]");
    expect(host).toHaveAttribute("data-composer-look", "compact");
    expect(container.querySelector(".agent-chat-composer")).toBeNull();
    expect(container.querySelector(".agent-chat-composer-shell")).toBeNull();
    expect(container.querySelector(".agent-chat-composer-input")).toBeNull();
    const input = screen.getByRole("textbox");
    expect(input.className).toContain("text-[13px]");
    expect(input.closest(".rounded-2xl")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /截图|screenshot/i })).toBeNull();
    expect(screen.getByRole("button", { name: /发送|Send/ }).className).toContain("size-7");
  });

  it("窄版：会话选择器包在可收缩、不换行的容器里", () => {
    renderComposer(true, { toolbar: <button type="button">model-select</button> });
    const wrapper = screen.getByRole("button", { name: "model-select" }).parentElement;
    expect(wrapper?.className).toContain("overflow-hidden");
    expect(wrapper?.className).toContain("min-w-0");
  });

  it("窄版：header 渲染在输入卡上方", () => {
    renderComposer(true, { header: <div data-testid="composer-header">bar</div> });
    const header = screen.getByTestId("composer-header");
    const input = screen.getByRole("textbox");
    expect(header.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("窗格版保持原有类名与尺寸", () => {
    const { container } = renderComposer(false);
    expect(container.querySelector(".agent-chat-composer")).not.toBeNull();
    expect(container.querySelector(".agent-chat-composer-shell")?.className).toContain("rounded-3xl");
    expect(screen.getByRole("textbox").className).toContain("agent-chat-composer-input");
    expect(screen.getByRole("textbox").className).toContain("min-h-[4.25rem]");
    expect(screen.getByRole("button", { name: /截图|screenshot/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /发送|Send/ }).className).toContain("h-8 w-8");
  });
});
