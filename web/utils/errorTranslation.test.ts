import { describe, it, expect, vi } from "vitest";

vi.mock("@/i18n", () => ({
  default: {
    exists: () => false,
    t: (key: string) => key,
  },
}));

import { getErrorCode, toTerminalLaunchError } from "./errorTranslation";

describe("getErrorCode", () => {
  it("从 BackendError 对象提取 code（Tauri 通道）", () => {
    expect(
      getErrorCode({ code: "TRASH_FAILED", message: "Failed to move to trash" }),
    ).toBe("TRASH_FAILED");
  });

  it("从 [CODE] 前缀文本提取 code（REST 通道 Display 格式）", () => {
    expect(getErrorCode("[TRASH_FAILED] Failed to move to trash: aborted")).toBe(
      "TRASH_FAILED",
    );
  });

  it("从 Error 实例的 message 前缀提取 code", () => {
    expect(getErrorCode(new Error("[TRASH_FAILED] Failed to move to trash"))).toBe(
      "TRASH_FAILED",
    );
  });

  it("从 JSON 字符串提取 code", () => {
    expect(getErrorCode('{"code":"NOT_FOUND","message":"gone"}')).toBe("NOT_FOUND");
  });

  it("无 code 的纯文本返回 null", () => {
    expect(getErrorCode("Cannot delete read-only path")).toBe(null);
    expect(getErrorCode({ message: "plain failure" })).toBe(null);
    expect(getErrorCode(undefined)).toBe(null);
  });

  it("从 REST Error message 中保留结构化 launch timeout", () => {
    expect(toTerminalLaunchError(new Error(
      '{"code":"LAUNCH_TIMEOUT","message":"timed out","params":{"stage":"pty"}}',
    ))).toEqual({
      code: "LAUNCH_TIMEOUT",
      message: "timed out",
      params: { stage: "pty" },
    });
  });
});
