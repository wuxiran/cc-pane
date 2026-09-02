import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAYOUT_SCOPE,
  resolveLayoutScope,
  sshMachineLayoutScope,
  workspaceLayoutScope,
} from "./layoutScope";

describe("workspaceLayoutScope", () => {
  it("创建 workspace 身份并裁剪空白", () => {
    expect(workspaceLayoutScope("  workspace-1  ")).toBe("workspace:workspace-1");
  });

  it("缺失 ID 时使用默认工作空间身份", () => {
    expect(workspaceLayoutScope(undefined)).toBe(DEFAULT_LAYOUT_SCOPE);
    expect(workspaceLayoutScope("  ")).toBe(DEFAULT_LAYOUT_SCOPE);
  });
});

describe("sshMachineLayoutScope", () => {
  it("创建 SSH 机器身份并裁剪空白", () => {
    expect(sshMachineLayoutScope("  machine-1  ")).toBe("ssh-machine:machine-1");
  });

  it("缺失 ID 时使用默认工作空间身份", () => {
    expect(sshMachineLayoutScope(null)).toBe(DEFAULT_LAYOUT_SCOPE);
  });
});

describe("resolveLayoutScope", () => {
  it("优先使用活动 SSH 标签的 machineId", () => {
    expect(resolveLayoutScope({
      workspace: "workspace-1",
      ssh: "machine-context",
      activeTab: { workspaceId: "workspace-2", ssh: { machineId: "machine-tab" } },
    })).toBe("ssh-machine:machine-tab");
  });

  it("活动标签无 SSH 身份时使用显式 SSH 上下文", () => {
    expect(resolveLayoutScope({
      workspace: { id: "workspace-1" },
      ssh: { machineId: "machine-1" },
      activeTab: { workspaceId: "workspace-2", ssh: null },
    })).toBe("ssh-machine:machine-1");
  });

  it("无 SSH 上下文时使用活动标签的 workspaceId", () => {
    expect(resolveLayoutScope({
      workspace: "workspace-1",
      activeTab: { workspaceId: "workspace-tab" },
    })).toBe("workspace:workspace-tab");
  });

  it("活动标签无 workspaceId 时使用 workspace 上下文", () => {
    expect(resolveLayoutScope({ workspace: { id: "workspace-1" }, activeTab: {} })).toBe(
      "workspace:workspace-1",
    );
  });

  it("忽略活动标签的空白 workspaceId 并识别直接机器字段", () => {
    expect(resolveLayoutScope({
      workspace: "workspace-1",
      activeTab: { workspaceId: "  ", sshMachineId: " machine-1 " },
    })).toBe("ssh-machine:machine-1");
    expect(resolveLayoutScope({
      workspace: "workspace-1",
      activeTab: { workspaceId: "  " },
    })).toBe("workspace:workspace-1");
  });

  it("缺少全部上下文时返回稳定默认身份", () => {
    expect(resolveLayoutScope()).toBe(DEFAULT_LAYOUT_SCOPE);
    expect(resolveLayoutScope({ workspace: "  ", ssh: "  " })).toBe(DEFAULT_LAYOUT_SCOPE);
  });

  it("不修改输入上下文", () => {
    const context = {
      workspace: { id: " workspace-1 " },
      activeTab: { workspaceId: " workspace-2 ", ssh: { machineId: " machine-1 " } },
    };
    const original = JSON.stringify(context);

    expect(resolveLayoutScope(context)).toBe("ssh-machine:machine-1");
    expect(JSON.stringify(context)).toBe(original);
  });
});
