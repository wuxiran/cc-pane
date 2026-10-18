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
  const switching = useAgentChatStore((state) => state.chats[chatId]?.setup?.pending ?? false);
  const label = workspaceLabelFor(cwd, workspaces);

  const switchWorkspace = useCallback(
    async (newCwd: string) => {
      const store = useAgentChatStore.getState();
      const current = store.chats[chatId]?.snapshot;
      if (!newCwd || samePath(newCwd, cwd) || generating || current?.phase === "generating") return;
      // 在确认弹窗之前抢锁：同一标签的两个选择/重挂载不能交错覆盖实际目录。
      const token = store.beginSetup(chatId);
      if (token === null) return;
      const name = workspaceLabelFor(newCwd, useWorkspacesStore.getState().workspaces);
      const ownsSetup = () => useAgentChatStore.getState().chats[chatId]?.setup?.token === token;
      try {
        if (current) {
          const message = t("agentChatSwitchConfirm", { name });
          const ok = await confirmDialog(message, {
            title: t("agentChatSwitchConfirmTitle"),
            kind: "warning",
          }).catch(() => window.confirm(message));
          if (!ok || !ownsSetup()) return;
          const next = await agentChatService.start(
            chatId, current.engineId, newCwd, undefined,
            current.autoApproveKinds ?? loadAutoApproveKinds(current.engineId),
          );
          if (!ownsSetup()) return;
          store.setSnapshot(chatId, next);
        }
        // 只有真正切换成功后才发布目录和成功提示；失败保留旧会话的实际目录。
        store.setCwdOverride(chatId, newCwd);
        if (current) store.pushNotice(chatId, t("agentChatWorkspaceSwitched", { name }));
      } catch (error) {
        if (ownsSetup()) store.pushNotice(chatId, error instanceof Error ? error.message : String(error));
      } finally {
        store.finishSetup(chatId, token);
      }
    },
    [chatId, cwd, generating, t],
  );

  if (!cwd) return null;
  return (
    <StartProjectMenu
      cwd={cwd}
      onPickCwd={(picked) => void switchWorkspace(picked)}
      trigger={
        <button
          type="button"
          disabled={generating || switching}
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
