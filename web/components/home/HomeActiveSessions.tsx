// 首页「继续工作」里的活跃会话：跨所有布局收集带会话的标签，按「工作空间 → 会话」分组。
// 工作空间归属：标签自带 workspaceName → 布局绑定的 workspaceName → 按项目路径匹配，都没有归「未归属」。
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Terminal, Circle, FolderKanban } from "lucide-react";
import { focusTab } from "@/hooks/useFocusTab";
import { statusColorToken } from "@/lib/statusPresentation";
import { useDialogStore, usePanesStore, useTerminalStatusStore, useWorkspacesStore } from "@/stores";
import { asTabId } from "@/types/ids";
import { isBusyStatus, type PaneNode, type Tab, type TerminalStatusType, type Workspace } from "@/types";
import { Button } from "@/components/ui/button";

/** 每个工作空间最多列几条，其余折成「还有 N 个」。 */
const MAX_PER_GROUP = 5;

function getAllTabs(pane: PaneNode): Tab[] {
  if (pane.type === "panel") return pane.tabs;
  return pane.children.flatMap(getAllTabs);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function basename(path: string | undefined): string {
  return path?.split(/[/\\]/).filter(Boolean).pop() ?? "";
}

interface SessionGroup {
  key: string;
  label: string;
  tabs: Tab[];
  busy: number;
}

/** 按项目路径找工作空间：取最长前缀匹配，避免父目录工作空间抢走子项目。 */
function workspaceByPath(workspaces: readonly Workspace[], projectPath: string): Workspace | null {
  if (!projectPath) return null;
  const target = normalizePath(projectPath);
  let best: { workspace: Workspace; length: number } | null = null;
  for (const workspace of workspaces) {
    for (const project of workspace.projects) {
      if (project.archivedAt) continue;
      const root = normalizePath(project.path);
      if ((target === root || target.startsWith(`${root}/`)) && root.length > (best?.length ?? -1)) {
        best = { workspace, length: root.length };
      }
    }
  }
  return best?.workspace ?? null;
}

function statusRank(status: TerminalStatusType | null): number {
  if (isBusyStatus(status)) return 0;
  if (status === "waitingInput") return 1;
  return 2;
}

export default function HomeActiveSessions() {
  const { t } = useTranslation("home");
  const rootPane = usePanesStore((s) => s.rootPane);
  const layouts = usePanesStore((s) => s.layouts);
  const currentLayoutId = usePanesStore((s) => s.currentLayoutId);
  const statusMap = useTerminalStatusStore((s) => s.statusMap);
  const workspaces = useWorkspacesStore((s) => s.workspaces);

  const { groups, total } = useMemo(() => {
    // 当前布局的真源是 rootPane（layouts 里那份可能还没回写）；星标布局只放镜像，跳过免得重复。
    const current = layouts?.find((layout) => layout.id === currentLayoutId) ?? null;
    const trees: Array<{ root: PaneNode; workspaceName?: string }> = [
      { root: rootPane, workspaceName: current?.workspaceName },
      ...(layouts ?? [])
        .filter((layout) => layout.id !== currentLayoutId && layout.kind !== "starred")
        .map((layout) => ({ root: layout.rootPane, workspaceName: layout.workspaceName })),
    ];

    const byKey = new Map<string, SessionGroup>();
    const seen = new Set<string>();
    for (const { root, workspaceName: layoutWorkspace } of trees) {
      for (const tab of getAllTabs(root)) {
        if (!tab.sessionId || seen.has(tab.sessionId)) continue;
        seen.add(tab.sessionId);
        const named = tab.workspaceName ?? layoutWorkspace;
        const workspace =
          (named ? workspaces.find((candidate) => candidate.name === named) : undefined)
          ?? workspaceByPath(workspaces, tab.projectPath);
        const key = workspace?.name ?? named ?? "";
        const label = workspace ? workspace.alias || workspace.name : named || t("workbench.noWorkspace");
        let group = byKey.get(key);
        if (!group) {
          group = { key, label, tabs: [], busy: 0 };
          byKey.set(key, group);
        }
        group.tabs.push(tab);
        if (isBusyStatus(statusMap.get(tab.sessionId)?.status ?? null)) group.busy += 1;
      }
    }

    const rankOf = (tab: Tab) => statusRank(statusMap.get(tab.sessionId!)?.status ?? null);
    const sorted = [...byKey.values()]
      .map((group) => ({ ...group, tabs: [...group.tabs].sort((a, b) => rankOf(a) - rankOf(b)) }))
      // 有活在跑的工作空间排前面；「未归属」垫底。
      .sort((a, b) =>
        Number(a.key === "") - Number(b.key === "")
        || b.busy - a.busy
        || b.tabs.length - a.tabs.length);
    return { groups: sorted, total: seen.size };
  }, [currentLayoutId, layouts, rootPane, statusMap, t, workspaces]);

  const getStatusLabel = (status: TerminalStatusType | null): string => {
    if (isBusyStatus(status)) return t("running");
    if (status === "waitingInput") return t("waiting");
    return t("idle");
  };

  // 与首页「快速操作」的“新建终端”同一动作：打开启动器
  const handleNewTerminal = useCallback(() => {
    useDialogStore.getState().openLauncher();
  }, []);

  const heading = (
    <h3 className="mb-2 px-2 text-[length:var(--text-small)] font-medium text-[var(--app-text-secondary)]">
      {t("activeSessions")}
    </h3>
  );

  if (total === 0) {
    return (
      <div className="min-w-0">
        {heading}
        <div
          className="flex flex-col items-center justify-center gap-1 rounded-xl px-4 py-8 text-center"
          data-testid="home-active-sessions-empty"
        >
          <Terminal className="mb-1 size-6 text-[var(--app-text-tertiary)]" aria-hidden="true" />
          <p className="text-[length:var(--text-body)] text-[var(--app-text-secondary)]">{t("noActiveSessions")}</p>
          <p className="text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">{t("noActiveSessionsHint")}</p>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={handleNewTerminal}>
            {t("newTerminal")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      {heading}
      <div className="space-y-3">
        {groups.map((group) => (
          <section key={group.key || "__none"} data-testid="home-session-group" aria-label={group.label}>
            <div className="flex items-center gap-1.5 px-2 pb-1 text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">
              <FolderKanban className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-medium text-[var(--app-text-secondary)]">{group.label}</span>
              <span className="shrink-0 tabular-nums">{group.tabs.length}</span>
            </div>
            <ul>
              {group.tabs.slice(0, MAX_PER_GROUP).map((tab) => {
                const status = statusMap.get(tab.sessionId!)?.status ?? null;
                const project = basename(tab.projectPath);
                const title = tab.title || project || "Terminal";
                return (
                  <li key={tab.id}>
                    <button
                      type="button"
                      title={tab.projectPath || undefined}
                      className="home-session-item flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-home-surface-hover)]"
                      onClick={() => focusTab(asTabId(tab.id))}
                    >
                      <Circle
                        className={`size-2 shrink-0 ${isBusyStatus(status) ? "animate-pulse" : ""}`}
                        fill={statusColorToken(status)}
                        stroke="none"
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[length:var(--text-body)] text-[var(--app-text-primary)]">{title}</span>
                        {project && project !== title ? (
                          <span className="truncate text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">{project}</span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">
                        {getStatusLabel(status)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {group.tabs.length > MAX_PER_GROUP ? (
              <p className="px-2 pt-0.5 text-[length:var(--text-small)] tabular-nums text-[var(--app-text-tertiary)]">
                {t("workbench.more", { count: group.tabs.length - MAX_PER_GROUP })}
              </p>
            ) : null}
          </section>
        ))}
      </div>
      <p className="mt-2 px-2 text-[length:var(--text-small)] tabular-nums text-[var(--app-text-tertiary)]">
        {t("totalSessions", { count: total })}
      </p>
    </div>
  );
}
