import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { terminalService } from "@/services/terminalService";
import {
  TERMINAL_SCROLLBACK_MAX,
  TERMINAL_SCROLLBACK_MIN,
  normalizeTerminalScrollback,
} from "@/lib/terminalScrollback";
import type { ShellInfo, TerminalSettings } from "@/types";
import { SearchableSetting } from "./SettingsSearchContext";
import TerminalVisibilitySettings from "./TerminalVisibilitySettings";
import { SettingsRow, SettingsSection, SettingsSwitchRow } from "./layout";

interface TerminalSectionProps {
  value: TerminalSettings;
  onChange: (value: TerminalSettings) => void;
}

const AUTO_SHELL_VALUE = "__auto__";
const selectTriggerClass = "w-44 shrink-0 bg-[var(--app-content)] text-[length:var(--text-row)]";

/**
 * 卡片内的搜索锚点：SearchableSetting 会把锚点属性/高亮样式克隆到唯一子元素上，
 * 而 SettingsRow 不透传 data-*，所以包一层 div 承接（多行时自带发丝线分隔）。
 */
function RowAnchor({ sectionId, children }: { sectionId: string; children: ReactNode }) {
  return (
    <SearchableSetting sectionId={sectionId}>
      <div className="flex flex-col divide-y divide-[var(--app-border)]">{children}</div>
    </SearchableSetting>
  );
}

