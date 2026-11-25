/**
 * 设置 → 系统与连接 → "性能"（docs/107 W1）。
 *
 * 编辑 `settings.performance.*`；"会话资源策略" 分组里的两个控件
 * （`lowerSessionPriority` / `sessionCpuWeight`）仍存在 `settings.terminal.*`，
 * 只是 UI 从终端面板搬到这里，所以额外接 `terminal` / `onTerminalChange`。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { toastOk, toastWarn } from "@/lib/feedback";
import { invokeIfTauri } from "@/services/runtime";
import type { PerformanceSettings, TerminalSettings } from "@/types";
import { DEFAULT_PERFORMANCE_SETTINGS, PERFORMANCE_LIMITS } from "@/types";
import { NullableNumberRow, NumberRow, ToggleRow } from "./PerformanceSectionFields";
import { SearchableSetting } from "./SettingsSearchContext";
import { SettingsRow, SettingsSection, SettingsSwitchRow } from "./layout";

interface PerformanceSectionProps {
  value: PerformanceSettings;
  onChange: (value: PerformanceSettings) => void;
  terminal: TerminalSettings;
  onTerminalChange: (value: TerminalSettings) => void;
}

/** 会话 CPU 权重：1..=9，5 为中性（存成 null = 不设）。 */
const CPU_WEIGHT_MIN = 1;
const CPU_WEIGHT_MAX = 9;
const CPU_WEIGHT_NEUTRAL = 5;

