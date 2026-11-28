// 宠物头顶的气泡：单行输入 / 等待中 / 单次回复 / 出错 / 短提示。
// 画在宠物窗口顶部的气泡区里（窗口固定大小，透明处点击穿透），样式走主题 token。
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Loader2, ShieldAlert } from "lucide-react";
import type { PetBubble as PetBubbleState } from "./usePetBubble";
import type { HitRect } from "./petLayout";

const BUBBLE_WIDTH = 260;

interface PetBubbleProps {
  bubble: PetBubbleState;
  botName: string;
  /** 等待中且 Bot 在等审批。 */
  needsApproval: boolean;
  windowWidth: number;
  bottom: number;
  onSubmit: (text: string) => void;
  onDismiss: () => void;
  onCancel: () => void;
  onOpenMain: () => void;
  onRect: (rect: HitRect | null) => void;
}

export function PetBubble({
  bubble, botName, needsApproval, windowWidth, bottom, onSubmit, onDismiss, onCancel, onOpenMain, onRect,
}: PetBubbleProps) {
  const { t } = useTranslation("ccchan");
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState("");
  const width = Math.min(BUBBLE_WIDTH, windowWidth - 12);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const report = () => {
      const rect = node.getBoundingClientRect();
      onRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    };
    report();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(report) : null;
    observer?.observe(node);
    return () => {
      observer?.disconnect();
      onRect(null);
    };
  }, [bubble.kind, onRect]);

  useEffect(() => {
    if (bubble.kind !== "input") return;
    setDraft("");
    inputRef.current?.focus();
  }, [bubble.kind]);

  function handleKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onDismiss();
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (draft.trim()) onSubmit(draft);
    }
  }

  const linkClass = "inline-flex items-center gap-1 text-[length:var(--text-small)] font-medium text-[var(--app-accent)] hover:underline";

  return (
    <div
      ref={ref}
      data-testid="pet-bubble"
      data-bubble-kind={bubble.kind}
      className="absolute z-20 rounded-xl border px-3 py-2 text-[length:var(--text-row)] leading-snug shadow-lg"
      style={{
        width,
        left: (windowWidth - width) / 2,
        bottom: `calc(100% - ${bottom - 4}px)`,
        maxHeight: bottom - 8,
        background: "var(--popover)",
        borderColor: bubble.kind === "error" ? "var(--app-status-danger)" : "var(--border)",
        color: "var(--popover-foreground)",
      }}
      onClick={(event) => {
        if (bubble.kind === "reply" || bubble.kind === "notice" || bubble.kind === "error") {
          if (!(event.target as HTMLElement).closest("button")) onDismiss();
        }
      }}
    >
      {bubble.kind === "input" && (
        <input
          ref={inputRef}
          aria-label={t("bubble.placeholder", { name: botName })}
          placeholder={t("bubble.placeholder", { name: botName })}
          className="w-full bg-transparent text-[length:var(--text-row)] outline-none placeholder:text-[var(--app-text-muted)]"
          value={draft}
          maxLength={2000}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKey}
          onBlur={() => { if (!draft.trim()) onDismiss(); }}
        />
      )}
      {bubble.kind === "pending" && (needsApproval ? (
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-1.5 font-medium">
            <ShieldAlert size={14} className="text-[var(--app-status-warning)]" />
            {t("bubble.approval", { name: botName })}
          </span>
          <button type="button" className={linkClass} onClick={onOpenMain}>
            {t("bubble.openMain")} <ExternalLink size={12} />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Loader2 size={14} className="shrink-0 animate-spin text-[var(--app-text-muted)]" />
          <span className="min-w-0 flex-1 truncate text-[var(--app-text-secondary)]">{t("bubble.sending", { name: botName })}</span>
          <button type="button" className={linkClass} onClick={onCancel}>{t("bubble.cancel")}</button>
        </div>
      ))}
      {bubble.kind === "reply" && (
        <div className="flex flex-col gap-1">
          <p className="line-clamp-4 whitespace-pre-wrap break-words" title={bubble.text}>
            {bubble.text || t("bubble.empty")}
          </p>
          <button type="button" className={`${linkClass} self-start`} onClick={onOpenMain}>
            {t("bubble.viewFull")} <ExternalLink size={12} />
          </button>
        </div>
      )}
      {bubble.kind === "error" && (
        <p className="line-clamp-3 break-words text-[var(--app-status-danger)]">{bubble.message}</p>
      )}
      {bubble.kind === "notice" && (
        <p className="line-clamp-4 whitespace-pre-wrap break-words">{bubble.text}</p>
      )}
    </div>
  );
}