export default function TerminalSection({ value, onChange }: TerminalSectionProps) {
  const { t } = useTranslation("settings");
  const [shells, setShells] = useState<ShellInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    terminalService
      .getAvailableShells()
      .then((list) => {
        if (!cancelled) setShells(list);
      })
      .catch(() => {
        // 拿不到列表时保持空数组，UI 降级为文本输入
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function update<K extends keyof TerminalSettings>(key: K, v: TerminalSettings[K]) {
    onChange({ ...value, [key]: v });
  }

  // 当前值不在探测列表里（历史遗留的自定义路径等）也要保留为可选项，避免打开设置就把它冲掉
  const shellIsCustom = !!value.shell && !shells.some((s) => s.id === value.shell);
  const daemonEnabled = value.daemonEnabled ?? true;

  return (
    <>
      <SettingsSection title={t("terminalGroups.display")}>
        <RowAnchor sectionId="terminal-font">
          <SettingsRow
            title={t("fontSize")}
            htmlFor="terminal-font-size"
            control={(
              <Input
                id="terminal-font-size"
                type="number"
                min={10}
                max={32}
                step={1}
                className="w-24"
                value={value.fontSize}
                onChange={(e) => update("fontSize", Number(e.target.value))}
                onBlur={(e) => {
                  const next = Math.min(32, Math.max(10, Number(e.target.value) || 15));
                  if (next !== value.fontSize) update("fontSize", next);
                }}
              />
            )}
          />
          <SettingsRow
            title={t("fontFamily")}
            description={t("fontFamilyCjkHint")}
            htmlFor="terminal-font-family"
            control={(
              <Input
                id="terminal-font-family"
                className="w-56"
                value={value.fontFamily}
                onChange={(e) => update("fontFamily", e.target.value)}
              />
            )}
          />
        </RowAnchor>
        <SettingsRow
          title={t("terminalTheme")}
          htmlFor="terminal-theme-mode"
          control={(
            <Select value={value.themeMode ?? "followApp"} onValueChange={(next) => update("themeMode", next as TerminalSettings["themeMode"])}>
              <SelectTrigger id="terminal-theme-mode" aria-label={t("terminalTheme")} className={selectTriggerClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="followApp">{t("terminalThemeFollowApp")}</SelectItem>
                <SelectItem value="dark">{t("terminalThemeDark")}</SelectItem>
                <SelectItem value="light">{t("terminalThemeLight")}</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
        <SettingsRow
          title={t("cursorStyle")}
          htmlFor="terminal-cursor-style"
          control={(
            <Select value={value.cursorStyle} onValueChange={(next) => update("cursorStyle", next)}>
              <SelectTrigger id="terminal-cursor-style" aria-label={t("cursorStyle")} className={selectTriggerClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="block">{t("cursorBlock")}</SelectItem>
                <SelectItem value="underline">{t("cursorUnderline")}</SelectItem>
                <SelectItem value="bar">{t("cursorBar")}</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
        <SettingsSwitchRow
          id="terminal-cursor-blink"
          title={t("cursorBlink")}
          checked={value.cursorBlink}
          onCheckedChange={(checked) => update("cursorBlink", checked)}
        />
        <SettingsRow
          title={t("rendererMode")}
          description={t("rendererHint")}
          htmlFor="terminal-renderer-mode"
          control={(
            <Select value={value.rendererMode ?? "auto"} onValueChange={(next) => update("rendererMode", next as TerminalSettings["rendererMode"])}>
              <SelectTrigger id="terminal-renderer-mode" aria-label={t("rendererMode")} className={selectTriggerClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("rendererAuto")}</SelectItem>
                <SelectItem value="webgl">{t("rendererWebgl")}</SelectItem>
                <SelectItem value="dom">{t("rendererDom")}</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
      </SettingsSection>

      <TerminalVisibilitySettings value={value} onChange={onChange} />

      <SettingsSection title={t("terminalGroups.features")}>
        <RowAnchor sectionId="terminal-path-links">
          <SettingsSwitchRow
            id="terminal-path-links-enabled"
            title={t("pathLinksEnabled")}
            description={t("pathLinksEnabledHint")}
            checked={value.pathLinksEnabled ?? true}
            onCheckedChange={(checked) => update("pathLinksEnabled", checked)}
          />
        </RowAnchor>
        <RowAnchor sectionId="terminal-inline-images">
          <SettingsSwitchRow
            id="terminal-inline-images-enabled"
            title={t("inlineImagesEnabled")}
            description={t("inlineImagesEnabledHint")}
            checked={value.inlineImagesEnabled ?? false}
            onCheckedChange={(checked) => update("inlineImagesEnabled", checked)}
          />
        </RowAnchor>
        <RowAnchor sectionId="terminal-context-usage">
          <SettingsSwitchRow
            id="terminal-show-context-usage"
            title={t("showContextUsage")}
            description={t("showContextUsageHint")}
            checked={value.showContextUsage ?? true}
            onCheckedChange={(checked) => update("showContextUsage", checked)}
          />
        </RowAnchor>
        <RowAnchor sectionId="terminal-status-bar">
          <SettingsSwitchRow
            id="terminal-show-status-bar"
            title={t("showStatusBar")}
            description={t("showStatusBarHint")}
            checked={value.showStatusBar ?? true}
            onCheckedChange={(checked) => update("showStatusBar", checked)}
          />
        </RowAnchor>
        <RowAnchor sectionId="terminal-task-queue">
          <SettingsSwitchRow
            id="terminal-task-queue-enabled"
            title={t("taskQueueEnabled")}
            description={t("taskQueueEnabledHint")}
            checked={value.taskQueueEnabled ?? true}
            onCheckedChange={(checked) => update("taskQueueEnabled", checked)}
          />
        </RowAnchor>
        <RowAnchor sectionId="terminal-split-passthrough">
          <SettingsSwitchRow
            id="terminal-split-passthrough-enabled"
            title={t("splitShortcutPassthrough")}
            description={t("splitShortcutPassthroughHint")}
            checked={value.splitShortcutPassthrough ?? false}
            onCheckedChange={(checked) => update("splitShortcutPassthrough", checked)}
          />
        </RowAnchor>
      </SettingsSection>

      <SettingsSection title={t("terminalGroups.session")}>
        <RowAnchor sectionId="terminal-shell">
          <SettingsRow
            title="Shell"
            htmlFor="terminal-shell"
            control={shells.length > 0 ? (
              <Select value={value.shell ?? AUTO_SHELL_VALUE} onValueChange={(next) => update("shell", next === AUTO_SHELL_VALUE ? null : next)}>
                <SelectTrigger id="terminal-shell" aria-label="Shell" className={selectTriggerClass}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO_SHELL_VALUE}>{t("shellAutoDetect")}</SelectItem>
                  {shells.map((shell) => (
                    <SelectItem key={shell.id} value={shell.id}>{shell.name}</SelectItem>
                  ))}
                  {shellIsCustom && <SelectItem value={value.shell!}>{value.shell}</SelectItem>}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id="terminal-shell"
                className="w-44"
                value={value.shell ?? ""}
                onChange={(e) => update("shell", e.target.value || null)}
                placeholder={t("shellAutoDetect")}
              />
            )}
          />
        </RowAnchor>
        <SettingsRow
          title={t("scrollback")}
          htmlFor="terminal-scrollback"
          control={(
            <Input
              id="terminal-scrollback"
              type="number"
              className="w-32"
              min={TERMINAL_SCROLLBACK_MIN}
              max={TERMINAL_SCROLLBACK_MAX}
              value={value.scrollback}
              onChange={(e) => update("scrollback", Number(e.target.value))}
              onBlur={(e) => update("scrollback", normalizeTerminalScrollback(Number(e.target.value)))}
            />
          )}
        />
        <RowAnchor sectionId="terminal-auto-trust">
          <SettingsSwitchRow
            id="terminal-auto-trust"
            title={t("autoTrustRegisteredProjects")}
            description={t("autoTrustRegisteredProjectsHint")}
            checked={value.autoTrustRegisteredProjects ?? false}
            onCheckedChange={(checked) => update("autoTrustRegisteredProjects", checked)}
          />
        </RowAnchor>
        <SettingsSwitchRow
          id="terminal-auto-close-completed"
          title={t("autoCloseCompletedTasks")}
          description={t("autoCloseCompletedTasksHint")}
          checked={value.autoCloseCompletedTasks ?? false}
          onCheckedChange={(checked) => update("autoCloseCompletedTasks", checked)}
        />
        {/* lowerSessionPriority / sessionCpuWeight 的 UI 已搬到 PerformanceSection「会话资源策略」，存储位置不变 */}
        <SettingsSwitchRow
          id="terminal-daemon-enabled"
          title={t("terminalDaemon")}
          description={t("terminalDaemonHint")}
          checked={daemonEnabled}
          onCheckedChange={(checked) => update("daemonEnabled", checked)}
        />
      </SettingsSection>

      {/* 专家项：排障与 daemon 孤儿回收，平铺在页尾独立分区（不再折叠） */}
      <SettingsSection title={t("advancedSettings")}>
        <SettingsSwitchRow
          id="terminal-resume-id-backfill"
          title={t("resumeIdBackfill")}
          description={t("resumeIdBackfillHint")}
          checked={value.resumeIdBackfillEnabled ?? false}
          onCheckedChange={(checked) => update("resumeIdBackfillEnabled", checked)}
        />
        <SettingsSwitchRow
          id="terminal-daemon-orphan-reaper-disabled"
          title={t("daemonOrphanReaperDisabled")}
          description={t("daemonOrphanReaperDisabledHint")}
          checked={value.daemonOrphanReaperDisabled ?? false}
          disabled={!daemonEnabled}
          onCheckedChange={(checked) => update("daemonOrphanReaperDisabled", checked)}
        />
        <SettingsRow
          title={t("daemonOrphanTtl")}
          description={t("daemonOrphanTtlHint")}
          htmlFor="terminal-daemon-orphan-ttl"
          control={(
            <Input
              id="terminal-daemon-orphan-ttl"
              type="number"
              className="w-32"
              min={1}
              max={10080}
              step={1}
              value={value.daemonOrphanTtlMinutes ?? 1440}
              onChange={(e) => update("daemonOrphanTtlMinutes", Number(e.target.value))}
              onBlur={(e) => {
                const next = Math.min(10080, Math.max(1, Math.round(Number(e.target.value) || 1440)));
                if (next !== value.daemonOrphanTtlMinutes) update("daemonOrphanTtlMinutes", next);
              }}
              disabled={!daemonEnabled || (value.daemonOrphanReaperDisabled ?? false)}
            />
          )}
        />
      </SettingsSection>
    </>
  );
}
