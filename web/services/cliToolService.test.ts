import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listCliTools, probeCliToolDetection } from "./cliToolService";
import {
  mockTauriInvoke,
  mockTauriInvokeError,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";

describe("cliToolService", () => {
  beforeEach(() => {
    resetTauriInvoke();
  });

  describe("listCliTools", () => {
    it("应该调用 list_cli_tools 命令并返回工具列表", async () => {
      const tools = [
        { id: "claude", name: "Claude Code", installed: true },
        { id: "codex", name: "Codex", installed: false },
      ];
      mockTauriInvoke({ list_cli_tools: tools });

      const result = await listCliTools();

      expect(invoke).toHaveBeenCalledWith("list_cli_tools");
      expect(result).toEqual(tools);
    });

    it("应该在空列表时返回空数组", async () => {
      mockTauriInvoke({ list_cli_tools: [] });

      const result = await listCliTools();

      expect(result).toEqual([]);
    });

    it("应该在命令失败时抛出错误", async () => {
      mockTauriInvokeError("list_cli_tools", "detect failed");

      await expect(listCliTools()).rejects.toThrow("detect failed");
    });
  });

  // 取证函数：把「daemon 解析不到」与「真没装」分开，靠的是 app 进程侧这份检测结果。
  describe("probeCliToolDetection", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const tool = (overrides: Record<string, unknown>) => ({
      id: "claude",
      displayName: "Claude Code",
      executable: "claude",
      versionArgs: ["--version"],
      installed: true,
      version: "1.0.0",
      path: "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd",
      ...overrides,
    });

    it("按可执行名命中且已安装：返回实证路径", async () => {
      mockTauriInvoke({ list_cli_tools: [tool({}), tool({ id: "codex", executable: "codex" })] });

      await expect(probeCliToolDetection("claude")).resolves.toEqual({
        installedInApp: true,
        resolvedPath: "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd",
      });
    });

    it("可执行名与 id 不同（cursor-agent）时按可执行名命中", async () => {
      mockTauriInvoke({
        list_cli_tools: [tool({ id: "cursor", executable: "cursor-agent", installed: false, path: null })],
      });

      await expect(probeCliToolDetection("cursor-agent")).resolves.toEqual({
        installedInApp: false,
        resolvedPath: null,
      });
    });

    it("大小写不敏感", async () => {
      mockTauriInvoke({ list_cli_tools: [tool({})] });

      await expect(probeCliToolDetection("Claude")).resolves.toMatchObject({ installedInApp: true });
    });

    it("查无此工具：返回 null（不臆断已安装）", async () => {
      mockTauriInvoke({ list_cli_tools: [tool({})] });

      await expect(probeCliToolDetection("ghost")).resolves.toBeNull();
    });

    it("空名直接返回 null，且不发起检测", async () => {
      await expect(probeCliToolDetection("   ")).resolves.toBeNull();
      expect(invoke).not.toHaveBeenCalled();
    });

    it("检测命令失败：返回 null，文案退回保守说法", async () => {
      mockTauriInvokeError("list_cli_tools", "detect failed");

      await expect(probeCliToolDetection("claude")).resolves.toBeNull();
    });

    it("条目缺字段不抛异常：按 id 仍可命中", async () => {
      mockTauriInvoke({ list_cli_tools: [{ id: "claude", installed: true }] });

      await expect(probeCliToolDetection("claude")).resolves.toEqual({
        installedInApp: true,
        resolvedPath: null,
      });
    });

    // detect_all 是串行的，每个已装工具还要跑一次 --version（单次 5s 超时）。
    // 没有 deadline 的话，失败提示可能要等几十秒才出现。
    it("检测超时：返回 null", async () => {
      vi.useFakeTimers();
      (invoke as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));

      const probe = probeCliToolDetection("claude", 50);
      await vi.advanceTimersByTimeAsync(60);

      await expect(probe).resolves.toBeNull();
    });
  });
});
