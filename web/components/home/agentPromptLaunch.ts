// 首页「对 agent 说」的启动链路：目标目录解析 + 引擎偏好 + 开标签切工作区。
// 抽成独立模块供托盘「新建会话」（useTrayActions）复用同一调用路径。
import { setPendingStart } from "@/components/agentchat/pendingStart";
import { CONCIERGE_SYSTEM_PROMPT } from "@/components/onboarding/AgentConciergeEntry";
import { usePanesStore } from "@/stores";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import type { AcpEngineInfo } from "@/types/agentChat";
import type { Workspace } from "@/types";

const ENGINE_PREF_KEY = "ccpanes.home.agentEngine";

export function loadPreferredEngine(): string | null {
  try {
    return localStorage.getItem(ENGINE_PREF_KEY);
  } catch {
    return null;
  }
}

export function savePreferredEngine(engineId: string): void {
  try {
    localStorage.setItem(ENGINE_PREF_KEY, engineId);
  } catch {
    // 无持久化也不影响本次发送
  }
}

/** 默认目标：侧栏当前展开的项目 → 其所在工作空间的首个项目 → 任一项目 → 工作空间根目录。 */
export function resolveDefaultAgentCwd(
  workspaces: Workspace[],
  expandedWorkspaceId: string | null,
  expandedProjectId: string | null,
): string {
  const active = workspaces.filter((workspace) => !workspace.archivedAt);
  const expanded = active.find((workspace) => workspace.id === expandedWorkspaceId);
  const expandedProject = expanded?.projects.find(
    (project) => project.id === expandedProjectId && !project.archivedAt,
  );
  if (expandedProject) return expandedProject.path;
  const ordered = expanded ? [expanded, ...active.filter((w) => w !== expanded)] : active;
  for (const workspace of ordered) {
    const project = workspace.projects.find((item) => !item.archivedAt);
    if (project) return project.path;
  }
  for (const workspace of ordered) {
    if (!workspace.isDefault && workspace.path) return workspace.path;
  }
  return "";
}

/** 引擎选择：localStorage 偏好优先（须仍可用），否则首个可用引擎，再否则列表首项。 */
export function pickPreferredEngine(list: AcpEngineInfo[]): AcpEngineInfo | null {
  const preferred = loadPreferredEngine();
  const fallback = list.find((engine) => engine.available) ?? list[0] ?? null;
  return list.find((engine) => engine.id === preferred && engine.available) ?? fallback;
}

export interface AgentChatLaunchOptions {
  cwd: string;
  engineId?: string;
  firstPrompt?: string;
}

/**
 * 开 agent-chat 标签并切到工作区视图，返回新标签 id（失败为 null）。
 * engineId 与非空 firstPrompt 齐备时挂管家启动意图（首页回车路径）；缺一
 * （托盘新建，没有 prompt 可发）只开标签由引擎选择页接管——管家 preamble
 * 只能随首条 prompt 发出，不预挂，避免画面自称管家而引擎没收到角色指令。
 */
export function launchAgentChatSession({
  cwd,
  engineId,
  firstPrompt,
}: AgentChatLaunchOptions): string | null {
  const tabId = usePanesStore.getState().openAgentChat(cwd);
  if (!tabId) return null;
  const text = firstPrompt?.trim();
  if (engineId && text) {
    setPendingStart(tabId, {
      engineId,
      cwd,
      firstPrompt: text,
      preamble: CONCIERGE_SYSTEM_PROMPT,
    });
  }
  useActivityBarStore.getState().setAppViewMode("panes");
  return tabId;
}
