import { Maximize2, Pin } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useBorderlessStore } from "@/stores";
import { useWindowControl } from "@/hooks/useWindowControl";
import { isTauriRuntime } from "@/services/runtime";

const floatingButtonBase =
  "w-8 h-8 flex items-center justify-center rounded-full hover:opacity-100 transition-opacity duration-[var(--dur-fast)] backdrop-blur-sm";
const floatingButtonClass = `${floatingButtonBase} opacity-30`;

const floatingButtonStyle = {
  background: "var(--app-overlay)",
  border: "1px solid var(--app-border)",
  color: "var(--app-text-secondary)",
};

/**
 * 无边框模式的浮动按钮组：标题栏隐藏后，「窗口置顶」与「退出无边框」只能从这里触达。
 */
export default function BorderlessFloatingButton() {
  const { t } = useTranslation("common");
  const { t: tSidebar } = useTranslation("sidebar");
  const isBorderless = useBorderlessStore((s) => s.isBorderless);
  const exitBorderless = useBorderlessStore((s) => s.exitBorderless);

  if (!isBorderless) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[9998] flex flex-col items-center gap-2">
      {isTauriRuntime() && <BorderlessPinButton label={tSidebar("alwaysOnTop")} />}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={t("exitBorderless")}
            onClick={() => exitBorderless()}
            className={floatingButtonClass}
            style={floatingButtonStyle}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">
          <p>{t("exitBorderless")}</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/** 独立子组件：只在无边框模式挂载时才订阅窗口状态（resize 监听 + 置顶回读）。 */
function BorderlessPinButton({ label }: { label: string }) {
  const { isPinned, togglePin } = useWindowControl();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          aria-pressed={isPinned}
          onClick={() => void togglePin()}
          // 置顶中保持不透明：激活态不能只靠 hover 才看得见
          className={`${floatingButtonBase} ${isPinned ? "opacity-100" : "opacity-30"}`}
          style={
            isPinned
              ? { ...floatingButtonStyle, color: "var(--app-accent)" }
              : floatingButtonStyle
          }
        >
          <Pin className={`w-3.5 h-3.5 transition-transform ${isPinned ? "rotate-45" : ""}`} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">
        <p>{label}</p>
      </TooltipContent>
    </Tooltip>
  );
}
