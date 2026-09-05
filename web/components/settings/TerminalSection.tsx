import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { terminalService } from "@/services/terminalService";
import {
  TERMINAL_SCROLLBACK_MAX,
  TERMINAL_SCROLLBACK_MIN,
  normalizeTerminalScrollback,
} from "@/lib/terminalScrollback";
import type { ShellInfo, TerminalSettings } from "@/types";
import { SearchableSetting } from "./SettingsSearchContext";
import AdvancedSettings from "./AdvancedSettings";

interface TerminalSectionProps {
  value: TerminalSettings;
  onChange: (value: TerminalSettings) => void;
}

const AUTO_SHELL_VALUE = "__auto__";

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

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[15px] font-semibold mb-1" style={{ color: "var(--app-text-primary)" }}>
        {t("terminalTitle")}
      </h3>

      <SearchableSetting sectionId="terminal-font">
        <div className="space-y-2">
          <div className="flex gap-2 items-end">
            <FormField label={t("fontSize")} className="flex flex-col gap-1 w-28">
              {({ id }) => (
                <Input
                  id={id}
                  type="number"
                  min={10}
                  max={32}
                  step={1}
                  value={value.fontSize}
                  onChange={(e) => update("fontSize", Number(e.target.value))}
                  onBlur={(e) => {
                    const next = Math.min(32, Math.max(10, Number(e.target.value) || 15));
                    if (next !== value.fontSize) update("fontSize", next);
                  }}
                />
              )}
            </FormField>
            <FormField label={t("fontFamily")} className="flex flex-col gap-1 flex-1">
              {({ id }) => (
                <Input id={id} value={value.fontFamily} onChange={(e) => update("fontFamily", e.target.value)} />
              )}
            </FormField>
          </div>
          <p className="text-[12px]" style={{ color: "var(--app-text-secondary)" }}>
            {t("fontFamilyCjkHint")}
          </p>
        </div>
      </SearchableSetting>

      <div className="flex items-center justify-between gap-6">
        <Label htmlFor="terminal-theme-mode">{t("terminalTheme")}</Label>
        <Select value={value.themeMode ?? "followApp"} onValueChange={(next) => update("themeMode", next as TerminalSettings["themeMode"])}>
          <SelectTrigger id="terminal-theme-mode" aria-label={t("terminalTheme")} className="w-44 shrink-0 bg-[var(--app-content)] text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="followApp">{t("terminalThemeFollowApp")}</SelectItem>
            <SelectItem value="dark">{t("terminalThemeDark")}</SelectItem>
            <SelectItem value="light">{t("terminalThemeLight")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between gap-6">
        <Label htmlFor="terminal-cursor-style">{t("cursorStyle")}</Label>
        <div className="flex items-center gap-4">
          <Select value={value.cursorStyle} onValueChange={(next) => update("cursorStyle", next)}>
            <SelectTrigger id="terminal-cursor-style" aria-label={t("cursorStyle")} className="w-44 shrink-0 bg-[var(--app-content)] text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="block">{t("cursorBlock")}</SelectItem>
              <SelectItem value="underline">{t("cursorUnderline")}</SelectItem>
              <SelectItem value="bar">{t("cursorBar")}</SelectItem>
            </SelectContent>
          </Select>
          <label className="flex items-center gap-2 text-[13px] text-[var(--app-text-secondary)]">
            {t("cursorBlink")}
            <input
              type="checkbox"
              checked={value.cursorBlink}
              onChange={(e) => update("cursorBlink", e.target.checked)}
              className="w-4 h-4 cursor-pointer"
              style={{ accentColor: "var(--app-accent)" }}
            />
          </label>
        </div>
      </div>

      <div className="flex items-center justify-between gap-6">
        <Label htmlFor="terminal-scrollback">{t("scrollback")}</Label>
        <div className="w-44 shrink-0">
          <Input
            id="terminal-scrollback"
            type="number"
            min={TERMINAL_SCROLLBACK_MIN}
            max={TERMINAL_SCROLLBACK_MAX}
            value={value.scrollback}
            onChange={(e) => update("scrollback", Number(e.target.value))}
            onBlur={(e) =>
              update("scrollback", normalizeTerminalScrollback(Number(e.target.value)))
            }
          />
        </div>
      </div>

      <SearchableSetting sectionId="terminal-shell">
      <div className="flex items-center justify-between gap-6">
        <Label htmlFor="terminal-shell">Shell</Label>
        <div className="w-44 shrink-0">
          {shells.length > 0 ? (
            <Select value={value.shell ?? AUTO_SHELL_VALUE} onValueChange={(next) => update("shell", next === AUTO_SHELL_VALUE ? null : next)}>
              <SelectTrigger id="terminal-shell" aria-label="Shell" className="w-full bg-[var(--app-content)] text-[13px]">
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
              value={value.shell ?? ""}
              onChange={(e) => update("shell", e.target.value || null)}
              placeholder={t("shellAutoDetect")}
            />
          )}
        </div>
      </div>
      </SearchableSetting>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-6">
          <Label htmlFor="terminal-renderer-mode">{t("rendererMode")}</Label>
          <Select value={value.rendererMode ?? "auto"} onValueChange={(next) => update("rendererMode", next as TerminalSettings["rendererMode"])}>
            <SelectTrigger id="terminal-renderer-mode" aria-label={t("rendererMode")} className="w-44 shrink-0 bg-[var(--app-content)] text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t("rendererAuto")}</SelectItem>
              <SelectItem value="webgl">{t("rendererWebgl")}</SelectItem>
              <SelectItem value="dom">{t("rendererDom")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
          {t("rendererHint")}
        </p>
      </div>

      <SearchableSetting sectionId="terminal-path-links">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor="terminal-path-links-enabled">{t("pathLinksEnabled")}</Label>
            <p className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
              {t("pathLinksEnabledHint")}
            </p>
          </div>
          <Switch
            id="terminal-path-links-enabled"
            aria-label={t("pathLinksEnabled")}
            checked={value.pathLinksEnabled ?? true}
            onCheckedChange={(checked) => update("pathLinksEnabled", checked)}
          />
        </div>
      </SearchableSetting>

      <SearchableSetting sectionId="terminal-context-usage">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <input
              id="terminal-show-context-usage"
              type="checkbox"
              aria-label={t("showContextUsage")}
              checked={value.showContextUsage ?? true}
              onChange={(e) => update("showContextUsage", e.target.checked)}
              className="h-4 w-4 cursor-pointer"
              style={{ accentColor: "var(--app-accent)" }}
            />
            <Label htmlFor="terminal-show-context-usage">{t("showContextUsage")}</Label>
          </div>
          <p className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
            {t("showContextUsageHint")}
          </p>
        </div>
      </SearchableSetting>

      <SearchableSetting sectionId="terminal-status-bar">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <input
              id="terminal-show-status-bar"
              type="checkbox"
              aria-label={t("showStatusBar")}
              checked={value.showStatusBar ?? true}
              onChange={(e) => update("showStatusBar", e.target.checked)}
              className="h-4 w-4 cursor-pointer"
              style={{ accentColor: "var(--app-accent)" }}
            />
            <Label htmlFor="terminal-show-status-bar">{t("showStatusBar")}</Label>
          </div>
          <p className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
            {t("showStatusBarHint")}
          </p>
        </div>
      </SearchableSetting>

      <SearchableSetting sectionId="terminal-task-queue">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor="terminal-task-queue-enabled">{t("taskQueueEnabled")}</Label>
            <p className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
              {t("taskQueueEnabledHint")}
            </p>
          </div>
          <Switch
            id="terminal-task-queue-enabled"
            aria-label={t("taskQueueEnabled")}
            checked={value.taskQueueEnabled ?? true}
            onCheckedChange={(checked) => update("taskQueueEnabled", checked)}
          />
        </div>
      </SearchableSetting>

      <SearchableSetting sectionId="terminal-split-passthrough">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor="terminal-split-passthrough-enabled">{t("splitShortcutPassthrough")}</Label>
            <p className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
              {t("splitShortcutPassthroughHint")}
            </p>
          </div>
          <Switch
            id="terminal-split-passthrough-enabled"
            aria-label={t("splitShortcutPassthrough")}
            checked={value.splitShortcutPassthrough ?? false}
            onCheckedChange={(checked) => update("splitShortcutPassthrough", checked)}
          />
        </div>
      </SearchableSetting>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <input
            id="terminal-lower-session-priority"
            type="checkbox"
            checked={value.lowerSessionPriority ?? true}
            onChange={(e) => update("lowerSessionPriority", e.target.checked)}
            className="w-4 h-4 cursor-pointer"
            style={{ accentColor: "var(--app-accent)" }}
          />
          <Label htmlFor="terminal-lower-session-priority">{t("lowerSessionPriority")}</Label>
        </div>
        <p className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
          {t("lowerSessionPriorityHint")}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <input
            id="terminal-daemon-enabled"
            type="checkbox"
            checked={value.daemonEnabled ?? true}
            onChange={(e) => update("daemonEnabled", e.target.checked)}
            className="w-4 h-4 cursor-pointer"
            style={{ accentColor: "var(--app-accent)" }}
          />
          <Label htmlFor="terminal-daemon-enabled">{t("terminalDaemon")}</Label>
        </div>
        <p className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
          {t("terminalDaemonHint")}
        </p>
      </div>

      <AdvancedSettings>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <input
              id="terminal-resume-id-backfill"
              type="checkbox"
              checked={value.resumeIdBackfillEnabled ?? false}
              onChange={(e) => update("resumeIdBackfillEnabled", e.target.checked)}
              className="w-4 h-4 cursor-pointer"
              style={{ accentColor: "var(--app-accent)" }}
            />
            <Label htmlFor="terminal-resume-id-backfill">{t("resumeIdBackfill")}</Label>
          </div>
          <p className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
            {t("resumeIdBackfillHint")}
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <input
              id="terminal-daemon-orphan-reaper-disabled"
              type="checkbox"
              checked={value.daemonOrphanReaperDisabled ?? false}
              onChange={(e) => update("daemonOrphanReaperDisabled", e.target.checked)}
              className="w-4 h-4 cursor-pointer"
              style={{ accentColor: "var(--app-accent)" }}
              disabled={!(value.daemonEnabled ?? true)}
            />
            <Label htmlFor="terminal-daemon-orphan-reaper-disabled">{t("daemonOrphanReaperDisabled")}</Label>
          </div>
          <p className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
            {t("daemonOrphanReaperDisabledHint")}
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <FormField label={t("daemonOrphanTtl")} className="flex flex-col gap-1 w-40">
            {({ id }) => (
              <Input
                id={id}
                type="number"
                min={1}
                max={10080}
                step={1}
                value={value.daemonOrphanTtlMinutes ?? 1440}
                onChange={(e) => update("daemonOrphanTtlMinutes", Number(e.target.value))}
                onBlur={(e) => {
                  const next = Math.min(10080, Math.max(1, Math.round(Number(e.target.value) || 1440)));
                  if (next !== value.daemonOrphanTtlMinutes) update("daemonOrphanTtlMinutes", next);
                }}
                disabled={!(value.daemonEnabled ?? true) || (value.daemonOrphanReaperDisabled ?? false)}
              />
            )}
          </FormField>
          <p className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
            {t("daemonOrphanTtlHint")}
          </p>
        </div>
      </AdvancedSettings>
    </div>
  );
}
