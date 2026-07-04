import { useCallback, useEffect, useState } from "react";
import { Pin, Minimize2, Sun, Moon, Terminal, ArrowUpCircle, Eye, EyeOff, LockKeyhole } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { handleErrorSilent } from "@/utils";
import {
  useThemeStore,
  useMiniModeStore,
  useWorkspacesStore,
  useSettingsStore,
  useTerminalStatusStore,
  useUpdateStore,
} from "@/stores";
import { useCCChanStore } from "@/stores/useCCChanStore";
import { triggerUpdate } from "@/services";
import { webAuthService, type WebAuthStatus } from "@/services/webAuthService";
import { useWindowControl } from "@/hooks/useWindowControl";
import { isBusyStatus } from "@/types";
import { invokeIfTauri, isTauriRuntime } from "@/services/runtime";

export default function StatusBar() {
  const { t, i18n } = useTranslation();
  const isDark = useThemeStore((s) => s.isDark);
  const enterMiniMode = useMiniModeStore((s) => s.enterMiniMode);
  const miniModeTransitioning = useMiniModeStore((s) => s.isTransitioning);
  const selectedWorkspace = useWorkspacesStore((s) => s.selectedWorkspace);
  const statusMap = useTerminalStatusStore((s) => s.statusMap);
  const updateAvailable = useUpdateStore((s) => s.available);
  const updateVersion = useUpdateStore((s) => s.version);
  const ccChanVisible = useCCChanStore((s) => s.settings.windowVisible);
  const loadCCChan = useCCChanStore((s) => s.load);
  const setCCChanVisible = useCCChanStore((s) => s.setWindowVisible);
  const [updating, setUpdating] = useState(false);
  const [webAuthStatus, setWebAuthStatus] = useState<WebAuthStatus | null>(null);
  const { isPinned, togglePin } = useWindowControl();

  const activeWorkspace = selectedWorkspace();
  let activeCount = 0;
  statusMap.forEach((info) => { if (isBusyStatus(info.status)) activeCount++; });

  useEffect(() => {
    void loadCCChan();
  }, [loadCCChan]);

  const refreshWebAuthStatus = useCallback(async () => {
    if (isTauriRuntime()) return;
    try {
      const status = await webAuthService.status();
      setWebAuthStatus(status);
    } catch (e) {
      handleErrorSilent(e, "load web auth status");
    }
  }, []);

  useEffect(() => {
    if (isTauriRuntime()) return;
    let cancelled = false;
    webAuthService.status()
      .then((status) => {
        if (!cancelled) setWebAuthStatus(status);
      })
      .catch((e) => handleErrorSilent(e, "load web auth status"));
    window.addEventListener("focus", refreshWebAuthStatus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshWebAuthStatus);
    };
  }, [refreshWebAuthStatus]);

  const handleUpdate = async () => {
    setUpdating(true);
    try {
      await triggerUpdate();
    } finally {
      setUpdating(false);
    }
  };

  function handleToggleLanguage() {
    const nextLang = i18n.language === "zh-CN" ? "en" : "zh-CN";
    i18n.changeLanguage(nextLang);
    const store = useSettingsStore.getState();
    if (store.settings) {
      const updated = { ...store.settings, general: { ...store.settings.general, language: nextLang } };
      store.saveSettings(updated).catch((e) => handleErrorSilent(e, "save settings"));
    }
  }

  async function handleToggleCCChan() {
    if (!isTauriRuntime()) return;
    const nextVisible = !useCCChanStore.getState().settings.windowVisible;
    try {
      await invokeIfTauri(nextVisible ? "show_ccchan" : "hide_ccchan");
      setCCChanVisible(nextVisible);
    } catch (e) {
      handleErrorSilent(e, "toggle ccchan");
    }
  }

  async function handleToggleTheme() {
    const nextTheme = isDark ? "light" : "dark";
    useThemeStore.getState().setThemeMode(nextTheme);
    const store = useSettingsStore.getState();
    if (store.settings) {
      const updated = { ...store.settings, theme: { ...store.settings.theme, mode: nextTheme } };
      try {
        await store.saveSettings(updated);
      } catch (e) {
        handleErrorSilent(e, "save theme");
      }
    }
  }

  async function handleLockWeb() {
    try {
      await webAuthService.lock();
      setWebAuthStatus((current) => current ? { ...current, authenticated: false } : current);
      window.dispatchEvent(new CustomEvent("cc-panes:web-locked"));
    } catch (e) {
      handleErrorSilent(e, "lock web");
    }
  }

  const showWebLock = !isTauriRuntime() && webAuthStatus !== null;
  const canLockWeb = showWebLock && webAuthStatus.authRequired && webAuthStatus.authenticated;

  return (
    <div
      className="flex items-center h-[24px] px-2 shrink-0 select-none z-10 text-[11px]"
      style={{
        background: "var(--app-activity-bar-bg)",
        borderTop: "1px solid var(--app-border)",
        backdropFilter: `blur(var(--app-glass-blur-sm))`,
        WebkitBackdropFilter: `blur(var(--app-glass-blur-sm))`,
        color: "var(--app-text-secondary)",
      }}
    >
      {/* 左侧信息 */}
      <div className="flex items-center gap-3 min-w-0">
        {/* 工作空间名 */}
        {activeWorkspace && (
          <span className="flex items-center gap-1 truncate max-w-[140px]">
            <span className="truncate">{activeWorkspace.alias || activeWorkspace.name}</span>
          </span>
        )}

        {/* 活跃终端数 */}
        {activeCount > 0 && (
          <span className="flex items-center gap-1">
            <Terminal className="w-3 h-3" />
            <span>{activeCount}</span>
          </span>
        )}

        {/* CPU / 内存指标 — 已禁用（macOS 卡顿排查）
        {resourceStats && resourceStats.processCount > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-2">
                <span className="flex items-center gap-0.5">
                  <Cpu className="w-3 h-3" />
                  <span>{resourceStats.totalCpuPercent.toFixed(1)}%</span>
                </span>
                <span className="flex items-center gap-0.5">
                  <MemoryStick className="w-3 h-3" />
                  <span>{formatBytes(resourceStats.totalMemoryBytes)}</span>
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>{resourceStats.processCount} processes | CPU {resourceStats.totalCpuPercent.toFixed(1)}% | Mem {formatBytes(resourceStats.totalMemoryBytes)}</p>
            </TooltipContent>
          </Tooltip>
        )}
        */}

        {/* 版本更新提示 */}
        {isTauriRuntime() && updateAvailable && updateVersion && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors hover:bg-[var(--app-hover)]"
                style={{ color: "var(--app-accent)" }}
                disabled={updating}
                onClick={handleUpdate}
              >
                <ArrowUpCircle className={`w-3 h-3 ${updating ? "animate-spin" : ""}`} />
                <span className="text-[10px] font-medium">v{updateVersion}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>{t("updateAvailable", { ns: "settings", defaultValue: "New version available, click to update" })}</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* 弹性间隔 */}
      <div className="flex-1" />

      {/* 右侧工具 */}
      <div className="flex items-center gap-0.5">
        {showWebLock && webAuthStatus.readOnly && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
                style={{ color: "var(--app-accent)", background: "var(--app-active-bg)" }}
              >
                <LockKeyhole className="w-3 h-3" />
                只读模式
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>远程只读模式已启用：当前来源只能查看，终端输入与文件改动被禁止</p>
            </TooltipContent>
          </Tooltip>
        )}

        {showWebLock && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors hover:bg-[var(--app-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!canLockWeb}
                onClick={() => void handleLockWeb()}
              >
                <LockKeyhole className="w-3 h-3" />
                <span className="text-[10px] font-medium">锁定 Web</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>{canLockWeb ? "锁定 Web 端" : "需要先启用账号密码并设置密码"}</p>
            </TooltipContent>
          </Tooltip>
        )}

        {/* 置顶 */}
        {isTauriRuntime() && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className={`p-0.5 rounded transition-colors ${
                isPinned ? "text-[var(--app-accent)]" : ""
              } hover:bg-[var(--app-hover)]`}
              onClick={togglePin}
            >
              <Pin className={`w-3 h-3 ${isPinned ? "rotate-45" : ""} transition-transform`} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{t("alwaysOnTop", { ns: "sidebar" })}</p>
          </TooltipContent>
        </Tooltip>
        )}

        {/* 迷你模式 */}
        {isTauriRuntime() && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="p-0.5 rounded transition-colors hover:bg-[var(--app-hover)]"
              disabled={miniModeTransitioning}
              onClick={() => enterMiniMode()}
            >
              <Minimize2 className="w-3 h-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{t("miniMode", { ns: "sidebar" })}</p>
          </TooltipContent>
        </Tooltip>
        )}

        {/* 分隔线 */}
        {isTauriRuntime() && (
          <div className="w-px h-3 mx-1" style={{ background: "var(--app-border)" }} />
        )}

        {/* cc酱 浮窗 */}
        {isTauriRuntime() && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className={`p-0.5 rounded transition-colors hover:bg-[var(--app-hover)] ${
                ccChanVisible ? "text-[var(--app-accent)]" : ""
              }`}
              onClick={() => void handleToggleCCChan()}
            >
              {ccChanVisible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{ccChanVisible ? "隐藏 cc酱" : "显示 cc酱"}</p>
          </TooltipContent>
        </Tooltip>
        )}

        {/* 语言切换 */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="px-1 py-0.5 rounded transition-colors hover:bg-[var(--app-hover)] text-[10px] font-medium"
              onClick={handleToggleLanguage}
            >
              {i18n.language === "zh-CN" ? "中" : "EN"}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{t("switchLanguage")} ({i18n.language === "zh-CN" ? "EN" : "中文"})</p>
          </TooltipContent>
        </Tooltip>

        {/* 主题切换 */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className={`p-0.5 rounded transition-colors hover:bg-[var(--app-hover)] ${
                isDark ? "text-amber-400" : ""
              }`}
              onClick={() => void handleToggleTheme()}
            >
              {isDark ? <Sun className="w-3 h-3" /> : <Moon className="w-3 h-3" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{isDark ? t("switchToLight", { ns: "dialogs" }) : t("switchToDark", { ns: "dialogs" })}</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
