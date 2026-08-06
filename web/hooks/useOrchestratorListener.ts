/**
 * Orchestrator 事件监听 Hook
 *
 * 监听后端 Orchestrator 事件：
 * - orchestrator-launch-task: 自动创建新标签页并连接 PTY 会话
 * - orchestrator-open-folder: 文件浏览器导航到目录
 * - orchestrator-open-file: 编辑器打开文件标签
 * - orchestrator-open-browser-tab: 打开浏览器标签
 * - orchestrator-close-file: 关闭编辑器标签
 * - orchestrator-query-open-files: 查询已打开文件并响应
 * - orchestrator-query-panes: 查询当前面板布局并响应
 */
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { toast } from "sonner";
import i18n from "@/i18n";
import { nextLaunchId } from "@/components/panes/terminalLaunchIdentity";
import {
  usePanesStore,
  useActivityBarStore,
  useFileBrowserStore,
  useEditorTabsStore,
  useSettingsStore,
} from "@/stores";
import { isTauriRuntime } from "@/services/runtime";
import { computeGlobalTabNumbers } from "@/lib/tabNumbering";
import { collectPanels } from "@/stores/paneTreeHelpers";
import { resolveWorkspaceLaunchLayout } from "@/utils/layoutWorkspace";
import {
  notifyOpenedInOtherLayout,
  resolveBrowserPlacement,
  resolveCallerPlacement,
} from "./orchestratorOpenRouting";

import type { CliTool, LaunchProviderSelection, SshConnectionInfo, WslLaunchInfo } from "@/types";

interface OrchestratorLaunchPayload {
  taskId: string;
  sessionId: string;
  projectPath: string;
  projectId: string;
  workspaceName?: string;
  providerId?: string;
  modelId?: string;
  providerSelection?: LaunchProviderSelection;
  launchProfileId?: string;
  workspacePath?: string;
  title?: string;
  resumeId?: string;  // 对应 Rust OrchestratorLaunchEvent.resume_id
  paneId?: string;
  layoutId?: string;
  layoutName?: string;
  cliTool?: string;
  runtimeKind?: string;
  runtimeSource?: string;
  notice?: string;
  wsl?: WslLaunchInfo;
  ssh?: SshConnectionInfo;
  /**
   * 新会话落位方式（后端 launch_task 的 placement 参数）：
   * `"beside"`（默认，调用者 pane 旁边分屏）| `"tab"` / `"background"`（调用者 pane 标签页）。
   */
  placement?: string;
  /**
   * Caller's pty_session_id when this launch was triggered by another
   * cc-panes-managed Claude via MCP `launch_task`. Used by the frontend to
   * resolve a `parentTabId` for hierarchical numbering (#N.M).
   */
  parentSessionId?: string;
}

