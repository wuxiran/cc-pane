// 设备与访问页的编排器（orchestrator / MCP 端点）配置段（从 WebAccessSection 拆出，行数棘轮约束）。
import { useTranslation } from "react-i18next";
import McpYoloProfilesToggle from "./McpYoloProfilesToggle";
import FollowAgentLaunchToggle from "./FollowAgentLaunchToggle";
import OrchestratorTokenRotateRow from "./OrchestratorTokenRotateRow";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isTauriRuntime } from "@/services/runtime";
import { useOrchestratorStatus } from "@/hooks/useOrchestratorStatus";
import type { OrchestratorBindMode, OrchestratorSettings } from "@/types";
import { SettingsBlock, SettingsRow, SettingsSection } from "./layout";

const ORCHESTRATOR_BIND_MODES: OrchestratorBindMode[] = ["auto", "loopback", "all"];
// 旧配置可能残留已下线的 bindMode；直接拿它拼 i18n key 会把 key 原样渲染给用户。
const normalizeBindMode = (mode?: string) => ORCHESTRATOR_BIND_MODES.find((m) => m === mode) ?? "auto";
const BIND_MODE_ID = "web-access-orchestrator-bind-mode";
const STATUS_LINE_CLASS = "m-0 text-[length:var(--text-small)] leading-5";

interface WebAccessOrchestratorBlockProps {
  orchestrator?: OrchestratorSettings;
  onOrchestratorChange?: (value: OrchestratorSettings) => void;
}

export default function WebAccessOrchestratorBlock({
  orchestrator,
  onOrchestratorChange,
}: WebAccessOrchestratorBlockProps) {
  const { t } = useTranslation("settings");
  const orchestratorStatus = useOrchestratorStatus();

  if (!orchestrator || !onOrchestratorChange || !isTauriRuntime()) return null;

  return (
    <SettingsSection
      sectionId="web-access-orchestrator"
      title={t("webAccessSection.orchestrator.title")}
      description={t("webAccessSection.orchestrator.description")}
    >
      <SettingsRow
        title={t("webAccessSection.orchestrator.bindMode")}
        description={t(`webAccessSection.orchestrator.bindModes.${normalizeBindMode(orchestrator.bindMode)}.hint`)}
        htmlFor={BIND_MODE_ID}
        control={(
          <Select
            value={normalizeBindMode(orchestrator.bindMode)}
            onValueChange={(next) =>
              onOrchestratorChange({ ...orchestrator, bindMode: next as OrchestratorBindMode })
            }
          >
            <SelectTrigger
              id={BIND_MODE_ID}
              aria-label={t("webAccessSection.orchestrator.bindMode")}
              className="w-44 shrink-0 bg-[var(--app-content)] text-[length:var(--text-row)]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ORCHESTRATOR_BIND_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {t(`webAccessSection.orchestrator.bindModes.${mode}.label`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      />
      <McpYoloProfilesToggle orchestrator={orchestrator} onChange={onOrchestratorChange} />
      <FollowAgentLaunchToggle orchestrator={orchestrator} onChange={onOrchestratorChange} />
      <OrchestratorTokenRotateRow />
      {orchestratorStatus && (
        <SettingsBlock className="flex flex-col gap-1 py-3">
          {orchestratorStatus.bind && (
            <p className={STATUS_LINE_CLASS} style={{ color: "var(--app-text-secondary)" }}>
              {t("webAccessSection.orchestrator.currentListen", {
                address: `${orchestratorStatus.bind.host}${
                  orchestratorStatus.port != null ? `:${orchestratorStatus.port}` : ""
                }`,
                reason: orchestratorStatus.bind.reason,
              })}
            </p>
          )}
          <p className={STATUS_LINE_CLASS} style={{ color: "var(--app-text-secondary)" }}>
            {t("orchestratorStatus.summary", {
              lifecycle:
                orchestratorStatus.lifecycle === "binding"
                  ? t("orchestratorStatus.binding")
                  : orchestratorStatus.lifecycle === "ready"
                    ? t("orchestratorStatus.ready")
                    : t("orchestratorStatus.failed"),
            })}
            {orchestratorStatus.attempt != null
              ? ` · ${t("orchestratorStatus.attempt", { attempt: orchestratorStatus.attempt })}`
              : ""}
            {orchestratorStatus.nextRetryAt != null
              ? ` · ${t("orchestratorStatus.nextRetry", {
                  time: new Date(orchestratorStatus.nextRetryAt).toLocaleTimeString(),
                })}`
              : ""}
          </p>
          {orchestratorStatus.lastError && (
            <p className={`${STATUS_LINE_CLASS} whitespace-pre-wrap break-words`} style={{ color: "var(--app-status-danger)" }}>
              {t("orchestratorStatus.lastError", { error: orchestratorStatus.lastError })}
            </p>
          )}
        </SettingsBlock>
      )}
    </SettingsSection>
  );
}
