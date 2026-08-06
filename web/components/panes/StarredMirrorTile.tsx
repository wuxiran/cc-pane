import { useContext, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Star } from "lucide-react";
import { LayoutVisibilityContext } from "@/contexts/LayoutVisibilityContext";
import { useTabViewStateStore } from "@/stores/useTabViewStateStore";
import TerminalView from "./TerminalView";
import type { StarredMirrorTileData } from "./starredMirrors";

interface StarredMirrorTileProps {
  tile: StarredMirrorTileData;
  onJump: (tabId: string) => void;
}

const noop = () => {};

/**
 * 星标页的单个镜像格子：同一 PTY 会话的第二视图（attach-only）。
 *
 * 关键约束：
 * - 只传 sessionId 走 attach-existing 路径，绝不传 launchClaude/cliTool/restoring
 *   等创建型 props——镜像卸载不 killSession、重启恢复不会重复 spawn。
 * - 不传 paneId/tabId/onSessionExited/onReconnect：镜像不参与 tab 生命周期，
 *   SSH 重连在原 tab 做，换 sessionId 后镜像靠 key remount 自动跟随。
 */
export default function StarredMirrorTile({ tile, onJump }: StarredMirrorTileProps) {
  const { t } = useTranslation("panes");
  const layoutVisible = useContext(LayoutVisibilityContext);

  // 可见性上报：owner 是被镜像的那个 tab，role=mirror。
  //
  // 这条上报正是修「星标页正看着、原 tab 却休眠」的关键：聚合按 owner 算
  // 「任一视图可见」，原 tab 的 primary 视图隐藏时，mirror 这条会把
  // anyVisible 顶住。
  //
  // 写侧在这里，读侧经 visibilityOwnerId/viewRole 传给 TerminalView——镜像的
  // 降档判据从此看聚合（全部视图都不可见才降），焦点判据看 mirror 单视图
  // （上报只有 visible/hidden，永不 active，故不会抢 refit/focus）。
  const tabId = tile.tabId;
  useEffect(() => {
    useTabViewStateStore
      .getState()
      .reportView(tabId, "mirror", layoutVisible ? "visible" : "hidden");
  }, [tabId, layoutVisible]);

  useEffect(() => {
    return () => {
      useTabViewStateStore.getState().removeView(tabId, "mirror");
    };
  }, [tabId]);

  return (
    <div
      className="flex min-h-0 flex-col overflow-hidden rounded-md border"
      style={{ borderColor: "var(--app-border)", background: "var(--app-content-bg)" }}
    >
      <div
        className="flex h-7 shrink-0 items-center gap-1.5 border-b px-2"
        style={{ borderColor: "var(--app-border)" }}
      >
        <Star
          className="h-3 w-3 shrink-0"
          fill="currentColor"
          style={{ color: "var(--app-accent)" }}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{tile.title}</span>
        <span className="shrink-0 text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>
          {tile.layoutName}
        </span>
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] transition-colors hover:bg-[var(--app-hover)]"
          style={{ color: "var(--app-text-secondary)" }}
          onClick={() => onJump(tile.tabId)}
        >
          {t("starredPanelOpen")}
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {tile.sessionId ? (
          <TerminalView
            sessionId={tile.sessionId}
            projectPath={tile.projectPath}
            layoutActive={layoutVisible}
            visibilityOwnerId={tile.tabId}
            viewRole="mirror"
            drivesBackendPty={false}
            onSessionCreated={noop}
          />
        ) : (
          <div
            className="flex h-full items-center justify-center px-4 text-center text-xs"
            style={{ color: "var(--app-text-tertiary)" }}
          >
            {t("starredMirrorNoSession")}
          </div>
        )}
      </div>
    </div>
  );
}
