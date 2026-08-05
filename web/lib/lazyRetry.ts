// 懒加载分片的取回重试。
//
// `React.lazy` 把工厂函数**只调用一次**，一旦那次 import 被 reject，lazy payload 就
// 永久停在 Rejected 状态；更底层的浏览器 module map 同样会把「取回失败」按 URL 永久
// 缓存住。两层缓存叠加的后果是：dev server 抖一下（重启 / HMR 全量重载 / watcher 风暴
// 把 Vite 拖死），此后**再也没有任何一次重新渲染能把这个分片救回来**，只能整页刷新。
//
// 而这类失败恰恰是最典型的瞬时故障。所以这里在工厂内部做退避重试，并且重试时给失败
// URL 挂一个一次性 query 参数——换 key 才能绕开 module map 里那条失败记录，原样重发
// 只会立刻拿回同一个失败。
//
// 重试结果必须过 `moduleMatchesHint` 校验：错误消息里的 URL 未必是分片自己，也可能是
// 它的某个依赖。那种情况下把依赖模块当成组件模块返回会静默渲染错东西，比直接失败更坏，
// 因此对不上 hint 就放弃重试、让错误照常抛给 ErrorBoundary。
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/** 与 ErrorBoundary 中的判定保持同一套措辞，两处都覆盖各浏览器的不同文案。 */
const MODULE_LOAD_ERROR_PATTERN =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|failed to load module script|unable to preload css|^loading chunk \S+ failed\b/i;

const MODULE_URL_PATTERN = /\bhttps?:\/\/[^\s'")]+/i;

/** 重试时挂的一次性参数名，与 Vite 自己的 `t=` 时间戳区分开，避免互相覆盖。 */
const CACHE_BUST_PARAM = "cc-retry";

export interface LazyRetryOptions {
  /** 首次失败后的额外尝试次数。 */
  retries?: number;
  /** 首次退避时长，后续按 2 的幂次递增。 */
  baseDelayMs?: number;
  /** 注入点：测试里替换掉真实的动态 import。 */
  importModule?: (url: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function isModuleLoadError(error: unknown): boolean {
  if (error instanceof Error && error.name === "ChunkLoadError") return true;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return MODULE_LOAD_ERROR_PATTERN.test(message);
}

/** 从「Failed to fetch dynamically imported module: <url>」里取出那个 URL。 */
export function extractModuleUrl(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.match(MODULE_URL_PATTERN)?.[0] ?? null;
}

/**
 * 失败 URL 是否确实指向我们想加载的那个模块。
 *
 * hint 是不带扩展名的文件名（`GeneralSection`）；实际 URL 在 dev 下是
 * `/web/components/settings/GeneralSection.tsx`，在 build 产物里是
 * `/assets/GeneralSection-a1b2c3.js`，两种都要认。
 */
export function moduleMatchesHint(url: string, hint: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url, "http://localhost").pathname;
  } catch {
    return false;
  }
  const fileName = pathname.split("/").pop() ?? "";
  if (!fileName.startsWith(hint)) return false;
  const rest = fileName.slice(hint.length);
  // 后面只允许跟扩展名或构建期 hash，防止 `General` 命中 `GeneralSettingsFoo`。
  return rest === "" || /^[.-]/.test(rest);
}

/** 给 URL 换一个 module map 里还不存在的 key。 */
export function bustModuleUrl(url: string, attempt: number, now: number): string {
  try {
    const parsed = new URL(url, "http://localhost");
    parsed.searchParams.set(CACHE_BUST_PARAM, `${now}-${attempt}`);
    return parsed.href;
  } catch {
    return url;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const defaultImportModule = (url: string): Promise<unknown> => import(/* @vite-ignore */ url);

/**
 * 跑一次动态 import，失败且判定为「分片没取回来」时退避重试。
 *
 * 非模块加载类错误（组件模块自己在求值阶段抛的）直接原样抛出——那种重试多少次都一样，
 * 拖着只会让错误界面晚出现。
 */
export async function importWithRetry<T>(
  factory: () => Promise<T>,
  hint: string,
  options: LazyRetryOptions = {},
): Promise<T> {
  const {
    retries = 2,
    baseDelayMs = 300,
    importModule = defaultImportModule,
    sleep = defaultSleep,
    now = () => Date.now(),
  } = options;

  try {
    return await factory();
  } catch (error) {
    if (!isModuleLoadError(error)) throw error;

    const url = extractModuleUrl(error);
    // 拿不到 URL，或失败的是依赖而非分片本身：没有安全的重试路径，交给 ErrorBoundary。
    if (!url || !moduleMatchesHint(url, hint)) throw error;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      await sleep(baseDelayMs * 2 ** (attempt - 1));
      try {
        return (await importModule(bustModuleUrl(url, attempt, now()))) as T;
      } catch (retryError) {
        if (!isModuleLoadError(retryError)) throw retryError;
      }
    }
    // 抛首次的错误：它带着原始 URL，ErrorBoundary 的整页刷新判定依赖这个措辞。
    throw error;
  }
}

/**
 * `React.lazy` 的替代品，失败时自愈。
 *
 * 泛型开在 props 上而不是组件类型上：`React.lazy` 自身的约束是 `ComponentType<any>`，
 * 直接照抄会把 `any` 引进来；以 `P` 为参数则同样能接任意组件，且调用方 props 的类型
 * 推导保持完整。
 *
 * @param hint 目标模块的文件名（不含扩展名），用于校验重试对象是不是它本身。
 */
export function lazyWithRetry<P>(
  factory: () => Promise<{ default: ComponentType<P> }>,
  hint: string,
  options?: LazyRetryOptions,
): LazyExoticComponent<ComponentType<P>> {
  return lazy(() => importWithRetry(factory, hint, options));
}
