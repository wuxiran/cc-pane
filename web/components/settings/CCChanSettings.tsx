import { useEffect } from "react";
import { Bot, MapPin, Music, Power, Sparkles } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FALLBACK_PET, useCCChanStore } from "@/stores/useCCChanStore";
import type { CCChanSettings as CCChanSettingsValue } from "@/ccchan/types";

interface CCChanSettingsProps {
  value: CCChanSettingsValue;
  onChange: (value: CCChanSettingsValue) => void;
}

const ENGINE_OPTIONS = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
] as const;

export default function CCChanSettings({ value, onChange }: CCChanSettingsProps) {
  const pets = useCCChanStore((state) => state.pets);
  const load = useCCChanStore((state) => state.load);
  const petOptions = pets.length > 0 ? pets : [FALLBACK_PET];

  useEffect(() => {
    void load();
  }, [load]);

  function update<K extends keyof CCChanSettingsValue>(key: K, next: CCChanSettingsValue[K]) {
    onChange({ ...value, [key]: next });
  }

  const selectStyle = {
    border: "1px solid var(--app-border)",
    background: "var(--app-content)",
    color: "var(--app-text-primary)",
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="mb-1 flex items-center gap-2 text-[15px] font-semibold" style={{ color: "var(--app-text-primary)" }}>
          <Bot size={16} />
          <span>cc酱</span>
        </h3>
        <p className="m-0 text-[12px]" style={{ color: "var(--app-text-tertiary)" }}>
          桌面浮窗、chat 引擎和角色设置。
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label className="flex items-center gap-2">
          <Sparkles size={14} />
          <span>AI 引擎</span>
        </Label>
        <div className="flex flex-wrap gap-2">
          {ENGINE_OPTIONS.map((option) => {
            const active = value.aiEngine === option.value;
            return (
              <button
                key={option.value}
                type="button"
                className={cn(
                  "h-9 rounded-md border px-3 text-[13px] font-medium transition-colors",
                  active
                    ? "border-blue-500 bg-blue-600 text-white"
                    : "border-[var(--app-border)] bg-[var(--app-content)] text-[var(--app-text-secondary)] hover:text-[var(--app-text-primary)]",
                )}
                onClick={() => update("aiEngine", option.value)}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label>默认角色</Label>
        <select
          value={value.defaultPetId}
          className="h-9 w-52 rounded-md px-2 text-[13px] outline-none"
          style={selectStyle}
          onChange={(event) => update("defaultPetId", event.target.value)}
        >
          {petOptions.map((pet) => (
            <option key={pet.id} value={pet.id}>
              {pet.displayName}
            </option>
          ))}
        </select>
        <p className="m-0 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
          {petOptions.find((pet) => pet.id === value.defaultPetId)?.description ?? "当前角色"}
        </p>
      </div>

      <div className="flex flex-col gap-3 border-t pt-3" style={{ borderColor: "var(--app-border)" }}>
        <label className="flex items-center justify-between gap-3 text-[13px]" style={{ color: "var(--app-text-primary)" }}>
          <span className="flex items-center gap-2">
            <Power size={14} />
            开机自动显示
          </span>
          <input
            type="checkbox"
            checked={value.autoStart}
            className="h-4 w-4 cursor-pointer"
            style={{ accentColor: "var(--app-accent)" }}
            onChange={(event) => update("autoStart", event.target.checked)}
          />
        </label>

        <label className="flex items-center justify-between gap-3 text-[13px]" style={{ color: "var(--app-text-primary)" }}>
          <span className="flex items-center gap-2">
            <Music size={14} />
            启用通知音
          </span>
          <input
            type="checkbox"
            checked={value.soundEnabled}
            className="h-4 w-4 cursor-pointer"
            style={{ accentColor: "var(--app-accent)" }}
            onChange={(event) => update("soundEnabled", event.target.checked)}
          />
        </label>

        <label className="flex items-center justify-between gap-3 text-[13px]" style={{ color: "var(--app-text-primary)" }}>
          <span>浮窗可见</span>
          <input
            type="checkbox"
            checked={value.windowVisible}
            className="h-4 w-4 cursor-pointer"
            style={{ accentColor: "var(--app-accent)" }}
            onChange={(event) => update("windowVisible", event.target.checked)}
          />
        </label>
      </div>

      <div className="flex flex-col gap-2 border-t pt-3" style={{ borderColor: "var(--app-border)" }}>
        <Label className="flex items-center gap-2">
          <MapPin size={14} />
          <span>当前位置</span>
        </Label>
        <div className="flex items-center gap-2">
          <span
            className="rounded-md px-2.5 py-1.5 font-mono text-[12px]"
            style={{
              background: "var(--app-hover)",
              color: "var(--app-text-secondary)",
              border: "1px solid var(--app-border)",
            }}
          >
            x: {value.windowX ?? "-"} · y: {value.windowY ?? "-"} · 60x60 / 380x520
          </span>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => onChange({ ...value, windowX: null, windowY: null })}
          >
            重置位置
          </Button>
        </div>
      </div>
    </div>
  );
}
