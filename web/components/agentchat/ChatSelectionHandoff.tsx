import "@/i18n/codexIntegrationResources";
import { Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TranscriptSelectionAnchor } from "./useTranscriptSelection";

/** 选中 transcript 文本后在选区旁浮出的「交给 Codex 桌面」小按钮。 */
export default function ChatSelectionHandoff({ anchor, onHandoff }: {
  anchor: TranscriptSelectionAnchor | null;
  onHandoff: (text: string) => void;
}) {
  const { t } = useTranslation("codexIntegration");
  if (!anchor) return null;
  return (
    <button
      type="button"
      data-testid="chat-selection-handoff"
      className="absolute z-20 flex -translate-x-1/2 items-center gap-1 rounded-md border border-[var(--app-border)] bg-[var(--app-overlay)] px-2 py-1 text-xs text-[var(--app-text-secondary)] shadow-md transition-colors hover:text-[var(--app-text-primary)]"
      style={{ top: anchor.top, left: anchor.left }}
      // 按下时不让按钮抢走选区。
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        const text = anchor.text;
        window.getSelection()?.removeAllRanges();
        onHandoff(text);
      }}
    >
      <Send className="size-3.5" />
      {t("handoffSelection")}
    </button>
  );
}
