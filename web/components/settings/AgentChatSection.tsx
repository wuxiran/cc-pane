// 设置 → 工具 → Agent Chat：引擎相关偏好（镜像 cc-panes-core AgentChatSettings）。
// 「Codex 始终使用 ACP 兼容模式」由后端在启动「Codex」新会话时读取，已有会话不受影响。
import { useTranslation } from "react-i18next";
import type { AgentChatSettings } from "@/types/settings";
import { SettingsSection, SettingsSwitchRow } from "./layout";

interface AgentChatSectionProps {
  value: AgentChatSettings;
  onChange: (value: AgentChatSettings) => void;
}

export default function AgentChatSection({ value, onChange }: AgentChatSectionProps) {
  const { t } = useTranslation("settings");
  return (
    <SettingsSection>
      <SettingsSwitchRow
        id="agent-chat-codex-force-acp"
        title={t("agentChat.codexForceAcp")}
        description={t("agentChat.codexForceAcpDesc")}
        checked={value.codexForceAcp}
        onCheckedChange={(checked) => onChange({ ...value, codexForceAcp: checked === true })}
      />
    </SettingsSection>
  );
}
