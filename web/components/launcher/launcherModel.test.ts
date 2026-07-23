import { describe, expect, it } from "vitest";
import type { Workspace } from "@/types";
import { applyScenario, LAUNCHER_SCENARIOS } from "@/constants/launcherScenarios";
import { CLI_TOOL_TABS } from "@/types/provider";
import {
  buildAdapterOptions,
  buildPendingLaunch,
  coerceDefaultCliTool,
  createDefaultDraft,
  defaultWorktreeBranch,
  isDraftLocalEnvironment,
  resolveDraftProjectPath,
  worktreeNameFromBranch,
} from "./launcherModel";

const workspace: Workspace = {
  id: "ws-1",
  name: "demo",
  createdAt: "2026-01-01T00:00:00Z",
  path: "D:/repos/demo",
  projects: [{ id: "proj-1", path: "D:/repos/demo/app" }],
};

describe("buildAdapterOptions", () => {
  it("全部缺省时返回 undefined（后端跟随 profile）", () => {
    expect(buildAdapterOptions(createDefaultDraft())).toBeUndefined();
  });

  it("effort/verbose/maxTurns 收拢为约定键", () => {
    const draft = createDefaultDraft({ effort: "xhigh", verbose: true, maxTurns: 12 });
    expect(buildAdapterOptions(draft)).toEqual({ effort: "xhigh", verbose: true, maxTurns: 12 });
  });

  it("非法 maxTurns（<=0）不进入 adapterOptions", () => {
    const draft = createDefaultDraft({ maxTurns: 0 });
    expect(buildAdapterOptions(draft)).toBeUndefined();
  });
});

describe("buildPendingLaunch", () => {
  it("无项目来源时返回 no_project", () => {
    const result = buildPendingLaunch(createDefaultDraft(), { workspaces: [], machines: [] });
    expect(result.launch).toBeNull();
    expect(result.issue).toEqual({ code: "no_project" });
  });

  it("工作空间项目（local）走 resolveWorkspaceProjectLaunchOptions 并带上 extras", () => {
    const draft = createDefaultDraft({
      source: { kind: "workspace", workspaceId: "ws-1", projectId: "proj-1" },
      cliTool: "claude",
      yolo: true,
      effort: "max",
      skipMcp: true,
      appendSystemPrompt: "  聚焦重构  ",
      initialPrompt: "先跑测试",
      targetLayoutId: "layout-9",
    });
    const result = buildPendingLaunch(draft, { workspaces: [workspace], machines: [] });
    expect(result.issue).toBeNull();
    expect(result.launch).toMatchObject({
      path: "D:/repos/demo/app",
      workspaceName: "demo",
      workspacePath: "D:/repos/demo",
      cliTool: "claude",
      providerSelection: "inherit",
      targetLayoutId: "layout-9",
      skipMcp: true,
      appendSystemPrompt: "聚焦重构",
      initialPrompt: "先跑测试",
      yolo: true,
      adapterOptions: { effort: "max" },
    });
  });

  it("YOLO 未勾选时不带 yolo 字段（跟随 profile）", () => {
    const draft = createDefaultDraft({
      source: { kind: "workspace", workspaceId: "ws-1", projectId: "proj-1" },
    });
    const result = buildPendingLaunch(draft, { workspaces: [workspace], machines: [] });
    expect(result.launch?.yolo).toBeUndefined();
    expect(result.launch?.skipMcp).toBeUndefined();
    expect(result.launch?.adapterOptions).toBeUndefined();
  });

  it("手动目录来源直接拼 PendingLaunch（无工作空间上下文）", () => {
    const draft = createDefaultDraft({
      source: { kind: "manual", path: "D:/scratch/tool" },
      cliTool: "codex",
    });
    const result = buildPendingLaunch(draft, { workspaces: [], machines: [] });
    expect(result.launch).toMatchObject({
      path: "D:/scratch/tool",
      cliTool: "codex",
      providerId: "",
    });
    expect(result.launch?.workspaceName).toBeUndefined();
  });

  it("recent 来源剥掉 resumeId（始终开全新会话）并跟随草稿 CLI", () => {
    const draft = createDefaultDraft({
      source: {
        kind: "recent",
        label: "old",
        options: { path: "D:/repos/old", workspaceName: "demo", resumeId: "abc", cliTool: "claude" },
      },
      cliTool: "codex",
    });
    const result = buildPendingLaunch(draft, { workspaces: [], machines: [] });
    expect(result.launch?.cliTool).toBe("codex");
    expect(result.launch?.workspaceName).toBe("demo");
    // PendingLaunch 本身无 resumeId 字段；此处验证 recent options 的 resumeId 不外漏
    expect("resumeId" in (result.launch ?? {})).toBe(false);
  });

  it("explicit provider 选择透传 providerId", () => {
    const draft = createDefaultDraft({
      source: { kind: "workspace", workspaceId: "ws-1", projectId: "proj-1" },
      providerSelection: "explicit",
      providerId: "prov-7",
    });
    const result = buildPendingLaunch(draft, { workspaces: [workspace], machines: [] });
    expect(result.launch?.providerSelection).toBe("explicit");
    expect(result.launch?.providerId).toBe("prov-7");
  });
});

