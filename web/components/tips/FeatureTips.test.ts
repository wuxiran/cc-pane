import { beforeEach, describe, expect, it, vi } from "vitest";
import { useShortcutsStore } from "@/stores";
import type { TipsSettings } from "@/types";
import { checkFeatureTipTiming, selectFeatureTip } from "./FeatureTips";
import { FEATURE_TIPS, type FeatureTipDefinition } from "./featureTipRegistry";

const NOW = Date.parse("2026-07-25T12:00:00Z");
const baseSettings: TipsSettings = {
  enabled: true,
  lastShownAt: null,
  seen: [],
  tried: [],
  dismissRun: 0,
  sessionCount: 4,
};

function check(overrides: Partial<Parameters<typeof checkFeatureTipTiming>[0]> = {}) {
  return checkFeatureTipTiming({
    settings: baseSettings,
    now: NOW,
    appStartedAt: NOW - 5 * 60 * 1_000,
    lastUserActivityAt: NOW - 20_000,
    lastTerminalInputAt: null,
    terminalFocused: false,
    shownThisSession: false,
    ...overrides,
  });
}

describe("checkFeatureTipTiming", () => {
  it("覆盖开关、前三会话、会话上限和启动等待", () => {
    expect(check({ settings: { ...baseSettings, enabled: false } })).toBe("disabled");
    expect(check({ settings: { ...baseSettings, sessionCount: 3 } })).toBe("firstSessions");
    expect(check({ shownThisSession: true })).toBe("alreadyShown");
    expect(check({ appStartedAt: NOW - 5 * 60 * 1_000 + 1 })).toBe("startupGrace");
  });

  it("要求自然空闲，并在终端最近输入后等待 30 秒", () => {
    expect(check({ lastUserActivityAt: NOW - 19_999 })).toBe("recentActivity");
    expect(check({
      terminalFocused: true,
      lastTerminalInputAt: NOW - 29_999,
    })).toBe("recentTerminalInput");
    expect(check({
      terminalFocused: true,
      lastTerminalInputAt: NOW - 30_000,
    })).toBeNull();
  });

  it("默认间隔三天，连续忽略两次后延长为六天", () => {
    expect(check({
      settings: { ...baseSettings, lastShownAt: new Date(NOW - 3 * 24 * 60 * 60 * 1_000 + 1).toISOString() },
    })).toBe("frequency");
    expect(check({
      settings: { ...baseSettings, dismissRun: 2, lastShownAt: new Date(NOW - 5 * 24 * 60 * 60 * 1_000).toISOString() },
    })).toBe("frequency");
    expect(check({
      settings: { ...baseSettings, dismissRun: 2, lastShownAt: new Date(NOW - 6 * 24 * 60 * 60 * 1_000).toISOString() },
    })).toBeNull();
  });
});

describe("feature tip registry", () => {
  beforeEach(() => {
    useShortcutsStore.setState({ actions: new Map(), terminalFocused: false });
  });

  it("首批只包含已核实的四个 action，不包含不存在的 worktree 跳转", () => {
    expect(FEATURE_TIPS.map((tip) => tip.actionId)).toEqual([
      "command-palette",
      "toggle-layouts",
      "toggle-mini-mode",
      "new-tab",
    ]);
    expect(FEATURE_TIPS.some((tip) => tip.id.includes("worktree"))).toBe(false);
  });

  it("试试看调用现有快捷键 action handler", () => {
    const handler = vi.fn();
    useShortcutsStore.setState({
      actions: new Map([["command-palette", { id: "command-palette", label: "Command Palette", handler }]]),
    });

    FEATURE_TIPS[0].tryAction?.();

    expect(FEATURE_TIPS[0].eligible?.()).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("选择器排除 seen 和不满足前置条件的条目", () => {
    const tips: FeatureTipDefinition[] = [
      { id: "seen", titleKey: "", bodyKey: "", visual: () => null, weight: 10 },
      { id: "blocked", titleKey: "", bodyKey: "", visual: () => null, eligible: () => false, weight: 10 },
      { id: "ready", titleKey: "", bodyKey: "", visual: () => null, weight: 1 },
    ];

    expect(selectFeatureTip(tips, ["seen"], () => 0)?.id).toBe("ready");
  });
});