export function useOrchestratorListener() {
  useEffect(() => {
    if (!isTauriRuntime()) return;

    const unlisteners: (() => void)[] = [];

    // 1. launch-task 事件
    getCurrentWebview()
      .listen<OrchestratorLaunchPayload>(
        "orchestrator-launch-task",
        (event) => {
          const {
            sessionId,
            projectPath,
            projectId,
            workspaceName,
            providerId,
            modelId,
            providerSelection,
            launchProfileId,
            workspacePath,
            title,
            paneId: targetPaneId,
            layoutId: targetLayoutId,
            layoutName: targetLayoutName,
            cliTool: rawCliTool,
            wsl,
            ssh,
          } = event.payload;

          console.info(
            "[Orchestrator] Received launch-task event:",
            event.payload
          );

          if (!projectPath?.trim()) {
            console.warn("[Orchestrator] Ignoring launch-task without projectPath:", event.payload);
            toast.error(i18n.t("orchestratorLaunchProjectPathMissing", { ns: "panes" }));
            return;
          }

          const placement = event.payload.placement;
          // silent：调用方明确要求完全不打扰（不切布局、不切视图、不弹提示）
          const silent = placement === "silent";
          // 默认不跟随 agent 启动跳布局——leader 每派一个 worker 就把用户弹回
          // leader 所在布局，是最招人烦的行为。想要旧行为的人打开这个开关。
          const followAgentLaunch =
            useSettingsStore.getState().settings?.orchestrator?.followAgentLaunch === true;

          const requestedLayoutName = targetLayoutName?.trim();
          const requestedLayoutId = targetLayoutId?.trim();
          let latestPanesStore = usePanesStore.getState();
          let hasExplicitLayout = false;
          // 由工作空间绑定推导出的落点（非用户/调用方点名），见下方 resolver 注释。
          let autoRoutedLayout = false;
          // 目标布局：先只**解析**，不切换。窗格要建在这里，但当前视图不一定要跟过去。
          let targetLayout: string | undefined;

          if (requestedLayoutId && latestPanesStore.listLayouts().some((layout) => layout.id === requestedLayoutId)) {
            hasExplicitLayout = true;
            targetLayout = requestedLayoutId;
          } else if (requestedLayoutName) {
            const existingLayout = latestPanesStore
              .listLayouts()
              .find((layout) => layout.name.trim() === requestedLayoutName);
            const layoutId = existingLayout?.id ?? latestPanesStore.createLayout(requestedLayoutName);
            hasExplicitLayout = true;
            latestPanesStore = usePanesStore.getState();
            // 自动新建的布局带 workspaceName 时直接建立绑定；已存在的布局不覆盖其既有绑定
            if (!existingLayout && workspaceName?.trim()) {
              latestPanesStore.bindLayoutWorkspace(layoutId, workspaceName);
            }
            targetLayout = layoutId;
          }

          latestPanesStore = usePanesStore.getState();

          // 解析父 tab（按 sessionId 在所有面板里搜）。一旦找到，记下它所在的
          // panel.id —— 这是决定子 tab 落到哪个 panel 的关键，不能等到目标
          // pane 已经确定。否则在 split-pane 下子 tab 会落到 active pane，
          // 与父分家，computeTabNumbers 会把它当成孤儿 → 层级编号失效。
          const parentSessionId = event.payload.parentSessionId;
          let parentTabId: string | undefined;
          let parentPaneId: string | undefined;
          if (parentSessionId) {
            const parentLocation = latestPanesStore.findTabBySessionAcrossLayouts(parentSessionId);
            if (parentLocation) {
              if (!hasExplicitLayout) {
                targetLayout = parentLocation.layoutId;
              }
              // 父在别的布局而调用方又点名了布局时，不能拿父 pane 当落点
              if (parentLocation.layoutId === (targetLayout ?? latestPanesStore.currentLayoutId)) {
                parentTabId = parentLocation.tab.id;
                parentPaneId = parentLocation.panel.id;
              }
            }
          }

          // 无显式布局且无调用者 pane 命中时，按 workspaceName 落位。
          //
          // 优先级链是「显式 layoutId/layoutName > 父会话所在 pane > 本分支」，
          // 顺序不能动：leader 派 worker 时 parentSessionId 由 orchestrator 从
          // caller_launch_id 反查得出、几乎必然命中，worker 必须落在 leader 所在
          // 布局——这是 computeTabNumbers 层级编号 #N.M 的前提（见上方注释）。
          // 把「当前布局」提到父会话之前会直接打断编号与 leader/worker 并排可见。
          //
          // 因此本分支实际只对「无父会话的外部/headless 调用」生效。这种场景下
          // 「当前布局」就是用户此刻正看着的画面，故用 resolveWorkspaceLaunchLayout：
          // 当前布局未绑定就不抢跳（比无条件跳到 lastActiveAt 最近的绑定布局更不
          // 侵入），仅在当前布局绑了别的工作空间/是星标时才自动路由。
          if (!hasExplicitLayout && !parentPaneId && workspaceName?.trim()) {
            // resolver 保留（比 findLayoutForWorkspace 精细：当前布局未绑定就不路由），
            // 但**只记落点、不切布局**——切与不切统一交给下方那处判定（显式布局 /
            // 跟随开关 / silent），避免在这里抢走用户正看着的画面。
            const boundLayout = resolveWorkspaceLaunchLayout(
              latestPanesStore.listLayouts(),
              latestPanesStore.currentLayoutId,
              workspaceName,
            );
            if (boundLayout) {
              targetLayout = boundLayout.id;
              // resolver 只在「当前布局绑着别的工作空间 / 是星标」时才给出不同布局
              // ——那种情况下当前布局本就不是这个工作空间的家，切过去不算抢用户画面。
              // 当前布局未绑定或就是本工作空间时它返回当前布局，此处自然不置位。
              autoRoutedLayout = boundLayout.id !== latestPanesStore.currentLayoutId;
            }
          }

          const resolvedCliTool = (rawCliTool || "claude") as CliTool;
          const tabOpts = {
            projectId,
            // 每次新生成，绝不复用 projectId——复用已被上次 PTY 占用的 launch id
            // 会让 bind_pty_session 落空、resume id 永久丢失（docs/69）
            launchId: nextLaunchId(),
            projectPath,
            sessionId,           // 后端已创建的 PTY session，避免前端重复创建
            resumeId: event.payload.resumeId,
            workspaceName,
            providerId,
            modelId,
            providerSelection,
            launchProfileId,
            workspacePath,
            cliTool: resolvedCliTool,
            wsl,
            ssh,
            customTitle: title,
            parentTabId,
          };

          // 落位策略：
          //   1. 显式 paneId（MCP 调用方传入具体 pane）→ 作为该 pane 的标签落位。
          //   2. 有调用者 pane（parentPaneId）且未显式要求 tab → 在**调用者 pane 旁边分屏并聚焦**，
          //      让 launch 起的新会话拿到自己的窗格、跟调用者并排可见（默认，修「后台标签」问题）。
          //   3. placement === "tab"/"background"，或无调用者（外部/layoutName 启动）→ 落到
          //      基准 pane 的标签页（旧行为）。基准 pane：父 panel 优先于 active，保证层级编号 #N.M。
          const wantsTab = placement === "tab" || placement === "background";

          let explicitPaneId: string | undefined;
          if (targetPaneId) {
            const targetPaneLocation = latestPanesStore.findPaneAcrossLayouts(targetPaneId);
            if (targetPaneLocation) {
              targetLayout = targetPaneLocation.layoutId;
              if (targetPaneLocation.pane.type === "panel") {
                explicitPaneId = targetPaneLocation.pane.id;
              }
            }
          }

          // 只有「调用方点名了布局」（显式意图）或用户开了跟随开关才切过去；silent 一律不切。
          const resolvedLayoutId = targetLayout ?? latestPanesStore.currentLayoutId;
          if (
            !silent
            && resolvedLayoutId !== latestPanesStore.currentLayoutId
            && (followAgentLaunch || hasExplicitLayout || autoRoutedLayout)
          ) {
            latestPanesStore.switchLayout(resolvedLayoutId);
            latestPanesStore = usePanesStore.getState();
          }

          // 落位用的布局：与当前布局不同时必须显式传给 store，否则会插进「用户正在看的」布局。
          // 切换过之后这里自然为 undefined。
          const writeLayoutId =
            resolvedLayoutId === latestPanesStore.currentLayoutId ? undefined : resolvedLayoutId;

          // 会话就落在眼前这个布局时才保证 panes 视图可见；落到别处就别把用户
          // 从文件/设置视图里拽出来。
          if (!writeLayoutId && !silent) {
            const activityBar = useActivityBarStore.getState();
            if (activityBar.appViewMode !== "panes") {
              activityBar.setAppViewMode("panes");
            }
          }

          const targetLayoutEntry = latestPanesStore
            .listLayouts()
            .find((layout) => layout.id === resolvedLayoutId);
          // 目标布局的基准 pane（非当前布局时 activePane() 指的是别人家的树）
          const fallbackPaneId = targetLayoutEntry?.activePaneId ?? targetLayoutEntry?.rootPane.id;

          if (explicitPaneId || targetPaneId) {
            const paneId = explicitPaneId ?? parentPaneId ?? fallbackPaneId;
            if (paneId) latestPanesStore.addTab(paneId, tabOpts, writeLayoutId);
          } else if (parentPaneId && !wantsTab) {
            latestPanesStore.openSessionBesidePane(parentPaneId, "auto", tabOpts, writeLayoutId);
          } else {
            const basePaneId = parentPaneId ?? fallbackPaneId;
            if (basePaneId) latestPanesStore.addTab(basePaneId, tabOpts, writeLayoutId);
          }

          // 落到别的布局时给一条可点击跳转的提示——不跳但也别让人找不到
          if (writeLayoutId && !silent && targetLayoutEntry) {
            toast.info(
              i18n.t("orchestratorLaunchedInLayout", {
                ns: "panes",
                layout: targetLayoutEntry.name,
              }),
              {
                action: {
                  label: i18n.t("orchestratorLaunchedInLayoutGoto", { ns: "panes" }),
                  onClick: () => {
                    usePanesStore.getState().switchLayout(writeLayoutId);
                    useActivityBarStore.getState().setAppViewMode("panes");
                  },
                },
              },
            );
          }

          const notice = event.payload.notice?.trim();
          if (notice) {
            toast.info(notice);
          }
        }
      )
      .then((fn) => unlisteners.push(fn));

    // 2. open-folder 事件
    getCurrentWebview()
      .listen<{ path: string }>("orchestrator-open-folder", (event) => {
        console.info(
          "[Orchestrator] Received open-folder event:",
          event.payload
        );
        useFileBrowserStore.getState().navigateTo(event.payload.path);
        const activity = useActivityBarStore.getState();
        if (activity.appViewMode !== "files") {
          activity.toggleFilesMode();
        }
      })
      .then((fn) => unlisteners.push(fn));

    // 3. open-file 事件
    getCurrentWebview()
      .listen<{
        filePath: string;
        projectPath: string;
        title: string;
        callerSessionId?: string;
      }>(
        "orchestrator-open-file",
        (event) => {
          const { filePath, projectPath, title } = event.payload;
          console.info(
            "[Orchestrator] Received open-file event:",
            event.payload
          );
          // 在分屏区作为 editor tab 打开（与终端并列），去重聚焦由 openEditor 负责；
          // 布局落点跟随调用方所在布局，解析不出才回落当前布局。
          const caller = resolveCallerPlacement(event.payload.callerSessionId);
          const landedLayoutId = usePanesStore
            .getState()
            .openEditor(projectPath, filePath, title, caller?.layoutId);
          notifyOpenedInOtherLayout(landedLayoutId, title);
        }
      )
      .then((fn) => unlisteners.push(fn));

    // 4. close-file 事件
    getCurrentWebview()
      .listen<{ filePath: string }>("orchestrator-close-file", (event) => {
        console.info(
          "[Orchestrator] Received close-file event:",
          event.payload
        );
        // 分屏区的 editor tab（跨全部布局）
        usePanesStore.getState().closeEditorTabsByPath(event.payload.filePath);
        // Files 视图的编辑器 tab（旧入口打开的文件）
        const store = useEditorTabsStore.getState();
        const tab = store.tabs.find(
          (t) => t.filePath === event.payload.filePath
        );
        if (tab) {
          store.closeTab(tab.id);
        }
      })
      .then((fn) => unlisteners.push(fn));

    // 5. open-browser-tab 事件
    getCurrentWebview()
      .listen<{
        requestId?: string;
        tabId: string;
        url: string;
        title?: string;
        paneId?: string;
        reuse?: boolean;
        callerSessionId?: string;
      }>("orchestrator-open-browser-tab", async (event) => {
        const panes = usePanesStore.getState();
        const { layoutId, paneId, landedLayoutId } = resolveBrowserPlacement(event.payload);
        const activity = useActivityBarStore.getState();
        // 只有落在用户眼前的布局才切回分屏视图；否则切过去也看不到这次打开
        if (landedLayoutId === panes.currentLayoutId && activity.appViewMode !== "panes") {
          activity.setAppViewMode("panes");
        }
        const actualTabId = usePanesStore.getState().openBrowser(
          event.payload.url,
          event.payload.title,
          event.payload.tabId,
          // 旧后端不带 paneId/reuse：reuse 缺失按 true 处理（复用是更安全的默认）
          { paneId, reuse: event.payload.reuse !== false, layoutId },
        );
        notifyOpenedInOtherLayout(landedLayoutId, event.payload.title || event.payload.url);
        if (event.payload.requestId) {
          await invoke("respond_orchestrator_query", {
            requestId: event.payload.requestId,
            data: JSON.stringify({ tabId: actualTabId }),
          }).catch((e: unknown) =>
            console.error("[Orchestrator] respond browser tab failed:", e)
          );
        }
      })
      .then((fn) => unlisteners.push(fn));

    // 6. query-open-files 事件
    getCurrentWebview()
      .listen<{ requestId: string }>(
        "orchestrator-query-open-files",
        async (event) => {
          console.info(
            "[Orchestrator] Received query-open-files event:",
            event.payload
          );
          const store = useEditorTabsStore.getState();
          const files = store.tabs.map((t) => ({
            filePath: t.filePath,
            projectPath: t.projectPath,
            title: t.title,
            dirty: t.dirty,
            pinned: t.pinned ?? false,
            active: t.id === store.activeTabId,
          }));
          // 分屏区的 editor tab（跨全部布局）也计入
          files.push(...usePanesStore.getState().listEditorTabsAcrossLayouts());
          const data = JSON.stringify({ files, total: files.length });
          await invoke("respond_orchestrator_query", {
            requestId: event.payload.requestId,
            data,
          }).catch((e: unknown) =>
            console.error("[Orchestrator] respond query failed:", e)
          );
        }
      )
      .then((fn) => unlisteners.push(fn));

    // 7. query-panes 事件
    getCurrentWebview()
      .listen<{ requestId: string }>(
        "orchestrator-query-panes",
        async (event) => {
          console.info(
            "[Orchestrator] Received query-panes event:",
            event.payload
          );
          const panesStore = usePanesStore.getState();
          const currentLayoutId = panesStore.currentLayoutId;
          const layouts = panesStore.listLayouts().map((layout) => {
            const panels = collectPanels(layout.rootPane);
            const tabNumbers = computeGlobalTabNumbers(layout.rootPane);
            const panes = panels.map((p) => ({
              paneId: p.id,
              layoutId: layout.id,
              tabCount: p.tabs.length,
              isActive: layout.id === currentLayoutId && p.id === layout.activePaneId,
              tabs: p.tabs.map((t) => ({
                id: t.id,
                displayNumber: tabNumbers.get(t.id) ?? null,
                title: t.title,
                contentType: t.contentType,
                projectPath: t.projectPath,
                sessionId: t.sessionId,
              })),
            }));
            return {
              id: layout.id,
              name: layout.name,
              isCurrent: layout.id === currentLayoutId,
              activePaneId: layout.activePaneId,
              panes,
              total: panes.length,
            };
          });
          const currentLayout = layouts.find((layout) => layout.id === currentLayoutId);
          const panes = currentLayout?.panes ?? [];
          const total = panes.length;
          const data = JSON.stringify({
            panes,
            total,
            layouts,
            currentLayoutId,
            layoutCount: layouts.length,
          });
          await invoke("respond_orchestrator_query", {
            requestId: event.payload.requestId,
            data,
          }).catch((e: unknown) =>
            console.error("[Orchestrator] respond query-panes failed:", e)
          );
        }
      )
      .then((fn) => unlisteners.push(fn));

    return () => {
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, []);
}
