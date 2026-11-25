// 本机转写组件的状态：进入设置时读一次，下载中每 500ms 轮询进度。
import { useCallback, useEffect, useState } from "react";
import { voiceService, type LocalVoiceStatus } from "@/services";
import { isTauriRuntime } from "@/services/runtime";

const ACTIVE_STAGES = new Set(["engine", "model", "extract"]);
const POLL_MS = 500;

export interface LocalVoiceController {
  status: LocalVoiceStatus | null;
  installing: boolean;
  error: string | null;
  install: (modelId: string) => Promise<void>;
  cancel: () => Promise<void>;
  remove: (modelId: string) => Promise<void>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function useLocalVoice(active: boolean): LocalVoiceController {
  const [status, setStatus] = useState<LocalVoiceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isTauriRuntime()) return;
    try {
      setStatus(await voiceService.localStatus());
    } catch (cause) {
      setError(message(cause));
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const installing = Boolean(status?.install && ACTIVE_STAGES.has(status.install.stage));
  useEffect(() => {
    if (!installing) return;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [installing, refresh]);

  const run = useCallback(
    async (action: () => Promise<void>) => {
      setError(null);
      try {
        await action();
      } catch (cause) {
        setError(message(cause));
      }
      await refresh();
    },
    [refresh],
  );

  return {
    status,
    installing,
    error,
    install: (modelId) => run(() => voiceService.localInstall(modelId)),
    cancel: () => run(() => voiceService.localCancelInstall()),
    remove: (modelId) => run(() => voiceService.localRemove(modelId)),
  };
}

/** 设置里选中的本地模型是否已能用（引擎 + 模型都已下载）。状态未知时按未就绪处理。 */
export function localModelReady(status: LocalVoiceStatus | null, modelId: string): boolean {
  if (!status?.engineInstalled) return false;
  return status.models.some((model) => model.id === modelId && model.installed);
}
