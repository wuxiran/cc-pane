import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { toastErr } from "@/lib/feedback";
import { beforeEach, describe, expect, it, vi } from "vitest";
import JournalPanel from "./JournalPanel";
import type { JournalIndex } from "@/services";

vi.mock("@/lib/feedback", () => ({
  toastOk: vi.fn(),
  toastInfo: vi.fn(),
  toastErr: vi.fn(),
}));

const WORKSPACE = "ws-demo";

function makeIndex(overrides?: Partial<JournalIndex>): JournalIndex {
  return {
    activeFile: "2026-07.md",
    totalSessions: 3,
    lastActive: new Date().toISOString(),
    ...overrides,
  };
}

describe("JournalPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("加载中显示 loading 文案", async () => {
    let resolveContent: (v: string) => void = () => {};
    const pending = new Promise<string>((resolve) => {
      resolveContent = resolve;
    });
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "get_journal_index") return Promise.resolve(makeIndex());
      if (cmd === "get_recent_journal") return pending;
      return Promise.resolve(null);
    });

    render(<JournalPanel open onOpenChange={vi.fn()} workspaceName={WORKSPACE} />);

    expect(await screen.findByText(/加载中|Loading/i)).toBeInTheDocument();
    resolveContent("");
    await waitFor(() =>
      expect(screen.getByText(/暂无会话记录|No sessions/i)).toBeInTheDocument(),
    );
  });

  it("无内容时显示空态", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "get_journal_index") return Promise.resolve(makeIndex());
      if (cmd === "get_recent_journal") return Promise.resolve("");
      return Promise.resolve(null);
    });

    render(<JournalPanel open onOpenChange={vi.fn()} workspaceName={WORKSPACE} />);

    expect(await screen.findByText(/暂无会话记录|No sessions/i)).toBeInTheDocument();
  });

  it("渲染日志内容与索引统计", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "get_journal_index") return Promise.resolve(makeIndex({ totalSessions: 5, activeFile: "log-a.md" }));
      if (cmd === "get_recent_journal") return Promise.resolve("## 会话内容正文");
      return Promise.resolve(null);
    });

    render(<JournalPanel open onOpenChange={vi.fn()} workspaceName={WORKSPACE} />);

    expect(await screen.findByText("## 会话内容正文")).toBeInTheDocument();
    expect(screen.getByText("log-a.md")).toBeInTheDocument();
    expect(screen.getByText(/共 5 个会话|5 sessions/i)).toBeInTheDocument();
  });

  it("标题为空时保存按钮禁用，输入后启用", async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "get_journal_index") return Promise.resolve(makeIndex());
      if (cmd === "get_recent_journal") return Promise.resolve("");
      return Promise.resolve(null);
    });

    render(<JournalPanel open onOpenChange={vi.fn()} workspaceName={WORKSPACE} />);
    await screen.findByText(/暂无会话记录|No sessions/i);

    const saveButton = screen.getByRole("button", { name: /保存会话|Save Session/i });
    expect(saveButton).toBeDisabled();

    await user.type(screen.getByPlaceholderText(/实现用户认证功能|user authentication/i), "新会话");
    expect(saveButton).toBeEnabled();
  });

  it("点击保存调用 add_journal_session 并携带解析后的 commit 列表", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "get_journal_index") return Promise.resolve(makeIndex());
      if (cmd === "get_recent_journal") return Promise.resolve("");
      if (cmd === "add_journal_session") return Promise.resolve(1);
      return Promise.resolve(null);
    });

    render(
      <JournalPanel open onOpenChange={vi.fn()} workspaceName={WORKSPACE} onSaved={onSaved} />,
    );
    await screen.findByText(/暂无会话记录|No sessions/i);

    const titleInput = screen.getByPlaceholderText(/实现用户认证功能|user authentication/i);
    await user.type(titleInput, "认证功能");
    await user.type(screen.getByPlaceholderText(/多个用逗号分隔|separated by/i), "aaa, bbb");
    await user.click(screen.getByRole("button", { name: /保存会话|Save Session/i }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("add_journal_session", {
        workspaceName: WORKSPACE,
        title: "认证功能",
        summary: "",
        commits: ["aaa", "bbb"],
      });
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    // 保存成功后标题输入被清空
    await waitFor(() => expect(titleInput).toHaveValue(""));
  });

  it("保存失败时弹出错误 toast", async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "get_journal_index") return Promise.resolve(makeIndex());
      if (cmd === "get_recent_journal") return Promise.resolve("");
      if (cmd === "add_journal_session") return Promise.reject(new Error("save boom"));
      return Promise.resolve(null);
    });

    render(<JournalPanel open onOpenChange={vi.fn()} workspaceName={WORKSPACE} />);
    await screen.findByText(/暂无会话记录|No sessions/i);

    await user.type(screen.getByPlaceholderText(/实现用户认证功能|user authentication/i), "失败会话");
    await user.click(screen.getByRole("button", { name: /保存会话|Save Session/i }));

    await waitFor(() => expect(toastErr).toHaveBeenCalled());
  });
});
