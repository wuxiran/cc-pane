import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalRowWithWorkspace } from "./workspaceTerminals";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

const rows: TerminalRowWithWorkspace[] = [];
vi.mock("./workspaceTerminals", () => ({
  collectTerminalRows: () => rows,
  collectLayoutResumeIds: () => [],
  collectLayoutAgentChatTabs: () => [],
}));
vi.mock("./useAgentChatRowIndex", () => ({
  useAgentChatRowIndex: () => new Map(),
}));
vi.mock("@/services", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services")>()),
  historyService: { list: vi.fn(async () => []) },
}));
vi.mock("@/components/CliBrandIcon", () => ({
  default: () => <span />,
}));
vi.mock("@/hooks/useFirstPromptIndex", () => ({
  useFirstPromptIndex: () => new Map(),
}));
const focusTab = vi.fn();
vi.mock("@/hooks/useFocusTab", () => ({
  focusTab: (id: string) => focusTab(id),
}));

import TaskBoardView from "./TaskBoardView";
import { useTabAttentionStore } from "@/stores/useTabAttentionStore";
import { useStatusSinceStore } from "@/stores/useStatusSinceStore";
import { useDialogStore, useWorkspacesStore } from "@/stores";

function row(
  tabId: string,
  status: TerminalRowWithWorkspace["status"],
  extra: Partial<TerminalRowWithWorkspace> = {},
): TerminalRowWithWorkspace {
  return {
    tabId,
    kind: "terminal",
    layoutId: "l1",
    title: `title-${tabId}`,
    firstPrompt: null,
    sessionTitle: null,
    titleRenamed: false,
    pinned: false,
    status,
    toolName: null,
    oscProgress: null,
    sessionCount: 1,
    projectName: "",
    engines: [],
    lastActivityAt: null,
    primarySessionId: `s-${tabId}`,
    workspaceId: null,
    projectPath: null,
    ...extra,
  };
}

describe("TaskBoardView", () => {
  beforeEach(() => {
    rows.length = 0;
    focusTab.mockClear();
    useTabAttentionStore.setState({ entries: {} });
    useStatusSinceStore.setState({ since: {} });
    useWorkspacesStore.setState({ workspaces: [] });
  });

  it("无任务时显示空态", () => {
    render(<TaskBoardView active />);
    expect(screen.getByText("sidebar:taskBoard.empty")).toBeInTheDocument();
  });

  it("按三段分组，已结束默认折叠，点击卡片聚焦标签", () => {
    rows.push(
      row("wait", "waitingInput", { firstPrompt: "修复登录", projectName: "cc-pane" }),
      row("run", "thinking"),
      row("old", "idle"),
    );

    render(<TaskBoardView active />);

    expect(screen.getByText("sidebar:taskBoard.needsYou")).toBeInTheDocument();
    expect(screen.getByText("修复登录")).toBeInTheDocument();
    expect(screen.getByText("cc-pane")).toBeInTheDocument();
    expect(screen.getByText("sidebar:taskBoard.kind.waiting")).toBeInTheDocument();
    expect(screen.getByText("title-run")).toBeInTheDocument();
    // 已结束折叠：标题在，卡片不在
    expect(screen.getByText("sidebar:taskBoard.settled")).toBeInTheDocument();
    expect(screen.queryByText("title-old")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /taskBoard\.settled/ }));
    expect(screen.getByText("title-old")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /修复登录/ }));
    expect(focusTab).toHaveBeenCalledWith("wait");
  });

  it("跑完未看的任务进等你处理并标完成", () => {
    rows.push(row("fin", "idle"));
    useTabAttentionStore.setState({ entries: { fin: { reason: "completed", at: Date.now() } } });
    render(<TaskBoardView active />);
    expect(screen.getByText("sidebar:taskBoard.kind.done")).toBeInTheDocument();
    expect(screen.queryByText("sidebar:taskBoard.settled")).toBeNull();
  });

  it("非激活时不渲染", () => {
    rows.push(row("run", "thinking"));
    const { container } = render(<TaskBoardView active={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("「新任务」主按钮打开启动器（空态也在）", () => {
    useDialogStore.setState({ launcherOpen: false, launcherContext: null });
    render(<TaskBoardView active />);
    fireEvent.click(screen.getByRole("button", { name: /taskBoard\.newTask$/ }));
    expect(useDialogStore.getState().launcherOpen).toBe(true);
    expect(screen.getByRole("button", { name: "taskBoard.newTaskChoose" })).toBeInTheDocument();
  });
});
