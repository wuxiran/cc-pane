import { useEffect } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { listenWebviewIfTauri } from "@/services/runtime";

/**
 * 后端 `terminal-launch-warning` 事件的载荷（见 cc-panes-core constants::events）。
 * kind：
 * - `profileMismatch`：显式选中的启动配置因 CLI/运行环境不匹配被静默回落，
 *   profile 级设置（如 YOLO）可能未生效。
 * - `orchestratorLoopbackWsl`：orchestrator 仅监听回环时启动了 WSL 会话，
 *   WSL 内 CLI 无法回连 ccpanes MCP。
 * - `codexResumeTargetMissing`：Codex 恢复目标在会话目录中不存在，已降级为新会话。
 */
export interface LaunchWarningPayload {
  kind: string;
  cliTool?: string;
  runtimeKind?: string;
  requestedProfileName?: string;
  cliMismatch?: boolean;
  runtimeMismatch?: boolean;
  usedProfileName?: string | null;
  bindMode?: string;
}

/**
 * 监听启动非致命警告并以 toast 提示用户。挂在 App 顶层一次即可。
 */
export function useLaunchWarnings(): void {
  const { t } = useTranslation(["panes", "common"]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      try {
        const fn = await listenWebviewIfTauri<LaunchWarningPayload>(
          "terminal-launch-warning",
          (event) => {
            const payload = event.payload;
            if (!payload) return;
            if (payload.kind === "profileMismatch") {
              toast.warning(
                t("launchProfileMismatch", {
                  ns: "panes",
                  profile: payload.requestedProfileName ?? "",
                  cli: payload.cliTool ?? "",
                  used: payload.usedProfileName ?? t("common:default", { defaultValue: "default" }),
                }),
              );
            } else if (payload.kind === "orchestratorLoopbackWsl") {
              toast.warning(
                t("orchestratorLoopbackWsl", {
                  ns: "panes",
                  defaultValue:
                    "MCP 编排服务仅监听本机回环，且未检测到 WSL mirrored 网络，WSL 内 CLI 可能无法回连 ccpanes MCP。可在设置 → Web 访问中调整监听模式后重启应用。",
                }),
              );
            } else if (payload.kind === "codexResumeTargetMissing") {
              toast.warning(
                t("codexResumeTargetMissing", {
                  ns: "panes",
                  defaultValue: "未找到 Codex 恢复目标，已改为启动新会话。",
                }),
              );
            }
          },
        );
        if (cancelled) fn();
        else unlisten = fn;
      } catch {
        // Web 运行时或监听失败：静默忽略（非致命提示，不应影响主流程）。
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [t]);
}

export default useLaunchWarnings;
