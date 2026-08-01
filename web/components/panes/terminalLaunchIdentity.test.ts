import { describe, expect, it } from "vitest";

import {
  nextLaunchId,
  resolveCliTool,
  resolveLaunchId,
  resolveRuntimeKind,
} from "./terminalLaunchIdentity";

describe("nextLaunchId", () => {
  it("生成带前缀的 id 且不等于上一个", () => {
    const previous = nextLaunchId();
    const next = nextLaunchId(previous);
    expect(next).toMatch(/^launch-/);
    expect(next).not.toBe(previous);
  });
});

describe("resolveLaunchId", () => {
  it("首次启动复用 leaf 上预留的 id", () => {
    expect(resolveLaunchId({ launchId: "launch-reserved" })).toBe("launch-reserved");
  });

  it("leaf 上没有预留时新生成", () => {
    expect(resolveLaunchId({})).toMatch(/^launch-/);
  });

  // 复用一个已被上次 PTY 占用的 launch id 会让 bind_pty_session 落空，
  // resume id 从此永久丢失且不可自愈（docs/69）。
  it("恢复路径必须换新 id", () => {
    const resolved = resolveLaunchId({ launchId: "launch-prev", restoring: true });
    expect(resolved).not.toBe("launch-prev");
    expect(resolved).toMatch(/^launch-/);
  });

  it("失败重挂载后不复用失败那次的身份", () => {
    expect(resolveLaunchId({ launchId: "launch-failed", launchAttempt: 1 })).not.toBe(
      "launch-failed",
    );
  });

  it("forceNew 无条件换新", () => {
    expect(resolveLaunchId({ launchId: "launch-prev", forceNew: true })).not.toBe(
      "launch-prev",
    );
  });
});

describe("resolveCliTool", () => {
  it("显式 cliTool 优先", () => {
    expect(resolveCliTool("codex", true)).toBe("codex");
  });

  it("缺省时回退到 launchClaude 布尔", () => {
    expect(resolveCliTool(undefined, true)).toBe("claude");
    expect(resolveCliTool(undefined, false)).toBe("none");
  });
});

describe("resolveRuntimeKind", () => {
  it("ssh 优先于 wsl", () => {
    expect(
      resolveRuntimeKind({ host: "h", user: "u" } as never, { distro: "Ubuntu" } as never),
    ).toBe("ssh");
  });

  it("只有 wsl 时是 wsl，都没有是 local", () => {
    expect(resolveRuntimeKind(undefined, { distro: "Ubuntu" } as never)).toBe("wsl");
    expect(resolveRuntimeKind(undefined, undefined)).toBe("local");
  });
});
