import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Terminal } from "@xterm/xterm";

// vi.hoisted：vi.mock 工厂会被提升到 import 之前，引用外部变量必须走这里。
const mocks = vi.hoisted(() => {
  const ctor = vi.fn();
  return { ctor, loadAddon: vi.fn(), instance: { kind: "fake-image-addon" } };
});

vi.mock("@xterm/addon-image", () => {
  // 用 function（非箭头）才能被 `new` 调用；返回对象即作为 new 的结果。
  function ImageAddon(...args: unknown[]) {
    return mocks.ctor(...args) ?? mocks.instance;
  }
  return { ImageAddon };
});

import {
  TERMINAL_IMAGE_PIXEL_LIMIT,
  TERMINAL_IMAGE_STORAGE_LIMIT_MB,
  attachTerminalImageAddon,
  buildImageAddonOptions,
  loadImageAddonModule,
} from "./terminalImageAddon";

/** 只造本模块用到的最小终端面（loadAddon），其余字段与断言无关。 */
function makeTerm(): Terminal {
  return { loadAddon: mocks.loadAddon } as unknown as Terminal;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ctor.mockReturnValue(mocks.instance);
});

describe("buildImageAddonOptions", () => {
  it("把内存上限压到 addon 默认值之下", () => {
    const options = buildImageAddonOptions();
    // addon 默认 storageLimit=128MB、pixelLimit=2^24：多窗格场景必须压低。
    expect(options.storageLimit).toBe(TERMINAL_IMAGE_STORAGE_LIMIT_MB);
    expect(options.storageLimit!).toBeLessThan(128);
    expect(options.pixelLimit).toBe(TERMINAL_IMAGE_PIXEL_LIMIT);
    expect(options.pixelLimit!).toBeLessThan(16_777_216);
    expect(options.showPlaceholder).toBe(true);
  });

  // 单位契约守卫：addon-image 的 storageLimit 以「MB」为单位，构造时校验
  // 0.5 <= storageLimit <= 1000；越界会被真实 addon `console.error` 后静默回落
  // 到 10MB（已在 headless Chrome + 真实 addon-image@0.9.0 实测复现）。若误把
  // 字节数（如 32*1024*1024）传进来，此断言会失败，避免该回归重新混入。
  it("storageLimit 取 MB 量级并落在 addon 校验区间 [0.5, 1000] 内", () => {
    const { storageLimit } = buildImageAddonOptions();
    expect(storageLimit!).toBeGreaterThanOrEqual(0.5);
    expect(storageLimit!).toBeLessThanOrEqual(1000);
  });
});

describe("attachTerminalImageAddon", () => {
  it("挂载中时把 addon 装到终端并记录保守上限", async () => {
    const debugLog = vi.fn();

    const addon = await attachTerminalImageAddon({
      term: makeTerm(),
      isMounted: () => true,
      debugLog,
    });

    expect(addon).toBe(mocks.instance);
    expect(mocks.loadAddon).toHaveBeenCalledExactlyOnceWith(mocks.instance);
    // 保守上限必须真的传进 addon 构造，而不只是记在日志里。
    expect(mocks.ctor).toHaveBeenCalledExactlyOnceWith(buildImageAddonOptions());
    expect(debugLog).toHaveBeenCalledWith(
      "image.addon.attached",
      expect.objectContaining({
        storageLimitMb: TERMINAL_IMAGE_STORAGE_LIMIT_MB,
        pixelLimit: TERMINAL_IMAGE_PIXEL_LIMIT,
      }),
    );
  });

  it("取回期间已卸载则不附着（不污染已 dispose 的终端）", async () => {
    const debugLog = vi.fn();
    let mounted = true;

    const pending = attachTerminalImageAddon({
      term: makeTerm(),
      isMounted: () => mounted,
      debugLog,
    });
    // 同步翻卸载位：attach 内部首个 await 之后才会读 isMounted()，
    // 因此这里必然早于那次读取，不依赖微任务次数。
    mounted = false;
    const addon = await pending;

    expect(addon).toBeNull();
    expect(mocks.loadAddon).not.toHaveBeenCalled();
    expect(debugLog).toHaveBeenCalledWith("image.addon.skipped-unmounted", {});
  });

  it("附着抛错时吞掉并经 debugLog 上报，绝不影响终端本体", async () => {
    const debugLog = vi.fn();
    mocks.loadAddon.mockImplementation(() => {
      throw new Error("renderer already disposed");
    });

    const addon = await attachTerminalImageAddon({
      term: makeTerm(),
      isMounted: () => true,
      debugLog,
    });

    expect(addon).toBeNull();
    expect(debugLog).toHaveBeenCalledWith("image.addon.failed", {
      error: expect.stringContaining("renderer already disposed"),
    });
  });
});

describe("loadImageAddonModule", () => {
  it("模块级缓存：N 个终端只取回一次", async () => {
    const first = loadImageAddonModule();
    const second = loadImageAddonModule();

    expect(first).toBe(second);
    const mod = await first;
    expect(mod.ImageAddon).toBeTypeOf("function");
  });
});
