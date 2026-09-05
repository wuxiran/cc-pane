import { useCallback, useEffect, useState } from "react";
import {
  ArrowUpCircle, Eye, EyeOff, LockKeyhole, Minimize2, MoreHorizontal, Music, Music2,
  Pin, Terminal,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { handleErrorSilent } from "@/utils";
import {
  useMiniModeStore,
  useWorkspacesStore,
  useSettingsStore,
  useTerminalStatusStore,
  useUpdateStore,
  useWallpaperStore,
} from "@/stores";
import { toggleWallpaperMusic } from "@/utils/wallpaperMusicController";
import { useCCChanStore } from "@/stores/useCCChanStore";
import { triggerUpdate } from "@/services";
import { webAuthService, type WebAuthStatus } from "@/services/webAuthService";
import { useWindowControl } from "@/hooks/useWindowControl";
import { useMediaUp } from "@/hooks/useBreakpoint";
import { isBusyStatus } from "@/types";
import { invokeIfTauri, isTauriRuntime } from "@/services/runtime";
import SystemResourceSegment from "@/components/statusbar/SystemResourceSegment";
import UsageStatsStatusButton from "@/components/statusbar/UsageStatsStatusButton";
import NotificationBellButton from "@/components/statusbar/NotificationBellButton";
import CommandPaletteButton from "@/components/statusbar/CommandPaletteButton";
import ThemeQuickMenu from "@/components/statusbar/ThemeQuickMenu";

/** 右侧图标组的组间竖分隔符，与既有分隔线风格一致。窄档收进更多菜单时由容器 CSS 隐藏。 */
function StatusDivider() {
  return (
    <div
      data-status-divider
      className="w-px h-3 mx-1"
      style={{ background: "var(--app-border)" }}
    />
  );
}

export default function StatusBar() {
  const { t, i18n } = useTranslation();
  const { t: settingsT } = useTranslation("settings");
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
  const musicAvailable = useWallpaperStore((s) => s.musicUrl !== null);
  const musicPlaying = useWallpaperStore((s) => s.musicPlaying);
  const musicGestureNeeded = useWallpaperStore((s) => s.musicGestureNeeded);
  const [webAuthStatus, setWebAuthStatus] = useState<WebAuthStatus | null>(
    null,
  );
  const showSystemResources = useSettingsStore(
    (s) => s.settings?.general.showSystemResources ?? true,
  );
  const { isPinned, togglePin } = useWindowControl();
  // 窄档溢出策略：lg 以下低优先级项收进「更多」菜单；xs 连通知铃铛也收进菜单，
  // 行内只保留命令面板与主题快速菜单两个最高频入口。
  const upLg = useMediaUp("lg");
  const upSm = useMediaUp("sm");

  const activeWorkspace = selectedWorkspace();
  let activeCount = 0;
  statusMap.forEach((info) => {
    if (isBusyStatus(info.status)) activeCount++;
  });

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
    webAuthService
      .status()
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
      const updated = {
        ...store.settings,
        general: { ...store.settings.general, language: nextLang },
      };
      store
        .saveSettings(updated)
        .catch((e) => handleErrorSilent(e, "save settings"));
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

  async function handleLockWeb() {
    try {
      await webAuthService.lock();
      setWebAuthStatus((current) =>
        current ? { ...current, authenticated: false } : current,
      );
      window.dispatchEvent(new CustomEvent("cc-panes:web-locked"));
    } catch (e) {
      handleErrorSilent(e, "lock web");
    }
  }

  const showWebLock = !isTauriRuntime() && webAuthStatus !== null;
  const canLockWeb =
    showWebLock && webAuthStatus.authRequired && webAuthStatus.authenticated;

  const musicLabel = musicGestureNeeded
    ? settingsT("wallpaperMusicGesture")
    : settingsT(musicPlaying ? "wallpaperMusicPause" : "wallpaperMusicPlay");
  const ccChanLabel = ccChanVisible
    ? t("statusbar.ccchanHide")
    : t("statusbar.ccchanShow");

  // 低优先级项（资源/用量/音乐/Web 锁定/置顶/迷你/cc酱/语言）：宽档原样行内排布，
  // 窄档整体收进「更多」Popover；同一份 JSX 单实例渲染，跨档只是换挂载位置。
  const secondaryItems = (
    <>
      {isTauriRuntime() && showSystemResources && <SystemResourceSegment />}
      {isTauriRuntime() && <UsageStatsStatusButton />}

      {/* 壁纸音乐：autoplay 被拒时这里是显式起播入口，平时是播放/暂停开关 */}
      {isTauriRuntime() && musicAvailable && <StatusDivider />}
      {isTauriRuntime() && musicAvailable && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={musicLabel}
              className="flex items-center px-1.5 py-0.5 rounded transition-colors hover:bg-[var(--app-hover)]"
              style={
                musicGestureNeeded
                  ? { color: "var(--app-accent)" }
                  : undefined
              }
              onClick={() => toggleWallpaperMusic()}
            >
              {musicPlaying ? (
                <Music2 className="w-3 h-3" />
              ) : (
                <Music className="w-3 h-3" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{musicLabel}</p>
          </TooltipContent>
        </Tooltip>
      )}

      {/* Web 只读徽章 + 锁定入口（Web 端） */}
      {showWebLock && <StatusDivider />}
      {showWebLock && webAuthStatus.readOnly && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
              style={{
                color: "var(--app-accent)",
                background: "var(--app-active-bg)",
              }}
            >
              <LockKeyhole className="w-3 h-3" />
              只读模式
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>
              远程只读模式已启用：当前来源只能查看，终端输入与文件改动被禁止
            </p>
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
            <p>
              {canLockWeb ? "锁定 Web 端" : "需要先启用账号密码并设置密码"}
            </p>
          </TooltipContent>
        </Tooltip>
      )}

      {/* 置顶 + 迷你模式 */}
      {isTauriRuntime() && <StatusDivider />}
      {isTauriRuntime() && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={t("alwaysOnTop", { ns: "sidebar" })}
              className={`p-0.5 rounded transition-colors ${
                isPinned ? "text-[var(--app-accent)]" : ""
              } hover:bg-[var(--app-hover)]`}
              onClick={togglePin}
            >
              <Pin
                className={`w-3 h-3 ${isPinned ? "rotate-45" : ""} transition-transform`}
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{t("alwaysOnTop", { ns: "sidebar" })}</p>
          </TooltipContent>
        </Tooltip>
      )}

      {isTauriRuntime() && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={t("miniMode", { ns: "sidebar" })}
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

      {/* cc酱 浮窗 */}
      {isTauriRuntime() && <StatusDivider />}
      {isTauriRuntime() && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={ccChanLabel}
              className={`p-0.5 rounded transition-colors hover:bg-[var(--app-hover)] ${
                ccChanVisible ? "text-[var(--app-accent)]" : ""
              }`}
              onClick={() => void handleToggleCCChan()}
            >
              {ccChanVisible ? (
                <Eye className="w-3 h-3" />
              ) : (
                <EyeOff className="w-3 h-3" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{ccChanLabel}</p>
          </TooltipContent>
        </Tooltip>
      )}

      {/* 语言切换 */}
      {isTauriRuntime() && <StatusDivider />}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={t("switchLanguage")}
            className="px-1 py-0.5 rounded transition-colors hover:bg-[var(--app-hover)] text-[10px] font-medium"
            onClick={handleToggleLanguage}
          >
            {i18n.language === "zh-CN" ? "中" : "EN"}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>
            {t("switchLanguage")} ({i18n.language === "zh-CN" ? "EN" : "中文"}
            )
          </p>
        </TooltipContent>
      </Tooltip>
    </>
  );

  return (
    <div
      // tabular-nums 挂在根容器上即可继承到所有后代数字（CPU/内存/活跃数/版本号），
      // 等宽数字消除数值刷新时的横向跳动；只加类，不改任何结构。
      className="shape-chrome flex items-center h-[var(--density-row-h)] px-2.5 shrink-0 select-none z-10 text-[length:var(--text-caption)] tabular-nums"
      style={{
        background: "var(--app-menubar)",
        borderTop: "1px solid var(--app-border)",
        backdropFilter: `blur(var(--app-glass-blur-sm))`,
        WebkitBackdropFilter: `blur(var(--app-glass-blur-sm))`,
        color: "var(--app-text-secondary)",
      }}
    >
      {/* 左侧信息 */}
      <div className="flex items-center gap-3 min-w-0">
        {/* 工作空间名：窄档压缩截断宽度，给右侧入口留出空间 */}
        {activeWorkspace && (
          <span className="flex items-center gap-1 truncate max-w-[72px] sm:max-w-[110px] lg:max-w-[140px]">
            <span className="truncate">
              {activeWorkspace.alias || activeWorkspace.name}
            </span>
          </span>
        )}

        {/* 活跃终端数 */}
        {activeCount > 0 && (
          <span className="flex items-center gap-1">
            <Terminal className="w-3 h-3" />
            <span>{activeCount}</span>
          </span>
        )}

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
                <ArrowUpCircle
                  className={`w-3 h-3 ${updating ? "animate-spin" : ""}`}
                />
                <span className="text-[10px] font-medium">
                  v{updateVersion}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>
                {t("updateAvailable", {
                  ns: "settings",
                  defaultValue: "New version available, click to update",
                })}
              </p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* 弹性间隔 */}
      <div className="flex-1" />

      {/* 右侧工具：命令面板/通知常驻（xs 连通知也收起），低优先级项窄档收进更多菜单 */}
      <div className="flex items-center gap-0.5">
        <CommandPaletteButton />
        {upSm && <NotificationBellButton />}

        {upLg ? (
          secondaryItems
        ) : (
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <button
                    aria-label={t("statusbar.more")}
                    className="p-0.5 rounded transition-colors hover:bg-[var(--app-hover)]"
                  >
                    <MoreHorizontal className="w-3 h-3" />
                  </button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>{t("statusbar.more")}</p>
              </TooltipContent>
            </Tooltip>
            <PopoverContent side="top" align="end" className="w-auto p-1.5">
              {/* 菜单内换行排布；行内用的竖分隔符在菜单里无意义，容器级隐藏 */}
              <div className="flex max-w-[220px] flex-wrap items-center gap-0.5 [&_[data-status-divider]]:hidden">
                {!upSm && <NotificationBellButton />}
                {secondaryItems}
              </div>
            </PopoverContent>
          </Popover>
        )}

        <ThemeQuickMenu />
      </div>
    </div>
  );
}