describe("applyScenario", () => {
  it("编程模板 = 编码规范预设 + verbose；覆写模板管理字段", () => {
    const coding = LAUNCHER_SCENARIOS.find((s) => s.id === "coding")!;
    const patch = applyScenario(coding);
    expect(patch.scenarioId).toBe("coding");
    expect(patch.appendSystemPrompt).toContain("编码规范");
    expect(patch.verbose).toBe(true);
    expect(patch.effort).toBeUndefined();
  });

  it("架构模板 = 规划预设 + effort=high", () => {
    const architect = LAUNCHER_SCENARIOS.find((s) => s.id === "architect")!;
    const patch = applyScenario(architect);
    expect(patch.appendSystemPrompt).toContain("架构规划");
    expect(patch.effort).toBe("high");
    expect(patch.verbose).toBe(false);
  });

  it("默认模板清空模板管理字段", () => {
    const defaults = LAUNCHER_SCENARIOS.find((s) => s.id === "default")!;
    expect(applyScenario(defaults)).toEqual({
      scenarioId: "default",
      appendSystemPrompt: "",
      effort: undefined,
      verbose: false,
    });
  });

  it("模板是一次性 patch：应用后手改 draft 不回弹", () => {
    const coding = LAUNCHER_SCENARIOS.find((s) => s.id === "coding")!;
    const draft = { ...createDefaultDraft(), ...applyScenario(coding) };
    const edited = { ...draft, appendSystemPrompt: "自己写的" };
    // 再次读取模板常量不影响已编辑的草稿
    expect(edited.appendSystemPrompt).toBe("自己写的");
    expect(coding.appendSystemPrompt).toContain("编码规范");
  });
});

describe("worktree helpers", () => {
  it("defaultWorktreeBranch 生成 cc/<yyMMdd-HHmm>", () => {
    expect(defaultWorktreeBranch(new Date(2026, 6, 19, 9, 5))).toBe("cc/260719-0905");
  });

  it("worktreeNameFromBranch 剥掉路径分隔符等非法字符", () => {
    expect(worktreeNameFromBranch("cc/260719-0905")).toBe("cc-260719-0905");
    expect(worktreeNameFromBranch("///")).toBe("cc-worktree");
  });

  it("worktreeNameFromBranch 保留中文分支名", () => {
    expect(worktreeNameFromBranch("功能/中文路径修复")).toBe("功能-中文路径修复");
  });
});

