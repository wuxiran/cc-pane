import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PopupTabData } from "@/services/popupWindowService";

// 重型子组件用桩替换，聚焦本组件自身逻辑
const setTitleMock = vi.fn(() => Promise.resolve());
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setTitle: setTitleMock }),
}));

vi.mock("@/components/panes/TerminalView", () => ({
  default: (props: { sessionId: string; projectPath: string }) => (
    <div
      data-testid="terminal-view"
      data-session-id={props.sessionId}
      data-project-path={props.projectPath}
    >
      terminal
    </div>
  ),
}));

// 必须在 mock 之后再导入被测组件
import PopupTerminalWindow from "./PopupTerminalWindow";

const tabData: PopupTabData = {
  tabId: "tab-1",
  paneId: "pane-1",
  sessionId: "sess-1",
  projectPath: "/tmp/proj",
  title: "My Terminal",
  workspaceName: "ws",
};

describe("PopupTerminalWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("首次渲染显示 Loading 占位", () => {
    vi.mocked(invoke).mockResolvedValue(JSON.stringify(tabData));
    render(<PopupTerminalWindow />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("获取到 tabData 后渲染 TerminalView 并透传属性、设置窗口标题", async () => {
    vi.mocked(invoke).mockResolvedValue(JSON.stringify(tabData));
    render(<PopupTerminalWindow />);

    const view = await screen.findByTestId("terminal-view");
    expect(view).toHaveAttribute("data-session-id", "sess-1");
    expect(view).toHaveAttribute("data-project-path", "/tmp/proj");
    await waitFor(() => expect(setTitleMock).toHaveBeenCalledWith("My Terminal"));
  });

  it("无 tabData 时显示错误信息", async () => {
    // invoke 始终返回 null，getPopupTabData 重试后放弃并返回 null
    vi.mocked(invoke).mockResolvedValue(null);
    render(<PopupTerminalWindow />);

    expect(
      await screen.findByText("No tab data available", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
  });

  it("IPC 抛错时显示 Failed 错误信息", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("boom"));
    render(<PopupTerminalWindow />);

    expect(await screen.findByText(/Failed to get tab data/)).toBeInTheDocument();
  });
});
