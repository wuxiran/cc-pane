import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import OrchestrationFullView from "./OrchestrationFullView";

interface OrchestrationOverlayProps {
  onClose: () => void;
}

export default function OrchestrationOverlay({ onClose }: OrchestrationOverlayProps) {
  const { t } = useTranslation("orchestration");
  return (
    <div
      className="absolute inset-0 z-40 flex justify-end"
      style={{
        background: "color-mix(in srgb, black 34%, transparent)",
        WebkitAppRegion: "no-drag",
      } as CSSProperties}
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label={t("closeOverlay")}
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t("title")}
        className="relative m-3 min-w-0 overflow-hidden shadow-2xl"
        style={{
          width: "clamp(560px, 52vw, 980px)",
          maxWidth: "calc(100vw - 80px)",
          border: "1px solid var(--app-border)",
          borderRadius: 8,
          boxShadow: "0 24px 80px rgba(0, 0, 0, 0.42)",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <OrchestrationFullView variant="overlay" onClose={onClose} />
      </section>
    </div>
  );
}