export default function PerformanceSection({ value, onChange, terminal, onTerminalChange }: PerformanceSectionProps) {
  const { t } = useTranslation("settings");
  const [clearingLedger, setClearingLedger] = useState(false);
  const d = DEFAULT_PERFORMANCE_SETTINGS;

  function update<K extends keyof PerformanceSettings>(key: K, v: PerformanceSettings[K]) {
    onChange({ ...value, [key]: v });
  }

  function updateTerminal<K extends keyof TerminalSettings>(key: K, v: TerminalSettings[K]) {
    onTerminalChange({ ...terminal, [key]: v });
  }

  async function clearLedger() {
    setClearingLedger(true);
    try {
      // 命令由后端 W3 提供；旧版本 / Web 运行时拿不到就提示不可用，不阻塞面板。
      const result = await invokeIfTauri<unknown>("clear_heavy_commands");
      if (result === undefined) toastWarn(t("performance.heavyLedgerClearUnavailable"));
      else toastOk(t("performance.heavyLedgerCleared"));
    } catch {
      toastWarn(t("performance.heavyLedgerClearUnavailable"));
    } finally {
      setClearingLedger(false);
    }
  }

  const cpuWeight = terminal.sessionCpuWeight ?? CPU_WEIGHT_NEUTRAL;

  return (
    <>
      <SearchableSetting sectionId="performance-build">
        {/* 性能与其他分区同处「系统」页，页标题覆盖不到它：首段标题带上分区名「性能」。 */}
        <SettingsSection
          title={`${t("performance.title")} · ${t("performance.buildGroup")}`}
          description={t("performance.description")}
        >
          <ToggleRow
            id="performance-build-parallelism-enabled"
            label={t("performance.buildParallelismEnabled")}
            hint={t("performance.buildParallelismEnabledHint")}
            checked={value.buildParallelismEnabled}
            onCheckedChange={(checked) => update("buildParallelismEnabled", checked)}
          />
          <NullableNumberRow
            id="performance-build-jobs"
            label={t("performance.buildJobs")}
            hint={t("performance.buildJobsHint")}
            value={value.buildJobs}
            limits={PERFORMANCE_LIMITS.buildJobs}
            disabled={!value.buildParallelismEnabled}
            onChange={(next) => update("buildJobs", next)}
          />
          <NullableNumberRow
            id="performance-rg-threads"
            label={t("performance.rgThreads")}
            hint={t("performance.rgThreadsHint")}
            value={value.rgThreads}
            limits={PERFORMANCE_LIMITS.rgThreads}
            disabled={!value.buildParallelismEnabled}
            onChange={(next) => update("rgThreads", next)}
          />
        </SettingsSection>
      </SearchableSetting>

      <SearchableSetting sectionId="performance-codex">
        <SettingsSection title={t("performance.codexGroup")}>
          <ToggleRow
            id="performance-codex-lightweight-enabled"
            label={t("performance.codexLightweightEnabled")}
            hint={t("performance.codexLightweightEnabledHint")}
            checked={value.codexLightweightEnabled}
            onCheckedChange={(checked) => update("codexLightweightEnabled", checked)}
          />
          <ToggleRow
            id="performance-codex-low-spec-mode"
            label={t("performance.codexLowSpecMode")}
            hint={t("performance.codexLowSpecModeHint")}
            checked={value.codexLowSpecMode}
            onCheckedChange={(checked) => update("codexLowSpecMode", checked)}
          />
        </SettingsSection>
      </SearchableSetting>

      <SearchableSetting sectionId="performance-heavy-gate">
        <SettingsSection title={t("performance.heavyGateGroup")}>
          <ToggleRow
            id="performance-heavy-gate-enabled"
            label={t("performance.heavyGateEnabled")}
            hint={t("performance.heavyGateEnabledHint")}
            checked={value.heavyGateEnabled}
            onCheckedChange={(checked) => update("heavyGateEnabled", checked)}
          />
          <NullableNumberRow
            id="performance-heavy-gate-slots"
            label={t("performance.heavyGateSlots")}
            hint={t("performance.heavyGateSlotsHint")}
            value={value.heavyGateSlots}
            limits={PERFORMANCE_LIMITS.heavyGateSlots}
            disabled={!value.heavyGateEnabled}
            onChange={(next) => update("heavyGateSlots", next)}
          />
          <NumberRow
            id="performance-heavy-gate-timeout-secs"
            label={t("performance.heavyGateTimeoutSecs")}
            hint={t("performance.heavyGateTimeoutSecsHint")}
            value={value.heavyGateTimeoutSecs}
            limits={PERFORMANCE_LIMITS.heavyGateTimeoutSecs}
            fallback={d.heavyGateTimeoutSecs}
            suffix={t("performance.unitSeconds")}
            disabled={!value.heavyGateEnabled}
            onChange={(next) => update("heavyGateTimeoutSecs", next)}
          />
        </SettingsSection>
      </SearchableSetting>

      <SearchableSetting sectionId="performance-heavy-ledger">
        <SettingsSection title={t("performance.heavyLedgerGroup")}>
          <ToggleRow
            id="performance-heavy-ledger-enabled"
            label={t("performance.heavyLedgerEnabled")}
            hint={t("performance.heavyLedgerEnabledHint")}
            checked={value.heavyLedgerEnabled}
            onCheckedChange={(checked) => update("heavyLedgerEnabled", checked)}
          />
          <SettingsRow
            title={t("performance.heavyLedgerClear")}
            description={t("performance.heavyLedgerClearHint")}
            control={(
              <Button variant="outline" size="sm" disabled={clearingLedger} onClick={() => void clearLedger()}>
                {t("performance.heavyLedgerClear")}
              </Button>
            )}
          />
        </SettingsSection>
      </SearchableSetting>

      <SearchableSetting sectionId="performance-session-policy">
        <SettingsSection title={t("performance.sessionPolicyGroup")}>
          <SettingsSwitchRow
            id="terminal-lower-session-priority"
            title={t("lowerSessionPriority")}
            description={t("lowerSessionPriorityHint")}
            checked={terminal.lowerSessionPriority ?? true}
            onCheckedChange={(checked) => updateTerminal("lowerSessionPriority", checked)}
          />
          <SettingsRow
            title={t("performance.sessionCpuWeight")}
            description={t("performance.sessionCpuWeightHint")}
            control={(
              <span className="flex items-center gap-3">
                <Slider
                  id="terminal-session-cpu-weight"
                  aria-label={t("performance.sessionCpuWeight")}
                  className="w-44"
                  min={CPU_WEIGHT_MIN}
                  max={CPU_WEIGHT_MAX}
                  step={1}
                  value={[cpuWeight]}
                  onValueChange={([next]) =>
                    updateTerminal("sessionCpuWeight", next === CPU_WEIGHT_NEUTRAL ? null : next)
                  }
                />
                <span className="whitespace-nowrap text-right text-[length:var(--text-small)] tabular-nums text-[var(--app-text-secondary)]">
                  {cpuWeight === CPU_WEIGHT_NEUTRAL
                    ? t("performance.sessionCpuWeightNeutral", { value: cpuWeight })
                    : cpuWeight}
                </span>
              </span>
            )}
          />
        </SettingsSection>
      </SearchableSetting>

      <SearchableSetting sectionId="performance-wsl-quota">
        <SettingsSection title={t("performance.wslQuotaGroup")}>
          <ToggleRow
            id="performance-wsl-quota-enabled"
            label={t("performance.wslQuotaEnabled")}
            hint={t("performance.wslQuotaEnabledHint")}
            checked={value.wslQuotaEnabled}
            onCheckedChange={(checked) => update("wslQuotaEnabled", checked)}
          />
          <NumberRow
            id="performance-wsl-cpu-weight"
            label={t("performance.wslCpuWeight")}
            hint={t("performance.wslCpuWeightHint")}
            value={value.wslCpuWeight}
            limits={PERFORMANCE_LIMITS.wslCpuWeight}
            fallback={d.wslCpuWeight}
            disabled={!value.wslQuotaEnabled}
            onChange={(next) => update("wslCpuWeight", next)}
          />
          <NumberRow
            id="performance-wsl-memory-high-percent"
            label={t("performance.wslMemoryHighPercent")}
            hint={t("performance.wslMemoryHighPercentHint")}
            value={value.wslMemoryHighPercent}
            limits={PERFORMANCE_LIMITS.wslMemoryHighPercent}
            fallback={d.wslMemoryHighPercent}
            suffix="%"
            disabled={!value.wslQuotaEnabled}
            onChange={(next) => update("wslMemoryHighPercent", next)}
          />
        </SettingsSection>
      </SearchableSetting>

      <SearchableSetting sectionId="performance-parking">
        <SettingsSection title={t("performance.parkingGroup")}>
          <NumberRow
            id="performance-parked-terminal-limit"
            label={t("performance.parkedTerminalLimit")}
            hint={t("performance.parkedTerminalLimitHint")}
            value={value.parkedTerminalLimit}
            limits={PERFORMANCE_LIMITS.parkedTerminalLimit}
            fallback={d.parkedTerminalLimit}
            onChange={(next) => update("parkedTerminalLimit", next)}
          />
          <NumberRow
            id="performance-park-delay-secs"
            label={t("performance.parkDelaySecs")}
            hint={t("performance.parkDelaySecsHint")}
            value={value.parkDelaySecs}
            limits={PERFORMANCE_LIMITS.parkDelaySecs}
            fallback={d.parkDelaySecs}
            suffix={t("performance.unitSeconds")}
            onChange={(next) => update("parkDelaySecs", next)}
          />
        </SettingsSection>
      </SearchableSetting>
    </>
  );
}
