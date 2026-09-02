import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { useMcpStore } from "@/stores";
import type { McpServerConfig } from "@/types";
import ProjectMcpSection from "./ProjectMcpSection";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const loadServersMock = vi.fn(async () => {});
const loadLegacyServersMock = vi.fn(async () => {});
const importLegacyServersMock = vi.fn(async () => ["legacy"]);
const upsertServerMock = vi.fn(async () => {});
const removeServerMock = vi.fn(async () => true);

const PROJECT = "D:/repo/demo";
const PROJECT_TARGET = { projectPath: PROJECT };

function setServers(servers: Record<string, McpServerConfig>) {
  useMcpStore.setState({
    servers,
    legacyServers: {},
    loading: false,
    loadServers: loadServersMock,
    loadLegacyServers: loadLegacyServersMock,
    importLegacyServers: importLegacyServersMock,
    upsertServer: upsertServerMock,
    removeServer: removeServerMock,
  });
}

describe("ProjectMcpSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setServers({});
  });

  it("loads servers for the project on mount", () => {
    render(<ProjectMcpSection projectPath={PROJECT} />);

    expect(loadServersMock).toHaveBeenCalledWith(PROJECT_TARGET);
    expect(loadLegacyServersMock).toHaveBeenCalledWith(PROJECT);
  });

  it("shows an empty state when there are no servers", () => {
    render(<ProjectMcpSection projectPath={PROJECT} />);

    expect(screen.getByText("0")).toBeInTheDocument();
    // 空态图标下的两行提示
    expect(document.querySelector(".text-center")).not.toBeNull();
  });

  it("shows a loading spinner while servers are loading", () => {
    useMcpStore.setState({ loading: true });
    render(<ProjectMcpSection projectPath={PROJECT} />);

    expect(document.querySelector(".animate-spin")).not.toBeNull();
  });

  it("renders each server with command line and env badges", () => {
    setServers({
      context7: {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        env: { API_KEY: "secret" },
      },
    });
    render(<ProjectMcpSection projectPath={PROJECT} />);

    expect(screen.getByText("context7")).toBeInTheDocument();
    expect(screen.getByText(/npx -y @upstash\/context7-mcp/)).toBeInTheDocument();
    // env 只展示 key，不泄露 value
    expect(screen.getByText("API_KEY")).toBeInTheDocument();
    expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
  });

  it("rejects saving when name or command is empty", async () => {
    const user = userEvent.setup();
    render(<ProjectMcpSection projectPath={PROJECT} />);

    // 打开新增表单（标题栏按钮）
    await user.click(screen.getAllByRole("button")[0]);
    // 直接保存（最后一个按钮是保存）
    const buttons = screen.getAllByRole("button");
    await user.click(buttons[buttons.length - 1]);

    expect(toast.error).toHaveBeenCalled();
    expect(upsertServerMock).not.toHaveBeenCalled();
  });

  it("saves a new server with whitespace-split args and parsed env lines", async () => {
    const user = userEvent.setup();
    render(<ProjectMcpSection projectPath={PROJECT} />);

    await user.click(screen.getAllByRole("button")[0]);

    const inputs = screen.getAllByRole("textbox");
    // 顺序：name → command → args → env(textarea)
    await user.type(inputs[0], "  my-server  ");
    await user.type(inputs[1], "npx");
    await user.type(inputs[2], "-y   some-pkg");
    await user.type(inputs[3], "KEY=VALUE{enter}FOO=BAR");

    const buttons = screen.getAllByRole("button");
    await user.click(buttons[buttons.length - 1]);

    await waitFor(() =>
      expect(upsertServerMock).toHaveBeenCalledWith(PROJECT_TARGET, "my-server", "npx", ["-y", "some-pkg"], {
        KEY: "VALUE",
        FOO: "BAR",
      }),
    );
    expect(toast.success).toHaveBeenCalled();
  });

  it("removes the old entry first when a server is renamed", async () => {
    const user = userEvent.setup();
    setServers({
      "old-name": { command: "npx", args: [], env: {} },
    });
    render(<ProjectMcpSection projectPath={PROJECT} />);

    // 点击编辑按钮（列表行里第一个 icon 按钮）
    const rowButtons = screen.getAllByRole("button");
    await user.click(rowButtons[1]);

    const nameInput = screen.getByDisplayValue("old-name");
    await user.clear(nameInput);
    await user.type(nameInput, "new-name");

    const buttons = screen.getAllByRole("button");
    await user.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(removeServerMock).toHaveBeenCalledWith(PROJECT_TARGET, "old-name"));
    expect(upsertServerMock).toHaveBeenCalledWith(PROJECT_TARGET, "new-name", "npx", [], {});
  });

  it("deletes a server via its trash button", async () => {
    const user = userEvent.setup();
    setServers({ doomed: { command: "npx", args: [], env: {} } });
    render(<ProjectMcpSection projectPath={PROJECT} />);

    const buttons = screen.getAllByRole("button");
    // 行内按钮：编辑 → 删除；标题栏还有一个"新增"
    await user.click(buttons[2]);

    await waitFor(() => expect(removeServerMock).toHaveBeenCalledWith(PROJECT_TARGET, "doomed"));
    expect(toast.success).toHaveBeenCalled();
  });

  it("workspace view loads the workspace layer and never touches legacy servers", () => {
    render(<ProjectMcpSection projectPath="" workspaceName="team" />);

    expect(loadServersMock).toHaveBeenCalledWith({ workspaceName: "team" });
    expect(loadLegacyServersMock).not.toHaveBeenCalled();
    expect(screen.getByText(/team/)).toBeInTheDocument();
  });

  it("offers a one-click import when legacy .claude servers are not in the overlay yet", async () => {
    const user = userEvent.setup();
    setServers({ kept: { command: "npx", args: [], env: {} } });
    useMcpStore.setState({
      legacyServers: {
        kept: { command: "npx", args: [], env: {} },
        legacy: { command: "old", args: [], env: {} },
      },
    });
    render(<ProjectMcpSection projectPath={PROJECT} />);

    // 只列出尚未导入的名字
    expect(screen.getByText("legacy")).toBeInTheDocument();
    expect(screen.queryByText("kept, legacy")).not.toBeInTheDocument();

    // 项目不属于任何工作空间 → 导入到项目覆盖层（workspaceName 为 undefined）
    const importButton = screen.getAllByRole("button")[1];
    await user.click(importButton);
    await waitFor(() => expect(importLegacyServersMock).toHaveBeenCalledWith(PROJECT, undefined));
    expect(toast.success).toHaveBeenCalled();
    expect(loadLegacyServersMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces service failures through an error toast", async () => {
    const user = userEvent.setup();
    upsertServerMock.mockRejectedValueOnce(new Error("io error"));
    render(<ProjectMcpSection projectPath={PROJECT} />);

    await user.click(screen.getAllByRole("button")[0]);
    const inputs = screen.getAllByRole("textbox");
    await user.type(inputs[0], "srv");
    await user.type(inputs[1], "cmd");
    const buttons = screen.getAllByRole("button");
    await user.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });
});
