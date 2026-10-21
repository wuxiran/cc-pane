import { describe, it, expect, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { selfChatService } from "./selfChatService";
import { useWorkspacesStore } from "@/stores";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";
import {
  createTestWorkspace,
  resetTestDataCounter,
} from "@/test/utils/testData";

describe("selfChatService", () => {
  beforeEach(() => {
    resetTauriInvoke();
    resetTestDataCounter();
    useWorkspacesStore.setState({ workspaces: [] });
  });

  describe("getAppCwd", () => {
    it("应该调用 get_app_cwd 并返回工作目录", async () => {
      mockTauriInvoke({ get_app_cwd: "D:\\cc-panes" });

      const result = await selfChatService.getAppCwd();

      expect(invoke).toHaveBeenCalledWith("get_app_cwd");
      expect(result).toBe("D:\\cc-panes");
    });
  });

  describe("collectAppContext", () => {
    it("应该包含工作空间概览和待办统计", async () => {
      useWorkspacesStore.setState({
        workspaces: [
          createTestWorkspace({ name: "ws-main", alias: "主工作区" }),
        ],
      });
      mockTauriInvoke({
        query_todos: {
          items: [
            {
              id: "t-1",
              title: "修复终端闪烁",
              priority: "high",
              description: null,
            },
          ],
          total: 1,
        },
      });

      const context = await selfChatService.collectAppContext();

      expect(context).toContain("## 工作空间 (1 个)");
      expect(context).toContain("主工作区");
      expect(context).toContain("## 待办事项 (1 项)");
      expect(context).toContain("[high] 修复终端闪烁");
      expect(context).toContain("## 可用 Skill");
      expect(context).toContain("CC-Panes 的操控助手");
      expect(context).toContain("dispatch_task");
      expect(context).toContain("$CC_PANES_CTL");
      expect(context).not.toContain("launch_task（启动 Claude/Codex 实例");
      expect(context).not.toContain("upsert_mcp_server（项目级 MCP");
    });

    it("应该在待办超过 10 项时追加剩余数量提示", async () => {
      const items = Array.from({ length: 10 }, (_, i) => ({
        id: `t-${i}`,
        title: `任务 ${i}`,
        priority: "medium",
        description: null,
      }));
      mockTauriInvoke({ query_todos: { items, total: 15 } });

      const context = await selfChatService.collectAppContext();

      expect(context).toContain("还有 5 项");
    });

    it("应该在查询待办失败时跳过待办段落", async () => {
      mockTauriInvoke({
        query_todos: () => {
          throw new Error("db error");
        },
      });

      const context = await selfChatService.collectAppContext();

      expect(context).not.toContain("## 待办事项");
      expect(context).toContain("## 可用 Skill");
    });

    it("应该在无工作空间时省略工作空间段落", async () => {
      mockTauriInvoke({ query_todos: { items: [], total: 0 } });

      const context = await selfChatService.collectAppContext();

      expect(context).not.toContain("## 工作空间");
    });
  });

  describe("collectOnboardingContext", () => {
    it("injects valid ctl schema and call examples into every actual launch prompt", async () => {
      mockTauriInvoke({ query_todos: { items: [], total: 0 } });
      const prompts = [
        await selfChatService.collectAppContext(),
        selfChatService.collectOnboardingContext("zh-CN"),
        selfChatService.collectOnboardingContext("en"),
      ];
      for (const prompt of prompts) {
        expect(prompt).toContain('"$CC_PANES_CTL" --json tools --schema <tool>');
        expect(prompt).toContain('"$CC_PANES_CTL" --json call <tool> --json \'<args>\'');
        expect(prompt).not.toContain("--name");
        expect(prompt).not.toContain("tools --json");
        expect(prompt).not.toContain('\\"$CC_PANES_CTL\\"');
      }
    });

    it("应该为中文界面返回中文引导提示", () => {
      const context = selfChatService.collectOnboardingContext("zh-CN");

      expect(context).toContain("新手引导助手");
      expect(context).toContain("scan_directory");
      expect(context).toContain("$CC_PANES_CTL");
      expect(context).not.toContain("使用 ccpanes MCP 工具 scan_directory");
    });

    it("应该为英文界面返回英文引导提示", () => {
      const context = selfChatService.collectOnboardingContext("en");

      expect(context).toContain("onboarding assistant");
      expect(context).toContain("scan_directory");
      expect(context).toContain("$CC_PANES_CTL");
      expect(context).not.toContain("Use the ccpanes MCP tool scan_directory");
    });
  });
});
