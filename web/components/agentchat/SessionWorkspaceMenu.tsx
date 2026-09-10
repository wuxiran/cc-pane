// 会话顶栏的工作空间/目录 chip：复用 StartProjectMenu 的注册工作空间树；
// 选中后以新目录开新会话（不复用旧 session id——ACP resume 会无视新 cwd，
// 串上下文更糟），历史消息保留可回看，消息流插分隔通知。
// 从 AgentChatTabContent 拆出（行数棘轮）。
import { useCallback } from "react";
import { Layers } from "lucide-react";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { agentChatService } from "@/services/agentChatService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
import { samePath } from "./chatPaths";
import { loadAutoApproveKinds } from "./enginePrefs";
import StartProjectMenu, { workspaceLabelFor } from "./StartProjectMenu";

export interface SessionWorkspaceMenuProps {
  chatId: string;
  /** 当前会话生效的工作目录（空串不渲染 chip）。 */
  cwd: string;
  /** 生成中禁止切换（会话正忙，切换语义不清）。 */
  generating: boolean;
}

export default function SessionWorkspaceMenu({
  chatId,
  cwd,
  generating,
}: SessionWorkspaceMenuProps) {
  const { t } = useTranslation("panes");
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const label = workspaceLabelFor(cwd, workspaces);

  const switchWorkspace = useCallback(
    async (newCwd: string) => {
      if (!newCwd || samePath(newCwd, cwd)) return;
      const current = useAgentChatStore.getState().chats[chatId]?.snapshot;
      const name = workspaceLabelFor(newCwd, useWorkspacesStore.getState().workspaces);
      if (current) {
        const message = t("agentChatSwitchConfirm", { name });
        const ok = await confirmDialog(message, {
          title: t("agentChatSwitchConfirmTitle"),
          kind: "warning",
        }).catch(() => window.confirm(message));
        if (!ok) return;
      }
      useAgentChatStore.getState().setCwdOverride(chatId, newCwd);
      if (!current) return; // 未启动：启动页/欢迎态自行生效
      useAgentChatStore.getState().pushNotice(chatId, t("agentChatWorkspaceSwitched", { name }));
      void agentChatService
        .start(
          chatId,
          current.engineId,
          newCwd,
          undefined,
          current.autoApproveKinds ?? loadAutoApproveKinds(current.engineId),
        )
        .then((next) => useAgentChatStore.getState().setSnapshot(chatId, next))
        .catch((error) => {
          useAgentChatStore
            .getState()
            .pushNotice(chatId, error instanceof Error ? error.message : String(error));
        });
    },
    [chatId, cwd, t],
  );

  if (!cwd) return null;
  return (
    <StartProjectMenu
      cwd={cwd}
      onPickCwd={(picked) => void switchWorkspace(picked)}
      trigger={
        <button
          type="button"
          disabled={generating}
          title={cwd}
          aria-label={t("agentChatWorkspaceChipTip")}
          className="flex h-6 max-w-44 items-center gap-1 rounded-md border border-[var(--app-border)] bg-[var(--app-overlay)] px-1.5 text-[11px] text-[var(--app-text-secondary)] transition-colors hover:text-[var(--app-text-primary)] disabled:opacity-50"
        >
          <Layers className="h-3 w-3 shrink-0" />
          <span className="truncate">{label}</span>
        </button>
      }
    />
  );
}
