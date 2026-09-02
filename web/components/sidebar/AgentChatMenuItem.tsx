// 侧栏「新建 Agent 对话」菜单项（工作空间/项目右键共用）。
// ACP 结构化对话标签落进分屏区；用户此刻可能在 Files/Todo 视图——切回
// panes 才看得见。注意它不属于「CLI 启动方式」家族，调用方应把它放在
// 「隐藏非常用菜单」条件块之外，保证永远可见。
import { MessagesSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { useActivityBarStore, usePanesStore } from "@/stores";

export default function AgentChatMenuItem({ path }: { path?: string | null }) {
  const { t } = useTranslation(["sidebar"]);
  return (
    <ContextMenuItem
      disabled={!path}
      onClick={() => {
        if (!path) return;
        usePanesStore.getState().openAgentChat(path);
        useActivityBarStore.getState().setAppViewMode("panes");
      }}
    >
      <MessagesSquare /> {t("newAgentChat")}
    </ContextMenuItem>
  );
}