describe("resolveDraftProjectPath / isDraftLocalEnvironment", () => {
  it("workspace 来源解析项目路径；local 环境判定为本地", () => {
    const draft = createDefaultDraft({
      source: { kind: "workspace", workspaceId: "ws-1", projectId: "proj-1" },
    });
    expect(resolveDraftProjectPath(draft, [workspace])).toBe("D:/repos/demo/app");
    expect(isDraftLocalEnvironment(draft, [workspace])).toBe(true);
  });

  it("workspace 来源 wsl 环境判定为非本地", () => {
    const draft = createDefaultDraft({
      source: { kind: "workspace", workspaceId: "ws-1", projectId: "proj-1" },
      environment: "wsl",
    });
    expect(isDraftLocalEnvironment(draft, [workspace])).toBe(false);
  });

  it("recent 来源带 wsl/ssh 时判定为非本地", () => {
    const draft = createDefaultDraft({
      source: {
        kind: "recent",
        label: "old",
        options: { path: "/home/u/repo", wsl: { remotePath: "/home/u/repo", distro: "Ubuntu" } },
      },
    });
    expect(isDraftLocalEnvironment(draft, [])).toBe(false);
    expect(resolveDraftProjectPath(draft, [])).toBe("/home/u/repo");
  });

  it("manual 来源始终本地；无来源均为空", () => {
    const manual = createDefaultDraft({ source: { kind: "manual", path: "D:/scratch" } });
    expect(isDraftLocalEnvironment(manual, [])).toBe(true);
    expect(resolveDraftProjectPath(manual, [])).toBe("D:/scratch");
    const empty = createDefaultDraft();
    expect(resolveDraftProjectPath(empty, [])).toBeUndefined();
    expect(isDraftLocalEnvironment(empty, [])).toBe(false);
  });
});

describe("coerceDefaultCliTool（默认 CLI 工具设置的合法性校验）", () => {
  it("命中 CLI_TOOL_TABS 的值原样返回", () => {
    for (const tab of CLI_TOOL_TABS) {
      expect(coerceDefaultCliTool(tab.id)).toBe(tab.id);
    }
  });

  it("空值 / none / 脏配置一律回落 null（由调用点落回 claude）", () => {
    expect(coerceDefaultCliTool(undefined)).toBeNull();
    expect(coerceDefaultCliTool(null)).toBeNull();
    expect(coerceDefaultCliTool("")).toBeNull();
    expect(coerceDefaultCliTool("none")).toBeNull();
    expect(coerceDefaultCliTool("Claude")).toBeNull();
    expect(coerceDefaultCliTool("totally-bogus")).toBeNull();
  });
});

describe("createDefaultDraft 的 cliTool 优先级", () => {
  // 复刻 LauncherDialog 两处调用点的组装方式：合法设置 → partial，非法 → {}
  const partialFromSetting = (setting?: string | null) => {
    const tool = coerceDefaultCliTool(setting);
    return tool ? { cliTool: tool } : {};
  };

  it("无设置时保持硬编码回落 claude", () => {
    expect(createDefaultDraft(partialFromSetting(undefined)).cliTool).toBe("claude");
  });

  it("设置为 codex 时新建草稿即为 codex", () => {
    expect(createDefaultDraft(partialFromSetting("codex")).cliTool).toBe("codex");
    expect(createDefaultDraft(partialFromSetting("gemini")).cliTool).toBe("gemini");
  });

  it("设置为非法值时回落 claude", () => {
    expect(createDefaultDraft(partialFromSetting("totally-bogus")).cliTool).toBe("claude");
  });

  it("调用方显式传入的 cliTool 不被默认设置覆盖", () => {
    const draft = createDefaultDraft({ ...partialFromSetting("codex"), cliTool: "grok" });
    expect(draft.cliTool).toBe("grok");
  });

  it("传入 cliTool: undefined 不会抹掉回落值", () => {
    expect(createDefaultDraft({ cliTool: undefined as never }).cliTool).toBe("claude");
  });
});
