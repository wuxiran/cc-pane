// Web 访问页的编排器（orchestrator）配置块（从 WebAccessSection 拆出，行数棘轮约束）。
import { useTranslation } from "react-i18next";
import McpYoloProfilesToggle from "./McpYoloProfilesToggle";
import FollowAgentLaunchToggle from "./FollowAgentLaunchToggle";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isTauriRuntime } from "@/services/runtime";
import { useOrchestratorStatus } from "@/hooks/useOrchestratorStatus";
import type { OrchestratorBindMode, OrchestratorSettings } from "@/types";

const ORCHESTRATOR_BIND_MODES: OrchestratorBindMode[] = ["auto", "loopback", "all"];
// 旧配置可能残留已下线的 bindMode；直接拿它拼 i18n key 会把 key 原样渲染给用户。
const normalizeBindMode = (mode?: string) => ORCHESTRATOR_BIND_MODES.find((m) => m === mode) ?? "auto";

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
    <div className="flex flex-col gap-2 pt-3" style={{ borderTop: "1px solid var(--app-border)" }}>
      <div>
        <Label>{t("webAccessSection.orchestrator.title")}</Label>
        <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
          {t("webAccessSection.orchestrator.description")}
        </p>
      </div>
      <div className="flex items-center justify-between gap-6">
        <span className="text-[13px] text-[var(--app-text-secondary)]">
          {t("webAccessSection.orchestrator.bindMode")}
        </span>
        <Select
          value={normalizeBindMode(orchestrator.bindMode)}
          onValueChange={(next) =>
            onOrchestratorChange({ ...orchestrator, bindMode: next as OrchestratorBindMode })
          }
        >
          <SelectTrigger aria-label={t("webAccessSection.orchestrator.bindMode")} className="w-44 shrink-0 bg-[var(--app-content)] text-[13px]">
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
      </div>
      <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
        {t(`webAccessSection.orchestrator.bindModes.${normalizeBindMode(orchestrator.bindMode)}.hint`)}
      </p>
      <McpYoloProfilesToggle orchestrator={orchestrator} onChange={onOrchestratorChange} />
      <FollowAgentLaunchToggle orchestrator={orchestrator} onChange={onOrchestratorChange} />
      {orchestratorStatus?.bind && (
        <p className="text-xs m-0" style={{ color: "var(--app-text-secondary)" }}>
          {t("webAccessSection.orchestrator.currentListen", {
            address: `${orchestratorStatus.bind.host}${
              orchestratorStatus.port != null ? `:${orchestratorStatus.port}` : ""
            }`,
            reason: orchestratorStatus.bind.reason,
          })}
        </p>
      )}
      {orchestratorStatus && (
        <p className="text-xs m-0" style={{ color: "var(--app-text-secondary)" }}>
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
      )}
      {orchestratorStatus?.lastError && (
        <p
          className="text-xs m-0 whitespace-pre-wrap break-words"
          style={{ color: "var(--app-status-danger)" }}
        >
          {t("orchestratorStatus.lastError", { error: orchestratorStatus.lastError })}
        </p>
      )}
    </div>
  );
}
