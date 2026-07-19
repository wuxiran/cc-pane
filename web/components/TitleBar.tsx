import {
  Check,
  ChevronDown,
  Minus,
  Square,
  Copy,
  PanelLeft,
  PanelLeftClose,
  Settings,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useActivityBarStore,
  useBorderlessStore,
  useDialogStore,
  useWorkspacesStore,
} from "@/stores";
import { useWindowControl } from "@/hooks/useWindowControl";
import type { WorkspaceProject } from "@/types";

// 项目没有独立 name 字段：显示别名，否则取路径最后一段
function projectDisplayName(project: WorkspaceProject): string {
  if (project.alias) return project.alias;
  const parts = project.path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || project.path;
}

interface TitleBarProps {
  workspaceName?: string;
}

const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
// Linux/WebKitGTK 原生支持 -webkit-app-region，但对 drag 区域内的 no-drag 子区域
// 识别有缺陷：父级标题栏设为 drag 后，右上角窗口控制按钮（关闭/最小化/最大化）
// 会收不到点击事件（Ubuntu 上表现为点关闭按钮没反应）。因此 Linux 下不使用
// -webkit-app-region，改为仅依赖 data-tauri-drag-region 实现拖拽（其按 target
// 命中判断，不会拦截按钮点击）。参考同类 Linux WebKit 适配 isLinuxWebKitImeEnvironment。
const isLinux = navigator.platform.toUpperCase().indexOf("LINUX") >= 0;

