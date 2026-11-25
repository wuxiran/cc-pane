/**
 * 登录账号的登录状态（已认证 / 未登录 / 套餐），会话级共享缓存。
 *
 * 每次查询后端都要读账号目录、在 macOS 上还要问一次钥匙串（只查条目在不在），
 * 运行配置页每次渲染都去查就太重了。这里按 `供应商 + 账号 + CLI` 缓存：
 * 有缓存就直接用，超过 {@link LOGIN_STATUS_TTL_MS} 才在后台重查；同一个键同时只有一个在途请求。
 * 查询失败也记一笔（值为 null），避免出错时每次渲染都重试。
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { loginAccountService } from "@/services/loginAccountService";
import type { LoginAccountCliTool, LoginAccountStatus } from "@/types/provider";

export const LOGIN_STATUS_TTL_MS = 60_000;

export interface LoginStatusRequest {
  providerId: string;
  accountId: string;
  cliTool: LoginAccountCliTool;
}

interface CacheEntry {
  status: LoginAccountStatus | null;
  at: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<void>>();
const subscribers = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  subscribers.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

export function loginStatusKey(request: LoginStatusRequest): string {
  return `${request.providerId}::${request.accountId}::${request.cliTool}`;
}

function ensureFresh(request: LoginStatusRequest): void {
  const key = loginStatusKey(request);
  const entry = cache.get(key);
  if (entry && Date.now() - entry.at < LOGIN_STATUS_TTL_MS) return;
  if (inflight.has(key)) return;
  const done = (status: LoginAccountStatus | null) => {
    // 失败时保留上一次成功的值，只刷新时间戳
    cache.set(key, { status: status ?? entry?.status ?? null, at: Date.now() });
    inflight.delete(key);
    notify();
  };
  const request$ = loginAccountService
    .getLoginStatus(request.providerId, request.accountId, request.cliTool)
    .then(done, () => done(null));
  inflight.set(key, request$);
}

/** 仅供测试：清空会话缓存，避免用例间串数据 */
export function resetLoginStatusCacheForTests(): void {
  cache.clear();
  inflight.clear();
  subscribers.clear();
  version = 0;
}

/** 一组账号的登录状态，键为 {@link loginStatusKey}。还没查到的键不在结果里。 */
export function useLoginStatuses(requests: readonly LoginStatusRequest[]): Record<string, LoginAccountStatus> {
  const keys = requests.map(loginStatusKey).join("|");
  const snapshot = useSyncExternalStore(subscribe, () => version);

  useEffect(() => {
    requests.forEach(ensureFresh);
    // keys 已经覆盖了 requests 的内容；requests 本身每次渲染都是新数组
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);

  return useMemo(() => {
    const result: Record<string, LoginAccountStatus> = {};
    for (const key of keys ? keys.split("|") : []) {
      const status = cache.get(key)?.status;
      if (status) result[key] = status;
    }
    return result;
  }, [keys, snapshot]);
}
