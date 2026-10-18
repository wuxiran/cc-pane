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
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { toastOk, toastWarn } from "@/lib/feedback";
import { invokeIfTauri } from "@/services/runtime";
import type { PerformanceSettings, TerminalSettings } from "@/types";
import { DEFAULT_PERFORMANCE_SETTINGS, PERFORMANCE_LIMITS } from "@/types";
import {
  GroupTitle,
  Hint,
  NullableNumberRow,
  NumberRow,
  ToggleRow,
} from "./PerformanceSectionFields";
import { SearchableSetting } from "./SettingsSearchContext";

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
    <div className="flex flex-col gap-3">
      <h3 className="text-[15px] font-semibold mb-1" style={{ color: "var(--app-text-primary)" }}>
        {t("performance.title")}
      </h3>
      <Hint>{t("performance.description")}</Hint>

      <SearchableSetting sectionId="performance-build">
        <div className="flex flex-col gap-3">
          <GroupTitle>{t("performance.buildGroup")}</GroupTitle>
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
        </div>
      </SearchableSetting>

      <SearchableSetting sectionId="performance-codex">
        <div className="flex flex-col gap-3">
          <GroupTitle>{t("performance.codexGroup")}</GroupTitle>
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
        </div>
      </SearchableSetting>

      <SearchableSetting sectionId="performance-heavy-gate">
        <div className="flex flex-col gap-3">
          <GroupTitle>{t("performance.heavyGateGroup")}</GroupTitle>
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
        </div>
      </SearchableSetting>

      <SearchableSetting sectionId="performance-heavy-ledger">
        <div className="flex flex-col gap-3">
          <GroupTitle>{t("performance.heavyLedgerGroup")}</GroupTitle>
          <ToggleRow
            id="performance-heavy-ledger-enabled"
            label={t("performance.heavyLedgerEnabled")}
            hint={t("performance.heavyLedgerEnabledHint")}
            checked={value.heavyLedgerEnabled}
            onCheckedChange={(checked) => update("heavyLedgerEnabled", checked)}
          />
          <div className="flex items-center justify-between gap-6">
            <Hint>{t("performance.heavyLedgerClearHint")}</Hint>
            <Button variant="outline" size="sm" disabled={clearingLedger} onClick={() => void clearLedger()}>
              {t("performance.heavyLedgerClear")}
            </Button>
          </div>
        </div>
      </SearchableSetting>

      <SearchableSetting sectionId="performance-session-policy">
        <div className="flex flex-col gap-3">
          <GroupTitle>{t("performance.sessionPolicyGroup")}</GroupTitle>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <input
                id="terminal-lower-session-priority"
                type="checkbox"
                aria-label={t("lowerSessionPriority")}
                checked={terminal.lowerSessionPriority ?? true}
                onChange={(e) => updateTerminal("lowerSessionPriority", e.target.checked)}
                className="w-4 h-4 cursor-pointer"
                style={{ accentColor: "var(--app-accent)" }}
              />
              <Label htmlFor="terminal-lower-session-priority">{t("lowerSessionPriority")}</Label>
            </div>
            <Hint>{t("lowerSessionPriorityHint")}</Hint>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-6">
              <Label htmlFor="terminal-session-cpu-weight">{t("performance.sessionCpuWeight")}</Label>
              <span className="text-[12px] tabular-nums" style={{ color: "var(--app-text-secondary)" }}>
                {cpuWeight === CPU_WEIGHT_NEUTRAL
                  ? t("performance.sessionCpuWeightNeutral", { value: cpuWeight })
                  : cpuWeight}
              </span>
            </div>
            <Slider
              id="terminal-session-cpu-weight"
              aria-label={t("performance.sessionCpuWeight")}
              min={CPU_WEIGHT_MIN}
              max={CPU_WEIGHT_MAX}
              step={1}
              value={[cpuWeight]}
              onValueChange={([next]) =>
                updateTerminal("sessionCpuWeight", next === CPU_WEIGHT_NEUTRAL ? null : next)
              }
            />
            <Hint>{t("performance.sessionCpuWeightHint")}</Hint>
          </div>
        </div>
      </SearchableSetting>

      <SearchableSetting sectionId="performance-wsl-quota">
        <div className="flex flex-col gap-3">
          <GroupTitle>{t("performance.wslQuotaGroup")}</GroupTitle>
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
        </div>
      </SearchableSetting>

      <SearchableSetting sectionId="performance-parking">
        <div className="flex flex-col gap-3">
          <GroupTitle>{t("performance.parkingGroup")}</GroupTitle>
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
        </div>
      </SearchableSetting>
    </div>
  );
}