export default function TitleBar({ workspaceName }: TitleBarProps) {
  const { t } = useTranslation("common");
  const { t: tSidebar } = useTranslation("sidebar");
  const isBorderless = useBorderlessStore((s) => s.isBorderless);
  const sidebarVisible = useActivityBarStore((s) => s.sidebarVisible);
  const toggleSidebar = useActivityBarStore((s) => s.toggleSidebar);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const expandedWorkspaceId = useWorkspacesStore((s) => s.expandedWorkspaceId);
  const expandedProjectId = useWorkspacesStore((s) => s.expandedProjectId);
  const expandWorkspace = useWorkspacesStore((s) => s.expandWorkspace);
  const expandProject = useWorkspacesStore((s) => s.expandProject);
  const openSettings = useDialogStore((s) => s.openSettings);
  const {
    closeWindow,
    minimizeWindow,
    maximizeWindow,
    toggleFullscreenWindow,
    isMaximized,
    startDrag,
  } = useWindowControl();

  // 无边框模式时隐藏标题栏
  if (isBorderless) return null;

  const currentWorkspace = workspaces.find((ws) => ws.id === expandedWorkspaceId);
  const visibleWorkspaces = workspaces.filter((ws) => !ws.hidden);
  const currentProject =
    currentWorkspace?.projects.find((p) => p.id === expandedProjectId) ?? null;
  const workspaceLabel =
    currentWorkspace?.alias || currentWorkspace?.name || workspaceName || "CC-Panes";
  const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

  return (
    <div
      className="relative flex items-center h-[38px] shrink-0 select-none z-10"
      data-tauri-drag-region=""
      style={{
        paddingLeft: isMac ? 78 : 12,
        paddingRight: 12,
        background: "var(--app-menubar)",
        borderBottom: "1px solid var(--app-border)",
        backdropFilter: `blur(var(--app-glass-blur))`,
        WebkitBackdropFilter: `blur(var(--app-glass-blur))`,
        // Linux 下省略 -webkit-app-region（详见文件顶部 isLinux 说明），避免吞掉窗口控制按钮的点击
        ...(isLinux ? {} : { WebkitAppRegion: "drag" }),
      } as React.CSSProperties}
    >
      {/* 顶部高光线 */}
      <div
        className="absolute top-0 left-0 right-0 h-px pointer-events-none"
        style={{
          background: "var(--app-titlebar-highlight)",
        }}
      />

      {/* 中间：居中应用名（纯装饰，点击穿透到拖拽区） */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 flex justify-center"
      >
        <span
          className="text-[12px] tracking-wide"
          style={{ color: "var(--app-text-tertiary)" }}
        >
          CC-Panes{import.meta.env.DEV ? " [DEV]" : ""}
        </span>
      </div>

      {/* 左侧：工作区 / 项目 面包屑（下拉直切，联动侧栏展开状态） */}
      <div
        className="flex items-center gap-1 shrink-0 min-w-0"
        style={noDrag}
        onDoubleClick={(e) => {
          e.preventDefault();
          toggleFullscreenWindow();
        }}
      >
        <span
          aria-hidden="true"
          className="mr-1 h-3 w-3 shrink-0 rounded-[3px]"
          style={{ background: "var(--app-accent)", boxShadow: "var(--hi)" }}
        />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("switchWorkspace")}
              className="flex min-w-0 items-center gap-1 rounded-[5px] px-2 py-1 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)]"
            >
              <span
                className="truncate max-w-[220px] text-[13px] font-semibold"
                style={{ color: "var(--app-text-primary)" }}
              >
                {workspaceLabel}
              </span>
              {visibleWorkspaces.length > 0 && (
                <ChevronDown
                  className="h-3 w-3 shrink-0"
                  style={{ color: "var(--app-text-tertiary)" }}
                />
              )}
            </button>
          </DropdownMenuTrigger>
          {visibleWorkspaces.length > 0 && (
            <DropdownMenuContent align="start" className="min-w-[180px]">
              {visibleWorkspaces.map((ws) => (
                <DropdownMenuItem
                  key={ws.id}
                  onSelect={() => expandWorkspace(ws.id)}
                  className="flex items-center gap-2 text-[12.5px]"
                >
                  <span className="flex-1 truncate">{ws.alias || ws.name}</span>
                  {ws.id === expandedWorkspaceId && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-[var(--app-accent)]" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          )}
        </DropdownMenu>

        {currentWorkspace && currentWorkspace.projects.length > 0 && (
          <>
            <span className="text-[12px]" style={{ color: "var(--app-text-tertiary)" }}>
              /
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("switchProject")}
                  className="flex min-w-0 items-center gap-1 rounded-[5px] px-2 py-1 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)]"
                >
                  <span
                    className="truncate max-w-[200px] text-[13px]"
                    style={{
                      color: currentProject
                        ? "var(--app-text-primary)"
                        : "var(--app-text-tertiary)",
                      fontWeight: currentProject ? 600 : 400,
                    }}
                  >
                    {currentProject ? projectDisplayName(currentProject) : t("selectProject")}
                  </span>
                  <ChevronDown
                    className="h-3 w-3 shrink-0"
                    style={{ color: "var(--app-text-tertiary)" }}
                  />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[180px]">
                {currentWorkspace.projects.map((project) => (
                  <DropdownMenuItem
                    key={project.id}
                    onSelect={() => expandProject(project.id)}
                    className="flex items-center gap-2 text-[12.5px]"
                  >
                    <span className="flex-1 truncate">{projectDisplayName(project)}</span>
                    {project.id === expandedProjectId && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-[var(--app-accent)]" />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}

        {/* 侧栏折叠开关：必须显式 no-drag，否则 Linux/WebKitGTK 会吞掉拖拽区内的点击（见文件顶部说明） */}
        <IconTooltipButton
          data-testid="titlebar-toggle-sidebar"
          label={sidebarVisible ? tSidebar("collapseSidebar") : tSidebar("expandSidebar")}
          side="bottom"
          className="ml-1 h-[26px] w-[26px] shrink-0 rounded-[5px] p-0"
          style={noDrag}
          onClick={toggleSidebar}
        >
          {sidebarVisible ? (
            <PanelLeftClose className="h-[15px] w-[15px]" strokeWidth={1.5} />
          ) : (
            <PanelLeft className="h-[15px] w-[15px]" strokeWidth={1.5} />
          )}
        </IconTooltipButton>
      </div>

      {/* 中间：拖拽区 */}
      <div
        data-testid="titlebar-drag-spacer"
        className="flex-1 h-full cursor-grab"
        onMouseDown={(e) => {
          if (e.button === 0 && e.target === e.currentTarget) {
            if (e.detail >= 2) {
              e.preventDefault();
              toggleFullscreenWindow();
              return;
            }
            e.preventDefault();
            startDrag();
          }
        }}
      />

      {/* 右侧：工具按钮 + 窗口控件 */}
      <div className="flex items-center shrink-0" style={noDrag}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={t("settings", { defaultValue: "Settings" })}
              className="w-[32px] h-[28px] mr-1 flex items-center justify-center rounded-[4px] transition-colors duration-[var(--dur-fast)] text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)]"
              onClick={openSettings}
            >
              <Settings className="w-[13px] h-[13px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("settings", { defaultValue: "Settings" })}</TooltipContent>
        </Tooltip>
      </div>

      {/* 窗口控件（macOS 使用原生红绿灯，不需要自定义按钮） */}
      {!isMac && (
        <div className="flex items-center -mr-1 shrink-0" style={noDrag}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label={t("minimize")}
                className="w-[36px] h-[30px] flex items-center justify-center rounded-[4px] transition-colors duration-[var(--dur-fast)] text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)]"
                onClick={minimizeWindow}
              >
                <Minus className="w-[13px] h-[13px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("minimize")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label={isMaximized ? t("restoreWindow") : t("maximize")}
                className="w-[36px] h-[30px] flex items-center justify-center rounded-[4px] transition-colors duration-[var(--dur-fast)] text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)]"
                onClick={maximizeWindow}
              >
                {isMaximized ? <Copy className="w-3 h-3" /> : <Square className="w-3 h-3" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{isMaximized ? t("restoreWindow") : t("maximize")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label={t("close")}
                className="w-[36px] h-[30px] flex items-center justify-center rounded-[4px] transition-colors duration-[var(--dur-fast)] text-[var(--app-text-secondary)] hover:bg-[var(--app-close-btn-hover-bg)] hover:text-[var(--app-close-btn-hover-fg)]"
                onClick={closeWindow}
              >
                <X className="w-[13px] h-[13px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("close")}</TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
