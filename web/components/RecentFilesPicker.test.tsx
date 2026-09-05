import "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RecentFilesPicker from "./RecentFilesPicker";
import { useEditorTabsStore } from "@/stores/useEditorTabsStore";
import { useActivityBarStore } from "@/stores";

function resetStores() {
  useEditorTabsStore.setState({ tabs: [], activeTabId: null, recentFiles: [] });
  // 置于 files 模式，避免 handleOpen 触发 toggleFilesMode 的额外副作用
  useActivityBarStore.setState({ appViewMode: "files", activeView: "files" });
}

describe("RecentFilesPicker", () => {
  beforeEach(() => {
    resetStores();
  });

  it("open=false 时不渲染任何内容", () => {
    const { container } = render(<RecentFilesPicker open={false} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("无最近文件且无标签时显示空态", () => {
    render(<RecentFilesPicker open onClose={vi.fn()} />);
    expect(screen.getByText(/没有最近的文件|No recent files/i)).toBeInTheDocument();
  });

  it("同时渲染已打开分组与最近分组", () => {
    useEditorTabsStore.setState({
      tabs: [
        {
          id: "t1",
          title: "opened.ts",
          filePath: "/tmp/proj/src/opened.ts",
          projectPath: "/tmp/proj",
          dirty: false,
        },
      ],
      activeTabId: "t1",
      recentFiles: [
        {
          filePath: "/tmp/proj/src/history.ts",
          projectPath: "/tmp/proj",
          title: "history.ts",
          openedAt: Date.now(),
        },
      ],
    });

    render(<RecentFilesPicker open onClose={vi.fn()} />);

    // 用精确文本避免 /Open/i 命中 "opened.ts" 等文件名子串（默认 zh-CN）
    expect(screen.getByText("已打开")).toBeInTheDocument();
    expect(screen.getByText("最近")).toBeInTheDocument();
    expect(screen.getByText("opened.ts")).toBeInTheDocument();
    expect(screen.getByText("history.ts")).toBeInTheDocument();
    // 相对路径展示（去掉 projectPath 前缀）
    expect(screen.getByText("src/opened.ts")).toBeInTheDocument();
  });

  it("输入过滤后无匹配项时显示无匹配提示", async () => {
    const user = userEvent.setup();
    useEditorTabsStore.setState({
      tabs: [],
      activeTabId: null,
      recentFiles: [
        {
          filePath: "/tmp/proj/src/alpha.ts",
          projectPath: "/tmp/proj",
          title: "alpha.ts",
          openedAt: Date.now(),
        },
      ],
    });

    render(<RecentFilesPicker open onClose={vi.fn()} />);
    await user.type(screen.getByRole("textbox"), "zzzznotfound");

    expect(screen.getByText(/没有匹配的文件|No matching files/i)).toBeInTheDocument();
  });

  it("点击最近文件项调用 openFile 并触发 onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    useEditorTabsStore.setState({
      tabs: [],
      activeTabId: null,
      recentFiles: [
        {
          filePath: "/tmp/proj/src/pick.ts",
          projectPath: "/tmp/proj",
          title: "pick.ts",
          openedAt: Date.now(),
        },
      ],
    });

    render(<RecentFilesPicker open onClose={onClose} />);
    await user.click(screen.getByText("pick.ts"));

    expect(onClose).toHaveBeenCalledTimes(1);
    // openFile 会为该文件新建标签页
    const tabs = useEditorTabsStore.getState().tabs;
    expect(tabs.some((t) => t.filePath === "/tmp/proj/src/pick.ts")).toBe(true);
  });

  it("按 Escape 触发 onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<RecentFilesPicker open onClose={onClose} />);

    await user.type(screen.getByRole("textbox"), "{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ArrowDown + Enter 打开高亮项", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    useEditorTabsStore.setState({
      tabs: [],
      activeTabId: null,
      recentFiles: [
        {
          filePath: "/tmp/proj/a.ts",
          projectPath: "/tmp/proj",
          title: "a.ts",
          openedAt: Date.now(),
        },
        {
          filePath: "/tmp/proj/b.ts",
          projectPath: "/tmp/proj",
          title: "b.ts",
          openedAt: Date.now(),
        },
      ],
    });

    render(<RecentFilesPicker open onClose={onClose} />);
    const input = screen.getByRole("textbox");
    await user.type(input, "{ArrowDown}{Enter}");

    // selectedIndex 从 0 下移到 1 → 打开 b.ts
    expect(onClose).toHaveBeenCalledTimes(1);
    const tabs = useEditorTabsStore.getState().tabs;
    expect(tabs.some((t) => t.filePath === "/tmp/proj/b.ts")).toBe(true);
  });

  it("暴露 dialog/listbox/option 语义并用 aria-activedescendant 追踪高亮项", async () => {
    const user = userEvent.setup();
    useEditorTabsStore.setState({
      tabs: [],
      activeTabId: null,
      recentFiles: [
        {
          filePath: "/tmp/proj/a.ts",
          projectPath: "/tmp/proj",
          title: "a.ts",
          openedAt: Date.now(),
        },
        {
          filePath: "/tmp/proj/b.ts",
          projectPath: "/tmp/proj",
          title: "b.ts",
          openedAt: Date.now(),
        },
      ],
    });

    render(<RecentFilesPicker open onClose={vi.fn()} />);

    expect(screen.getByRole("dialog")).toHaveAttribute("aria-label");
    const listbox = screen.getByRole("listbox");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);

    const input = screen.getByRole("textbox");
    // 初始高亮第一项
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(input).toHaveAttribute("aria-activedescendant", options[0].id);

    // 方向键移动后 activedescendant 同步到第二项
    await user.type(input, "{ArrowDown}");
    expect(input).toHaveAttribute("aria-activedescendant", options[1].id);
    expect(options[1]).toHaveAttribute("aria-selected", "true");
  });
});
