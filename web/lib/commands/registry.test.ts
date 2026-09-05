import "@/i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCommandTitle, runCommand, useCommandsStore } from "./registry";
import { useShortcutsStore } from "@/stores/useShortcutsStore";
import type { CommandDescriptor } from "./types";

function makeCommand(partial: Partial<CommandDescriptor> & { id: string }): CommandDescriptor {
  return { group: "system", run: vi.fn(), ...partial };
}

beforeEach(() => {
  useCommandsStore.setState({ commands: new Map() });
  useShortcutsStore.setState({ actions: new Map(), terminalFocused: false });
});

describe("commands registry", () => {
  it("registerCommands 写入注册表并镜像到 shortcuts store", () => {
    const cmd = makeCommand({ id: "split-right", titleKey: "split-right", context: "global" });
    useCommandsStore.getState().registerCommands([cmd]);

    expect(useCommandsStore.getState().commands.get("split-right")).toBe(cmd);
    const mirrored = useShortcutsStore.getState().actions.get("split-right");
    expect(mirrored?.label).toBe("向右分屏");
    expect(mirrored?.context).toBe("global");
  });

  it("镜像 handler 以空 ctx 触发命令（键盘路径回落到激活目标）", () => {
    const run = vi.fn();
    useCommandsStore.getState().registerCommands([makeCommand({ id: "x", run })]);

    useShortcutsStore.getState().actions.get("x")?.handler();
    expect(run).toHaveBeenCalledWith({});
  });

  it("unregisterCommand 两边都删除", () => {
    useCommandsStore.getState().registerCommands([makeCommand({ id: "x" })]);
    useCommandsStore.getState().unregisterCommand("x");

    expect(useCommandsStore.getState().commands.has("x")).toBe(false);
    expect(useShortcutsStore.getState().actions.has("x")).toBe(false);
  });

  it("resolveCommandTitle：titleKey 优先，其次 title，最后 id", () => {
    expect(resolveCommandTitle(makeCommand({ id: "split-right", titleKey: "split-right" }))).toBe("向右分屏");
    expect(resolveCommandTitle(makeCommand({ id: "x", title: "静态标题" }))).toBe("静态标题");
    expect(resolveCommandTitle(makeCommand({ id: "fallback-id" }))).toBe("fallback-id");
  });

  it("runCommand 尊重 when 门禁并透传 ctx", () => {
    const run = vi.fn();
    useCommandsStore.getState().registerCommands([
      makeCommand({ id: "gated", run, when: (ctx) => ctx.paneId === "ok" }),
    ]);

    runCommand("gated", { paneId: "nope" });
    expect(run).not.toHaveBeenCalled();

    runCommand("gated", { paneId: "ok" });
    expect(run).toHaveBeenCalledWith({ paneId: "ok" });
  });

  it("runCommand 对未注册 id 静默跳过", () => {
    expect(() => runCommand("missing")).not.toThrow();
  });
});
