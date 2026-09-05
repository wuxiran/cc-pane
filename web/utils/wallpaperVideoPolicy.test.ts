import { describe, expect, it } from "vitest";
import {
  decideWallpaperVideoPolicy,
  isWallpaperOccludedByTerminalUnderlay,
} from "./wallpaperVideoPolicy";

describe("decideWallpaperVideoPolicy", () => {
  const healthyEnv = {
    prefersReducedMotion: false,
    hardwareConcurrency: 16,
    deviceMemory: 16,
    battery: { discharging: false, level: 1 },
    decodeFailed: false,
  };

  it("1. power_saver=never 强制 video，无视其他信号", () => {
    expect(
      decideWallpaperVideoPolicy("never", {
        ...healthyEnv,
        prefersReducedMotion: true,
        hardwareConcurrency: 2,
        battery: { discharging: true, level: 0.1 },
        decodeFailed: true,
      }),
    ).toEqual({ mode: "video", reason: "user-force-video" });
  });

  it("2. prefers-reduced-motion → poster", () => {
    expect(
      decideWallpaperVideoPolicy("auto", { ...healthyEnv, prefersReducedMotion: true }),
    ).toEqual({ mode: "poster", reason: "reduced-motion" });
  });

  it("3. 低端设备（核数或内存 < 4）→ poster", () => {
    expect(
      decideWallpaperVideoPolicy("auto", { ...healthyEnv, hardwareConcurrency: 2 }),
    ).toEqual({ mode: "poster", reason: "low-end-device" });
    expect(decideWallpaperVideoPolicy("auto", { ...healthyEnv, deviceMemory: 2 })).toEqual({
      mode: "poster",
      reason: "low-end-device",
    });
    // deviceMemory 缺省不作为降级依据
    expect(
      decideWallpaperVideoPolicy("auto", { ...healthyEnv, deviceMemory: undefined }).mode,
    ).toBe("video");
  });

  it("4. 电池放电且低于 30% → poster", () => {
    expect(
      decideWallpaperVideoPolicy("auto", {
        ...healthyEnv,
        battery: { discharging: true, level: 0.2 },
      }),
    ).toEqual({ mode: "poster", reason: "battery-saver" });
    // 在充电则不降级
    expect(
      decideWallpaperVideoPolicy("auto", {
        ...healthyEnv,
        battery: { discharging: false, level: 0.2 },
      }).mode,
    ).toBe("video");
  });

  it("5. 解码失败 → poster", () => {
    expect(decideWallpaperVideoPolicy("auto", { ...healthyEnv, decodeFailed: true })).toEqual({
      mode: "poster",
      reason: "decode-failed",
    });
  });

  it("6. 其余 → video / auto-video（空 env 也成立）", () => {
    expect(decideWallpaperVideoPolicy("auto", healthyEnv)).toEqual({
      mode: "video",
      reason: "auto-video",
    });
    expect(decideWallpaperVideoPolicy("auto", {})).toEqual({
      mode: "video",
      reason: "auto-video",
    });
  });

  it("表外：power_saver=always 恒 poster", () => {
    expect(decideWallpaperVideoPolicy("always", healthyEnv)).toEqual({
      mode: "poster",
      reason: "user-power-saver",
    });
  });
});

describe("isWallpaperOccludedByTerminalUnderlay（与 MainViewSwitcher terminalSolidUnderlay 同条件）", () => {
  const occluded = {
    wallpaperActive: true,
    isDark: false,
    canvasDisplayMode: "panel" as const,
    layoutHasTerminal: true,
  };

  it("亮色 + panel 模式 + 终端主导 + 壁纸激活 → 完全遮挡", () => {
    expect(isWallpaperOccludedByTerminalUnderlay(occluded)).toBe(true);
  });

  it("任一条件不成立即不遮挡", () => {
    // 暗色主题不垫
    expect(isWallpaperOccludedByTerminalUnderlay({ ...occluded, isDark: true })).toBe(false);
    // canvas 模式不垫（节点间透壁纸是该视图设计）
    expect(
      isWallpaperOccludedByTerminalUnderlay({ ...occluded, canvasDisplayMode: "canvas" }),
    ).toBe(false);
    // 无终端的空态/启动器不垫
    expect(isWallpaperOccludedByTerminalUnderlay({ ...occluded, layoutHasTerminal: false })).toBe(
      false,
    );
    // 壁纸未激活无垫层
    expect(isWallpaperOccludedByTerminalUnderlay({ ...occluded, wallpaperActive: false })).toBe(
      false,
    );
  });
});
