// 「高级」折叠区：专家项默认收起，常规用户只看到基本设置（批 5 设置分层）。
// 仅改呈现：不影响字段本身、存储与既有默认值合并逻辑。
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function AdvancedSettings({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-[var(--app-border)]">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)]"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform duration-[var(--dur-fast)] ${open ? "" : "-rotate-90"}`}
        />
        {t("advancedSettings")}
      </button>
      {open ? (
        <div className="flex flex-col gap-4 border-t border-[var(--app-border)] px-3 py-3">
          {children}
        </div>
      ) : null}
    </div>
  );
}
