// Git 视图「让对话审阅」：切到右侧面板的对话视图，把「审阅未提交改动」的 prompt
// 预填进一个以该项目为工作目录的对话启动页。不自动发送——引擎/权限由用户在启动页确认，
// 一次误点不会直接拉起 agent 进程。
import i18n from "@/i18n";
import { setPendingDraft } from "@/components/agentchat/pendingDraft";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { useDockChatStore } from "@/stores/useDockChatStore";
import { useRightDockStore } from "@/stores/useRightDockStore";

export function dockChatReviewPrompt(projectName: string): string {
  return i18n.t("rightDock.reviewDiffPrompt", { ns: "sidebar", name: projectName });
}

/** 当前对话还停在启动页（没开聊、没在续接）才复用，否则另开一个，不打断进行中的对话。 */
function reusableStartChat(): string | null {
  const { chats, activeId } = useDockChatStore.getState();
  const entry = chats.find((chat) => chat.id === activeId);
  if (!entry || entry.acpSessionId) return null;
  const session = useAgentChatStore.getState().chats[entry.id];
  if (session?.snapshot || (session?.items.length ?? 0) > 0 || session?.setup?.pending || session?.pendingPrompt) return null;
  return entry.id;
}

export function askDockChatToReview(projectPath: string, projectName: string): string {
  const dock = useDockChatStore.getState();
  const reused = reusableStartChat();
  let chatId: string;
  if (reused) {
    chatId = reused;
    dock.select(reused);
    useAgentChatStore.getState().setCwdOverride(reused, projectPath);
  } else {
    chatId = dock.newChat(projectPath);
  }
  useRightDockStore.setState({ visible: true, activeView: "chat" });
  setPendingDraft(chatId, dockChatReviewPrompt(projectName));
  return chatId;
}
