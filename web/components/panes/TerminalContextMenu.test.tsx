import "@/i18n";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import TerminalContextMenu from "./TerminalContextMenu";
import { resolveNativeMenuBlock } from "./terminalViewHelpers";
import type {
  TerminalSessionMenu,
  TerminalSessionMenuState,
} from "./terminal/useTerminalSessionMenu";

function renderMenu(overrides: Partial<React.ComponentProps<typeof TerminalContextMenu>> = {}) {
  const props = {
    getSelection: vi.fn(() => ""),
    getSessionId: vi.fn((): string | null => "sess-1"),
    onCopySelection: vi.fn(),
    onSelectAll: vi.fn(),
    onPaste: vi.fn(),
    onRepairDisplay: vi.fn(),
    onFitAllTerminals: vi.fn(),
    onClearBuffer: vi.fn(),
    onCopyBuffer: vi.fn(),
    onExportBuffer: vi.fn(),
    onCopySessionId: vi.fn(),
    onOpenProjectDir: vi.fn(),
    ...overrides,
  };
  render(
    <TerminalContextMenu {...props}>
      <div data-testid="terminal-host" />
    </TerminalContextMenu>
  );
  return props;
}

const openMenu = () => fireEvent.contextMenu(screen.getByTestId("terminal-host"));
const COPY_MENU = /^(复制|Copy)$/i;
const MORE_MENU = /^(更多|More)$/i;

async function openSubmenu(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  openMenu();
  await user.hover(await screen.findByRole("menuitem", { name }));
}

function sessionMenu(state: Partial<TerminalSessionMenuState> = {}): TerminalSessionMenu {
  return {
    tabId: "tab-1",
    leafId: "leaf-1",
    getState: () => ({
      canFork: true,
      hasResumeCommand: true,
      hasWorkingDir: true,
      hasTranscript: true,
      hasDeepLink: true,
      ...state,
    }),
    onCopyResumeCommand: vi.fn(),
    onCopyWorkingDir: vi.fn(),
    onCopySessionInfo: vi.fn(),
    onCopyMarkdown: vi.fn(),
    onCopyTranscriptPath: vi.fn(),
    onCopyDeepLink: vi.fn(),
    onExportTranscript: vi.fn(),
  };
}

