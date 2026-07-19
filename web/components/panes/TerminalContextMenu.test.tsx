import "@/i18n";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import TerminalContextMenu from "./TerminalContextMenu";

function renderMenu(overrides: Partial<React.ComponentProps<typeof TerminalContextMenu>> = {}) {
  const props = {
    getSelection: vi.fn(() => ""),
    getSessionId: vi.fn((): string | null => "sess-1"),
    onCopySelection: vi.fn(),
    onSelectAll: vi.fn(),
    onPaste: vi.fn(),
    onRefreshTerminal: vi.fn(),
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

describe("TerminalContextMenu", () => {
  it("右键展示全部菜单项，无选中时复制选中内容禁用", async () => {
    renderMenu();
    openMenu();

    const copyItem = await screen.findByRole("menuitem", { name: /复制选中内容|Copy Selection/i });
    expect(copyItem).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitem", { name: /全选|Select All/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /粘贴|^Paste$/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /刷新终端|Refresh Terminal/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /清空缓冲区|Clear Buffer/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /复制整个缓冲区|Copy Entire Buffer/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /导出缓冲区|Export Buffer/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /复制会话 ID|Copy Session ID/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /打开项目目录|Open Project Folder/i })).toBeInTheDocument();
  });

  it("刷新终端与复制会话 ID 触发回调", async () => {
    const user = userEvent.setup();
    const props = renderMenu();

    openMenu();
    await user.click(await screen.findByRole("menuitem", { name: /刷新终端|Refresh Terminal/i }));
    expect(props.onRefreshTerminal).toHaveBeenCalledTimes(1);

    openMenu();
    await user.click(await screen.findByRole("menuitem", { name: /复制会话 ID|Copy Session ID/i }));
    expect(props.onCopySessionId).toHaveBeenCalledTimes(1);
  });

  it("无会话时复制会话 ID 禁用", async () => {
    renderMenu({ getSessionId: vi.fn(() => null) });
    openMenu();

    const item = await screen.findByRole("menuitem", { name: /复制会话 ID|Copy Session ID/i });
    expect(item).toHaveAttribute("aria-disabled", "true");
  });

  it("有选中内容时复制可用并触发回调", async () => {
    const user = userEvent.setup();
    const props = renderMenu({ getSelection: vi.fn(() => "picked text") });
    openMenu();

    const copyItem = await screen.findByRole("menuitem", { name: /复制选中内容|Copy Selection/i });
    expect(copyItem).not.toHaveAttribute("aria-disabled", "true");
    await user.click(copyItem);

    expect(props.onCopySelection).toHaveBeenCalledTimes(1);
  });

  it("缓冲区操作项分别触发对应回调", async () => {
    const user = userEvent.setup();
    const props = renderMenu();

    openMenu();
    await user.click(await screen.findByRole("menuitem", { name: /清空缓冲区|Clear Buffer/i }));
    expect(props.onClearBuffer).toHaveBeenCalledTimes(1);

    openMenu();
    await user.click(await screen.findByRole("menuitem", { name: /复制整个缓冲区|Copy Entire Buffer/i }));
    expect(props.onCopyBuffer).toHaveBeenCalledTimes(1);

    openMenu();
    await user.click(await screen.findByRole("menuitem", { name: /导出缓冲区|Export Buffer/i }));
    expect(props.onExportBuffer).toHaveBeenCalledTimes(1);

    openMenu();
    await user.click(await screen.findByRole("menuitem", { name: /打开项目目录|Open Project Folder/i }));
    expect(props.onOpenProjectDir).toHaveBeenCalledTimes(1);

    openMenu();
    await user.click(await screen.findByRole("menuitem", { name: /粘贴|^Paste$/i }));
    expect(props.onPaste).toHaveBeenCalledTimes(1);

    openMenu();
    await user.click(await screen.findByRole("menuitem", { name: /全选|Select All/i }));
    expect(props.onSelectAll).toHaveBeenCalledTimes(1);
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
