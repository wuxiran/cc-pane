import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { TERMINAL_FONT_SIZE_DEFAULT } from "@/stores";

/** HUD 停留时长：够读完一个百分比，又不至于挡住输出 */
const HUD_VISIBLE_MS = 1400;

interface TerminalZoomHudProps {
  /** 当前终端字号（px）。变化即触发一次提示。 */
  fontSize: number;
}

/**
 * Ctrl+滚轮缩放时浮出的读数。
 *
 * 只在字号**变化**时出现，首帧不弹——否则每次挂载终端都会闪一下。
 * 百分比以默认字号为 100% 基准（15px），与设置页里的绝对值是同一个数的两种表述。
 */
export default function TerminalZoomHud({ fontSize }: TerminalZoomHudProps) {
  const { t } = useTranslation("panes");
  const [visible, setVisible] = useState(false);
  const previousRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // 首次拿到字号只记录，不提示
    if (previousRef.current === null) {
      previousRef.current = fontSize;
      return;
    }
    if (previousRef.current === fontSize) return;
    previousRef.current = fontSize;

    setVisible(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setVisible(false);
    }, HUD_VISIBLE_MS);
  }, [fontSize]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const percent = Math.round((fontSize / TERMINAL_FONT_SIZE_DEFAULT) * 100);

  return (
    <div
      aria-hidden={!visible}
      className={[
        "pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2",
        "flex items-center gap-3 rounded-full px-5 py-3",
        "bg-[var(--app-glass-bg-heavy)] backdrop-blur-[var(--app-glass-blur)]",
        "border border-[var(--app-glass-border)] shadow-[var(--sh-lg)]",
        "transition-opacity duration-200 ease-out",
        visible ? "opacity-100" : "opacity-0",
      ].join(" ")}
    >
      <Search aria-hidden="true" className="size-4 text-[var(--app-text-tertiary)]" />
      <span className="text-[13px] text-[var(--app-text-secondary)]">
        {t("terminalZoom")}
      </span>
      <span className="text-[17px] font-semibold tabular-nums tracking-[-0.01em] text-[var(--app-text-primary)]">
        {percent}%
      </span>
    </div>
  );
}
