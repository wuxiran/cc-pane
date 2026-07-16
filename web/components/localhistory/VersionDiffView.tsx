import { useTranslation } from "react-i18next";
import { FileText, Diff } from "lucide-react";
import DiffView from "@/components/DiffView";
import type { FileVersion, DiffResult } from "@/services";
import type { ViewMode } from "./useLocalHistoryData";

interface VersionDiffViewProps {
  selectedVersion: FileVersion | null;
  loadingContent: boolean;
  viewMode: ViewMode;
  diffDescription: string;
  diffResult: DiffResult | null;
  versionContent: string;
}

export default function VersionDiffView({
  selectedVersion,
  loadingContent,
  viewMode,
  diffDescription,
  diffResult,
  versionContent,
}: VersionDiffViewProps) {
  const { t } = useTranslation(["dialogs", "common"]);

  return (
    <div className="flex-1 rounded-lg overflow-hidden flex flex-col" style={{ border: "1px solid var(--app-border)" }}>
      {!selectedVersion ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3" style={{ color: "var(--app-text-tertiary)" }}>
          <FileText size={48} />
          <p>{t("selectVersionToView")}</p>
          <p className="text-xs opacity-70">{t("rightClickForTag")}</p>
        </div>
      ) : loadingContent ? (
        <div className="flex-1 flex items-center justify-center" style={{ color: "var(--app-text-tertiary)" }}>
          {t("common:loading")}
        </div>
      ) : viewMode === "diff" ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          {diffDescription && (
            <div className="px-3 py-1.5 text-[11px] flex items-center gap-2 border-b shrink-0"
                 style={{ color: "var(--app-text-tertiary)", borderColor: "var(--app-border)" }}>
              <Diff size={12} />
              <span>{diffDescription}</span>
            </div>
          )}
          <DiffView diff={diffResult} />
        </div>
      ) : (
        <pre className="flex-1 m-0 p-3 overflow-auto text-xs leading-relaxed whitespace-pre-wrap break-all" style={{ background: "var(--app-content)" }}>
          {versionContent}
        </pre>
      )}
    </div>
  );
}
