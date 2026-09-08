import { describe, it, expect, beforeEach } from "vitest";
import { linkSkillService } from "./linkSkillService";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";
import type { LinkSnapshot, UpdateOutcome } from "@/types";

const snapshotFixture: LinkSnapshot = {
  masterDir: "C:/Users/u/.agents/skills",
  masterCount: 2,
  agents: [
    { name: "ZCode", folder: ".zcode" },
    { name: "Claude", folder: ".claude" },
  ],
  workspaces: [
    { name: "全局（用户级）", path: "" },
    { name: "proj", path: "K:/AI/proj" },
  ],
  activeWorkspace: "全局（用户级）",
  workspaceName: "全局（用户级）",
  workspaceRoot: "C:/Users/u",
  rows: [
    {
      dir: "tdd",
      skill: "tdd",
      description: "Test-driven development",
      repo: "mattpocock/skills",
      url: "https://github.com/mattpocock/skills",
      inMaster: true,
      statuses: [
        { agent: "ZCode", state: "linked" },
        { agent: "Claude", state: "none" },
      ],
    },
    {
      dir: "my-private",
      skill: "my-private",
      description: null,
      repo: "（本项目）",
      url: null,
      inMaster: false,
      statuses: [
        { agent: "ZCode", state: "none" },
        { agent: "Claude", state: "copied" },
      ],
    },
  ],
};

describe("linkSkillService", () => {
  beforeEach(() => {
    resetTauriInvoke();
  });

  describe("snapshot", () => {
    it("应该调用 link_snapshot 并透传 ws 参数（null 表示活动空间）", async () => {
      let capturedArgs: Record<string, unknown> | undefined;
      mockTauriInvoke({
        link_snapshot: (_cmd: string, args?: Record<string, unknown>) => {
          capturedArgs = args;
          return snapshotFixture;
        },
      });

      const snap = await linkSkillService.snapshot(null);

      expect(capturedArgs).toEqual({ ws: null });
      expect(snap.masterCount).toBe(2);
      expect(snap.rows[0].statuses[0].state).toBe("linked");
      expect(snap.rows[1].statuses[1].state).toBe("copied");
    });

    it("应该把指定工作空间名传给后端", async () => {
      let capturedArgs: Record<string, unknown> | undefined;
      mockTauriInvoke({
        link_snapshot: (_cmd: string, args?: Record<string, unknown>) => {
          capturedArgs = args;
          return snapshotFixture;
        },
      });

      await linkSkillService.snapshot("proj");

      expect(capturedArgs).toEqual({ ws: "proj" });
    });
  });

  describe("enable / disable", () => {
    it("批量启用应该透传 skills/agent/overwrite 并返回计数", async () => {
      mockTauriInvoke({ link_enable: { ok: 2, skip: 0, conflict: 0, nomaster: 0, fail: 0 } });

      const counts = await linkSkillService.enable(["tdd"], "Claude", null, false);

      expect(counts.ok).toBe(2);
    });

    it("重复启用应该返回 skip 计数（幂等）", async () => {
      mockTauriInvoke({ link_enable: { ok: 0, skip: 1, conflict: 0, nomaster: 0, fail: 0 } });

      const counts = await linkSkillService.enable(["tdd"], "Claude", null, false);

      expect(counts.skip).toBe(1);
    });

    it("批量禁用应该透传 agent 并返回 protected 计数", async () => {
      mockTauriInvoke({ link_disable: { ok: 0, skip: 0, protected: 1, fail: 0 } });

      const counts = await linkSkillService.disable(["tdd"], "*", null);

      expect(counts.protected).toBe(1);
    });
  });

  describe("update", () => {
    it("应该调用 link_update 并返回逐技能结果", async () => {
      const outcomes: UpdateOutcome[] = [
        { dir: "tdd", status: "updated", detail: "tdd ← mattpocock/skills@main/skills/engineering/tdd" },
        { dir: "tabbit", status: "no-source", detail: "没有远程来源（手工安装的技能）" },
      ];
      mockTauriInvoke({ link_update: outcomes });

      const result = await linkSkillService.update(["tdd", "tabbit"]);

      expect(result).toHaveLength(2);
      expect(result[0].status).toBe("updated");
      expect(result[1].status).toBe("no-source");
    });
  });

  describe("workspace", () => {
    it("切换工作空间应该调用 link_set_workspace", async () => {
      let called = false;
      mockTauriInvoke({
        link_set_workspace: () => {
          called = true;
          return null;
        },
      });

      await linkSkillService.setWorkspace("proj");

      expect(called).toBe(true);
    });

    it("添加项目工作空间应该返回 name/duplicate", async () => {
      mockTauriInvoke({ link_add_workspace: { name: "proj", duplicate: false } });

      const out = await linkSkillService.addWorkspace("K:/AI/proj");

      expect(out.name).toBe("proj");
      expect(out.duplicate).toBe(false);
    });
  });
});
