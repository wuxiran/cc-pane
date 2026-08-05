import { describe, expect, test, vi } from "vitest";

import {
  bustModuleUrl,
  extractModuleUrl,
  importWithRetry,
  isModuleLoadError,
  moduleMatchesHint,
} from "./lazyRetry";

const CHUNK_URL = "http://localhost:14200/web/components/settings/GeneralSection.tsx";

function moduleLoadError(url = CHUNK_URL): TypeError {
  return new TypeError(`Failed to fetch dynamically imported module: ${url}`);
}

/** 立即 resolve 的 sleep，避免测试真的等退避时长。 */
const noSleep = () => Promise.resolve();

const fixedNow = () => 1_700_000_000_000;

describe("isModuleLoadError", () => {
  test.each([
    new TypeError(`Failed to fetch dynamically imported module: ${CHUNK_URL}`),
    new TypeError(`error loading dynamically imported module: ${CHUNK_URL}`),
    new Error("Importing a module script failed."),
    Object.assign(new Error("boom"), { name: "ChunkLoadError" }),
  ])("识别分片取回失败", (error) => {
    expect(isModuleLoadError(error)).toBe(true);
  });

  test.each([
    new Error("Cannot read properties of undefined"),
    // 组件模块自身求值抛错时不能误判成网络问题，否则会白白重试两轮才报错。
    new TypeError("value.map is not a function"),
    new Error("still loading chunk of records"),
  ])("不把普通运行时错误当成加载失败", (error) => {
    expect(isModuleLoadError(error)).toBe(false);
  });
});

describe("extractModuleUrl", () => {
  test("从错误消息里取出模块 URL", () => {
    expect(extractModuleUrl(moduleLoadError())).toBe(CHUNK_URL);
  });

  test("没有 URL 时返回 null", () => {
    expect(extractModuleUrl(new Error("Loading chunk failed"))).toBeNull();
  });
});

describe("moduleMatchesHint", () => {
  test("匹配 dev 下的 .tsx 源路径", () => {
    expect(moduleMatchesHint(CHUNK_URL, "GeneralSection")).toBe(true);
  });

  test("匹配构建产物里带 hash 的文件名", () => {
    expect(
      moduleMatchesHint("http://app/assets/GeneralSection-a1b2c3.js", "GeneralSection"),
    ).toBe(true);
  });

  test("拒绝同前缀的其他模块", () => {
    // 否则 `General` 会命中 `GeneralSettingsFoo`，重试出来的是错的模块。
    expect(moduleMatchesHint("http://app/assets/GeneralSectionExtra.js", "GeneralSection")).toBe(
      false,
    );
  });

  test("拒绝依赖模块的失败 URL", () => {
    expect(moduleMatchesHint("http://localhost:14200/node_modules/.vite/deps/sonner.js", "GeneralSection")).toBe(
      false,
    );
  });
});

describe("bustModuleUrl", () => {
  test("挂上一次性参数换掉 module map 的 key", () => {
    const busted = bustModuleUrl(CHUNK_URL, 1, 42);
    expect(new URL(busted).searchParams.get("cc-retry")).toBe("42-1");
  });

  test("保留原有查询参数", () => {
    const busted = bustModuleUrl(`${CHUNK_URL}?t=999`, 2, 42);
    const params = new URL(busted).searchParams;
    expect(params.get("t")).toBe("999");
    expect(params.get("cc-retry")).toBe("42-2");
  });

  test("每次重试的 key 都不同", () => {
    expect(bustModuleUrl(CHUNK_URL, 1, 42)).not.toBe(bustModuleUrl(CHUNK_URL, 2, 42));
  });
});

describe("importWithRetry", () => {
  test("首次成功时不重试", async () => {
    const mod = { default: () => null };
    const factory = vi.fn().mockResolvedValue(mod);
    const importModule = vi.fn();

    await expect(importWithRetry(factory, "GeneralSection", { importModule })).resolves.toBe(mod);

    expect(factory).toHaveBeenCalledOnce();
    expect(importModule).not.toHaveBeenCalled();
  });

  test("瞬时取回失败后重试成功", async () => {
    const mod = { default: () => null };
    const factory = vi.fn().mockRejectedValue(moduleLoadError());
    const importModule = vi.fn().mockResolvedValue(mod);

    await expect(
      importWithRetry(factory, "GeneralSection", { importModule, sleep: noSleep, now: fixedNow }),
    ).resolves.toBe(mod);

    // 必须带上 cache-bust 参数：原样重发只会命中 module map 里那条失败记录。
    expect(importModule).toHaveBeenCalledOnce();
    expect(new URL(importModule.mock.calls[0][0]).searchParams.get("cc-retry")).toBe(
      `${fixedNow()}-1`,
    );
  });

  test("耗尽重试后抛出首次的错误", async () => {
    const first = moduleLoadError();
    const factory = vi.fn().mockRejectedValue(first);
    const importModule = vi.fn().mockRejectedValue(moduleLoadError());

    await expect(
      importWithRetry(factory, "GeneralSection", {
        retries: 2,
        importModule,
        sleep: noSleep,
        now: fixedNow,
      }),
    ).rejects.toBe(first);

    expect(importModule).toHaveBeenCalledTimes(2);
  });

  test("组件求值错误直接抛出，不浪费重试", async () => {
    const evalError = new TypeError("value.map is not a function");
    const factory = vi.fn().mockRejectedValue(evalError);
    const importModule = vi.fn();

    await expect(
      importWithRetry(factory, "GeneralSection", { importModule, sleep: noSleep }),
    ).rejects.toBe(evalError);

    expect(importModule).not.toHaveBeenCalled();
  });

  test("失败的是依赖而非分片本身时放弃重试", async () => {
    // 重试只会重新取那个依赖 URL，把依赖模块当组件返回会静默渲染错东西。
    const depError = moduleLoadError("http://localhost:14200/node_modules/.vite/deps/sonner.js");
    const factory = vi.fn().mockRejectedValue(depError);
    const importModule = vi.fn();

    await expect(
      importWithRetry(factory, "GeneralSection", { importModule, sleep: noSleep }),
    ).rejects.toBe(depError);

    expect(importModule).not.toHaveBeenCalled();
  });

  test("错误里没有 URL 时放弃重试", async () => {
    const error = Object.assign(new Error("Loading chunk settings failed"), {
      name: "ChunkLoadError",
    });
    const factory = vi.fn().mockRejectedValue(error);
    const importModule = vi.fn();

    await expect(
      importWithRetry(factory, "GeneralSection", { importModule, sleep: noSleep }),
    ).rejects.toBe(error);

    expect(importModule).not.toHaveBeenCalled();
  });

  test("重试期间冒出的普通错误立即抛出", async () => {
    const evalError = new TypeError("value.map is not a function");
    const factory = vi.fn().mockRejectedValue(moduleLoadError());
    const importModule = vi.fn().mockRejectedValue(evalError);

    await expect(
      importWithRetry(factory, "GeneralSection", {
        retries: 3,
        importModule,
        sleep: noSleep,
        now: fixedNow,
      }),
    ).rejects.toBe(evalError);

    expect(importModule).toHaveBeenCalledOnce();
  });

  test("退避时长按 2 的幂次递增", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const factory = vi.fn().mockRejectedValue(moduleLoadError());
    const importModule = vi.fn().mockRejectedValue(moduleLoadError());

    await expect(
      importWithRetry(factory, "GeneralSection", {
        retries: 3,
        baseDelayMs: 100,
        importModule,
        sleep,
        now: fixedNow,
      }),
    ).rejects.toBeInstanceOf(TypeError);

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200, 400]);
  });
});
