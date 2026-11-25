import type { IDisposable, Terminal } from "@xterm/xterm";
import type { TFunction } from "i18next";
import { toast } from "@/components/ui/toast";

import { terminalPathLinkService } from "@/services/terminalPathLinkService";
import { translateError } from "@/utils";
import { useTerminalPathLinkStore } from "@/stores/useTerminalPathLinkStore";
import {
  classifyOsc8TerminalLink,
  TerminalPathLinkProvider,
  type TerminalPathLinkOptions,
  type TerminalPathLinkValidator,
  type TerminalPathReference,
} from "@/lib/terminalPathLink";

/** 所有终端路径错误共用一个 toast id：同一错误原地刷新，不再叠成两三条。 */
export const TERMINAL_PATH_LINK_ERROR_TOAST_ID = "terminal-path-link-error";
/** hover 校验结果的缓存时长：鼠标在同一行/折行间移动不必反复走后端。 */
const VALIDATION_TTL_MS = 5_000;
/** hover 校验超时：后端慢时宁可不出链接，也不让 xterm 一直等。 */
const VALIDATION_TIMEOUT_MS = 2_000;

function withTimeout(promise: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

/**
 * 识别阶段的存在性校验：复用后端 resolve（`~` 展开、相对路径按会话 cwd 解析、越界判定都在那里），
 * 解析不了的候选就不出下划线。结果按 sessionId + path 短时缓存。
 */
export function createTerminalPathLinkValidator(
  getSessionId: () => string | null,
  now: () => number = Date.now,
): TerminalPathLinkValidator {
  const cache = new Map<string, { expiresAt: number; verdict: Promise<boolean> }>();
  return (reference) => {
    const sessionId = getSessionId();
    if (!sessionId) return Promise.resolve(false);
    const key = `${sessionId}\u0000${reference.path}`;
    const current = now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > current) return cached.verdict;
    for (const [entryKey, entry] of cache) {
      if (entry.expiresAt <= current) cache.delete(entryKey);
    }
    const verdict = withTimeout(
      Promise.resolve()
        .then(() => terminalPathLinkService.resolve({ sessionId, rawPath: reference.path }))
        .then(() => true),
      VALIDATION_TIMEOUT_MS,
    );
    cache.set(key, { expiresAt: current + VALIDATION_TTL_MS, verdict });
    return verdict;
  };
}

export function createTerminalPathLinkIntegration(
  allowPosixAbsolute: boolean,
  getSessionId: () => string | null,
  isSsh: () => boolean,
  isEnabled: () => boolean,
  translate: TFunction<"panes">,
) {
  const options: TerminalPathLinkOptions = { allowPosixAbsolute };
  // 同一路径解析未完成时再次激活直接忽略：一次点击（或连点）只出一个结果。
  const inFlight = new Set<string>();
  const activate = (reference: TerminalPathReference) => {
    if (!isEnabled()) return;
    const sessionId = getSessionId();
    if (!sessionId) {
      toast.error(translate("terminalPathLink.sessionUnavailable"), { id: TERMINAL_PATH_LINK_ERROR_TOAST_ID });
      return;
    }
    const key = `${sessionId}\u0000${reference.path}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    void useTerminalPathLinkStore.getState().open(reference, sessionId)
      .catch((error) => {
        toast.error(
          translate("terminalPathLink.resolveFailed", { error: translateError(error) }),
          { id: TERMINAL_PATH_LINK_ERROR_TOAST_ID },
        );
      })
      .finally(() => {
        inFlight.delete(key);
      });
  };
  const validate = createTerminalPathLinkValidator(getSessionId);

  return {
    linkHandler: {
      allowNonHttpProtocols: true,
      activate: (_event: unknown, uri: string) => {
        const target = classifyOsc8TerminalLink(uri, options);
        if (target?.type === "local") {
          if (!isSsh() && isEnabled()) activate(target.reference);
          return;
        }
        if (target?.type === "external") {
          void terminalPathLinkService.openExternalUrl(target.url).catch((error) => {
            toast.error(
              translate("terminalPathLink.actionFailed", { error: translateError(error) }),
              { id: TERMINAL_PATH_LINK_ERROR_TOAST_ID },
            );
          });
        }
      },
    },
    register: (terminal: Terminal): IDisposable =>
      terminal.registerLinkProvider(new TerminalPathLinkProvider(terminal, activate, options, isEnabled, validate)),
  };
}
