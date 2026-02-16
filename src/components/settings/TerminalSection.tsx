import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { TerminalSettings } from "@/types";

interface TerminalSectionProps {
  value: TerminalSettings;
  onChange: (value: TerminalSettings) => void;
}

export default function TerminalSection({ value, onChange }: TerminalSectionProps) {
  function update<K extends keyof TerminalSettings>(key: K, v: TerminalSettings[K]) {
    onChange({ ...value, [key]: v });
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[15px] font-semibold mb-1" style={{ color: "var(--app-text-primary)" }}>
        终端设置
      </h3>

      <div className="flex gap-2 items-end">
        <div className="flex flex-col gap-1 w-28">
          <Label>字号</Label>
          <Input
            type="number"
            value={value.fontSize}
            onChange={(e) => update("fontSize", Number(e.target.value))}
          />
        </div>
        <div className="flex flex-col gap-1 flex-1">
          <Label>字体</Label>
          <Input
            value={value.fontFamily}
            onChange={(e) => update("fontFamily", e.target.value)}
          />
        </div>
      </div>

      <div className="flex gap-2 items-end">
        <div className="flex flex-col gap-1 flex-1">
          <Label>光标样式</Label>
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
            <option value="block">方块 (Block)</option>
            <option value="underline">下划线 (Underline)</option>
            <option value="bar">竖线 (Bar)</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label>光标闪烁</Label>
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

      <div className="flex flex-col gap-1 w-40">
        <Label>回滚行数</Label>
        <Input
          type="number"
          value={value.scrollback}
          onChange={(e) => update("scrollback", Number(e.target.value))}
        />
      </div>
    </div>
  );
}