describe("TerminalContextMenu", () => {
  // 回归护栏：mac 终端宿主上挂着捕获阶段的原生菜单 blocker（terminalTextareaIntegration），
  // 它对 contextmenu 做任何 preventDefault / stopPropagation，Radix 都不会开菜单。
  it("mac 原生菜单 blocker 挂在宿主上时右键仍能打开菜单", async () => {
    renderMenu();
    const host = screen.getByTestId("terminal-host");
    const blocker = (event: Event) => {
      const { blocked, stopPropagation } = resolveNativeMenuBlock({
        eventType: event.type,
        button: (event as MouseEvent).button,
        ctrlKey: (event as MouseEvent).ctrlKey,
        isMac: true,
      });
      if (!blocked) return;
      event.preventDefault();
      if (stopPropagation) event.stopImmediatePropagation();
    };
    for (const name of ["pointerdown", "mousedown", "mouseup", "auxclick", "contextmenu"]) {
      host.addEventListener(name, blocker, true);
    }

    fireEvent.mouseDown(host, { button: 2 });
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    fireEvent(host, event);

    expect(await screen.findByRole("menuitem", { name: /全选|Select All/i })).toBeInTheDocument();
    // 原生菜单仍被压住——由 Radix 自己 preventDefault。
    expect(event.defaultPrevented).toBe(true);
  });

  it("第一层只有常用项，无选中时复制选中内容禁用", async () => {
    renderMenu();
    openMenu();

    const copyItem = await screen.findByRole("menuitem", { name: /复制选中内容|Copy Selection/i });
    expect(copyItem).toHaveAttribute("aria-disabled", "true");
    const names = screen.getAllByRole("menuitem").map((item) => item.textContent?.trim());
    expect(names).toHaveLength(7);
    for (const name of [
      /全选|Select All/i,
      /粘贴|^Paste$/i,
      /修复显示|Repair Display/i,
      COPY_MENU,
      MORE_MENU,
      /打开项目目录|Open Project Folder/i,
    ]) {
      expect(screen.getByRole("menuitem", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("menuitem", { name: /适应大小|Fit Terminal/i })).not.toBeInTheDocument();
  });

  it("修复显示触发回调", async () => {
    const user = userEvent.setup();
    const props = renderMenu();

    openMenu();
    await user.click(await screen.findByRole("menuitem", { name: /修复显示|Repair Display/i }));
    expect(props.onRepairDisplay).toHaveBeenCalledTimes(1);
  });

  it("更多子菜单里的操作分别触发回调", async () => {
    const user = userEvent.setup();
    const props = renderMenu({ onResetBuffer: vi.fn() });

    for (const [name, handler] of [
      [/全部终端适应大小|Fit All Terminals/i, props.onFitAllTerminals],
      [/重建终端画面|Rebuild Terminal Display/i, props.onResetBuffer],
      [/导出输出到文件|Export Output/i, props.onExportBuffer],
      [/清空输出|Clear Output/i, props.onClearBuffer],
    ] as const) {
      await openSubmenu(user, MORE_MENU);
      fireEvent.click(await screen.findByRole("menuitem", { name }));
      expect(handler).toHaveBeenCalledTimes(1);
    }
  });

  it("无会话时复制会话 ID 禁用", async () => {
    const user = userEvent.setup();
    renderMenu({ getSessionId: vi.fn(() => null) });

    await openSubmenu(user, COPY_MENU);
    expect(await screen.findByRole("menuitem", { name: /会话 ID|Session ID/i })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("有选中内容时复制可用并触发回调", async () => {
    const user = userEvent.setup();
    const props = renderMenu({ getSelection: vi.fn(() => "abc") });

    openMenu();
    await user.click(await screen.findByRole("menuitem", { name: /复制选中内容|Copy Selection/i }));
    expect(props.onCopySelection).toHaveBeenCalledTimes(1);
  });

  it("第一层与复制子菜单的基础操作触发回调", async () => {
    const user = userEvent.setup();
    const props = renderMenu();

    await openSubmenu(user, COPY_MENU);
    fireEvent.click(await screen.findByRole("menuitem", { name: /终端全部输出|All Terminal Output/i }));
    expect(props.onCopyBuffer).toHaveBeenCalledTimes(1);

    await openSubmenu(user, COPY_MENU);
    fireEvent.click(await screen.findByRole("menuitem", { name: /会话 ID|Session ID/i }));
    expect(props.onCopySessionId).toHaveBeenCalledTimes(1);

    openMenu();
    await user.click(await screen.findByRole("menuitem", { name: /打开项目目录|Open Project Fold/i }));
    expect(props.onOpenProjectDir).toHaveBeenCalledTimes(1);

    openMenu();
    await user.click(await screen.findByRole("menuitem", { name: /粘贴|^Paste$/i }));
    expect(props.onPaste).toHaveBeenCalledTimes(1);

    openMenu();
    await user.click(await screen.findByRole("menuitem", { name: /全选|Select All/i }));
    expect(props.onSelectAll).toHaveBeenCalledTimes(1);
  });

  it("未提供 onResetBuffer 时（镜像/只读视图）不渲染重建终端画面", async () => {
    const user = userEvent.setup();
    renderMenu();

    await openSubmenu(user, MORE_MENU);
    await screen.findByRole("menuitem", { name: /清空输出|Clear Output/i });
    expect(
      screen.queryByRole("menuitem", { name: /重建终端画面|Rebuild Terminal Display/i }),
    ).not.toBeInTheDocument();
  });

  it("有会话时显示分叉，并把复制和导出项接到会话操作", async () => {
    const user = userEvent.setup();
    const session = sessionMenu();
    renderMenu({ sessionMenu: session });

    openMenu();
    expect(await screen.findByRole("menuitem", { name: /分叉会话|Fork Session/i })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    for (const [name, handler] of [
      [/恢复命令|Resume Command/i, session.onCopyResumeCommand],
      [/工作目录|Working Directory/i, session.onCopyWorkingDir],
      [/会话信息|Session Info/i, session.onCopySessionInfo],
      [/对话（Markdown）|Conversation \(Markdown\)/i, session.onCopyMarkdown],
      [/记录文件路径|Transcript File Path/i, session.onCopyTranscriptPath],
      [/深度链接|Deep Link/i, session.onCopyDeepLink],
    ] as const) {
      await openSubmenu(user, COPY_MENU);
      fireEvent.click(await screen.findByRole("menuitem", { name }));
      expect(handler).toHaveBeenCalledTimes(1);
    }

    await openSubmenu(user, MORE_MENU);
    fireEvent.click(await screen.findByRole("menuitem", { name: /导出完整记录|Export Full Transcript/i }));
    expect(session.onExportTranscript).toHaveBeenCalledTimes(1);
  });

  it("会话不支持时隐藏对应项，但会话信息 JSON 始终可复制", async () => {
    const user = userEvent.setup();
    renderMenu({
      sessionMenu: sessionMenu({
        canFork: false,
        hasResumeCommand: false,
        hasTranscript: false,
        hasDeepLink: false,
      }),
    });

    openMenu();
    await screen.findByRole("menuitem", { name: /全选|Select All/i });
    expect(screen.queryByRole("menuitem", { name: /分叉会话|Fork Session/i })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    await openSubmenu(user, COPY_MENU);
    expect(await screen.findByRole("menuitem", { name: /会话信息|Session Info/i })).toBeInTheDocument();
    for (const name of [/恢复命令|Resume Command/i, /Markdown/i, /记录文件路径|Transcript File/i, /深度链接|Deep Link/i]) {
      expect(screen.queryByRole("menuitem", { name })).not.toBeInTheDocument();
    }
  });

  it("未提供 onOpenProjectDir 时不渲染打开项目目录", async () => {
    renderMenu({ onOpenProjectDir: undefined });
    openMenu();

    await screen.findByRole("menuitem", { name: /全选|Select All/i });
    expect(
      screen.queryByRole("menuitem", { name: /打开项目目录|Open Project Folder/i })
    ).not.toBeInTheDocument();
  });

  it("enabled=false 时不挂菜单", () => {
    renderMenu({ enabled: false });
    openMenu();

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
