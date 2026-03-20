import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { TerminalSettings } from "@/types";

interface TerminalSectionProps {
  value: TerminalSettings;
  onChange: (value: TerminalSettings) => void;
}

export default function TerminalSection({ value, onChange }: TerminalSectionProps) {
  const { t } = useTranslation("settings");

  function update<K extends keyof TerminalSettings>(key: K, v: TerminalSettings[K]) {
    onChange({ ...value, [key]: v });
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[15px] font-semibold mb-1" style={{ color: "var(--app-text-primary)" }}>
        {t("terminalTitle")}
      </h3>

      <div className="flex gap-2 items-end">
        <div className="flex flex-col gap-1 w-28">
          <Label>{t("fontSize")}</Label>
          <Input
            type="number"
            value={value.fontSize}
            onChange={(e) => update("fontSize", Number(e.target.value))}
          />
        </div>
        <div className="flex flex-col gap-1 flex-1">
          <Label>{t("fontFamily")}</Label>
          <Input
            value={value.fontFamily}
            onChange={(e) => update("fontFamily", e.target.value)}
          />
        </div>
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
          <Input
            value={value.shell ?? ""}
            onChange={(e) => update("shell", e.target.value || null)}
            placeholder={t("shellAutoDetect")}
          />
        </div>
      </div>
    </div>
  );
}
