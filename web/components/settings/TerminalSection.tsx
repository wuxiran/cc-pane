import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { terminalService } from "@/services/terminalService";
import type { ShellInfo, TerminalSettings } from "@/types";
import { SearchableSetting } from "./SettingsSearchContext";

interface TerminalSectionProps {
  value: TerminalSettings;
  onChange: (value: TerminalSettings) => void;
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

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[15px] font-semibold mb-1" style={{ color: "var(--app-text-primary)" }}>
        {t("terminalTitle")}
      </h3>

      <SearchableSetting sectionId="terminal-font">
        <div className="space-y-2">
          <div className="flex gap-2 items-end">
            <div className="flex flex-col gap-1 w-28">
              <Label>{t("fontSize")}</Label>
              <Input
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
            </div>
            <div className="flex flex-col gap-1 flex-1">
              <Label>{t("fontFamily")}</Label>
              <Input value={value.fontFamily} onChange={(e) => update("fontFamily", e.target.value)} />
            </div>
          </div>
          <p className="text-[12px]" style={{ color: "var(--app-text-secondary)" }}>
            {t("fontFamilyCjkHint")}
          </p>
        </div>
      </SearchableSetting>

      <div className="flex flex-col gap-1">
        <Label>{t("terminalTheme")}</Label>
        <select
          value={value.themeMode ?? "followApp"}
          onChange={(e) => update("themeMode", e.target.value as TerminalSettings["themeMode"])}
          className="h-9 px-2 rounded-md text-[13px] outline-none"
          style={{
            border: "1px solid var(--app-border)",
            background: "var(--app-content)",
            color: "var(--app-text-primary)",
          }}
        >
          <option value="followApp">{t("terminalThemeFollowApp")}</option>
          <option value="dark">{t("terminalThemeDark")}</option>
          <option value="light">{t("terminalThemeLight")}</option>
        </select>
      </div>

      <div className="flex gap-2 items-end">
        <div className="flex flex-col gap-1 flex-1">
          <Label>{t("cursorStyle")}</Label>
          <select
            value={value.cursorStyle}
            onChange={(e) => update("cursorStyle", e.target.value)}
            className="h-9 px-2 rounded-md text-[13px] outline-none"
            style={{
              border: "1px solid var(--app-border)",
              background: "var(--app-content)",
              color: "var(--app-text-primary)",
            }}
          >
            <option value="block">{t("cursorBlock")}</option>
            <option value="underline">{t("cursorUnderline")}</option>
            <option value="bar">{t("cursorBar")}</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label>{t("cursorBlink")}</Label>
          <div className="flex items-center h-9">
            <input
              type="checkbox"
              checked={value.cursorBlink}
              onChange={(e) => update("cursorBlink", e.target.checked)}
              className="w-4 h-4 cursor-pointer"
              style={{ accentColor: "var(--app-accent)" }}
            />
          </div>
        </div>
      </div>

      <div className="flex gap-2 items-end">
        <div className="flex flex-col gap-1 w-40">
          <Label>{t("scrollback")}</Label>
          <Input
            type="number"
            value={value.scrollback}
            onChange={(e) => update("scrollback", Number(e.target.value))}
          />
        </div>

        <div className="flex flex-col gap-1 flex-1">
          <Label>Shell</Label>
          {shells.length > 0 ? (
            <select
              value={value.shell ?? ""}
              onChange={(e) => update("shell", e.target.value || null)}
              className="h-9 px-2 rounded-md text-[13px] outline-none"
              style={{
                border: "1px solid var(--app-border)",
                background: "var(--app-content)",
                color: "var(--app-text-primary)",
              }}
            >
              <option value="">{t("shellAutoDetect")}</option>
              {shells.map((shell) => (
                <option key={shell.id} value={shell.id} title={shell.path}>
                  {shell.name}
                </option>
              ))}
              {shellIsCustom && <option value={value.shell!}>{value.shell}</option>}
            </select>
          ) : (
            <Input
              value={value.shell ?? ""}
              onChange={(e) => update("shell", e.target.value || null)}
              placeholder={t("shellAutoDetect")}
            />
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label>{t("rendererMode")}</Label>
        <select
          value={value.rendererMode ?? "auto"}
          onChange={(e) => update("rendererMode", e.target.value as TerminalSettings["rendererMode"])}
          className="h-9 px-2 rounded-md text-[13px] outline-none"
          style={{
            border: "1px solid var(--app-border)",
            background: "var(--app-content)",
            color: "var(--app-text-primary)",
          }}
        >
          <option value="auto">{t("rendererAuto")}</option>
          <option value="webgl">{t("rendererWebgl")}</option>
          <option value="dom">{t("rendererDom")}</option>
        </select>
        <p className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
          {t("rendererHint")}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={value.resumeIdBackfillEnabled ?? false}
            onChange={(e) => update("resumeIdBackfillEnabled", e.target.checked)}
            className="w-4 h-4 cursor-pointer"
            style={{ accentColor: "var(--app-accent)" }}
          />
          <Label>{t("resumeIdBackfill")}</Label>
        </div>
        <p className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
          {t("resumeIdBackfillHint")}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={value.daemonEnabled ?? true}
            onChange={(e) => update("daemonEnabled", e.target.checked)}
            className="w-4 h-4 cursor-pointer"
            style={{ accentColor: "var(--app-accent)" }}
          />
          <Label>{t("terminalDaemon")}</Label>
        </div>
        <p className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
          {t("terminalDaemonHint")}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={value.daemonOrphanReaperDisabled ?? false}
            onChange={(e) => update("daemonOrphanReaperDisabled", e.target.checked)}
            className="w-4 h-4 cursor-pointer"
            style={{ accentColor: "var(--app-accent)" }}
            disabled={!(value.daemonEnabled ?? true)}
          />
          <Label>{t("daemonOrphanReaperDisabled")}</Label>
        </div>
        <p className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
          {t("daemonOrphanReaperDisabledHint")}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex flex-col gap-1 w-40">
          <Label>{t("daemonOrphanTtl")}</Label>
          <Input
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
        </div>
        <p className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
          {t("daemonOrphanTtlHint")}
        </p>
      </div>
    </div>
  );
}
