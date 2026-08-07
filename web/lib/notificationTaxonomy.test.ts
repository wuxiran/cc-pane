import { describe, it, expect } from "vitest";
import { autoDismissMs, classifyNotification } from "./notificationTaxonomy";

describe("classifyNotification", () => {
  it("内置 kind 精确映射 severity", () => {
    expect(classifyNotification({ kind: "error" }).severity).toBe("error");
    expect(classifyNotification({ kind: "session_exited" }).severity).toBe("warning");
    expect(classifyNotification({ kind: "waiting_input" }).severity).toBe("warning");
    expect(classifyNotification({ kind: "turn_end" }).severity).toBe("success");
    expect(classifyNotification({ kind: "task_completed" }).severity).toBe("success");
    expect(classifyNotification({ kind: "slow_tool" }).severity).toBe("info");
  });

  it("任意 MCP kind 走子串回退，默认 info", () => {
    expect(classifyNotification({ kind: "build_failed" }).severity).toBe("error");
    expect(classifyNotification({ kind: "deploy_done" }).severity).toBe("success");
    expect(classifyNotification({ kind: "disk_warning" }).severity).toBe("warning");
    expect(classifyNotification({ kind: "custom" }).severity).toBe("info");
  });

  it("waiting_input 与 requiresInput 归为 askInput，其余 notice", () => {
    expect(classifyNotification({ kind: "waiting_input" }).interruptClass).toBe("askInput");
    expect(
      classifyNotification({ kind: "custom", requiresInput: true }).interruptClass,
    ).toBe("askInput");
    expect(classifyNotification({ kind: "turn_end" }).interruptClass).toBe("notice");
  });

  it("autoDismissMs：info/success 8s，error 与 askInput 不自动消失", () => {
    expect(autoDismissMs(classifyNotification({ kind: "turn_end" }))).toBe(8_000);
    expect(autoDismissMs(classifyNotification({ kind: "slow_tool" }))).toBe(8_000);
    expect(autoDismissMs(classifyNotification({ kind: "error" }))).toBeNull();
    expect(autoDismissMs(classifyNotification({ kind: "waiting_input" }))).toBeNull();
    expect(
      autoDismissMs(classifyNotification({ kind: "custom", requiresInput: true })),
    ).toBeNull();
  });
});
