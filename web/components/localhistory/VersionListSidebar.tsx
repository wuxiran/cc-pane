import { useTranslation } from "react-i18next";
import { Clock, Tag, GitBranch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { FileVersion, HistoryLabel } from "@/services";
import { formatRelativeTime, formatFullTime, formatSize } from "@/utils";
import { getLabelColor } from "./useLocalHistoryData";

interface VersionListSidebarProps {
  loading: boolean;
  filteredVersions: FileVersion[];
  selectedVersion: FileVersion | null;
  fileBranches: string[];
  selectVersion: (version: FileVersion) => void;
  openLabelDialog: (version: FileVersion) => void;
  getVersionLabels: (versionId: string) => HistoryLabel[];
}

export default function VersionListSidebar({
  loading,
  filteredVersions,
  selectedVersion,
  fileBranches,
  selectVersion,
  openLabelDialog,
  getVersionLabels,
}: VersionListSidebarProps) {
  const { t } = useTranslation(["dialogs", "common"]);

  return (
    <div className="w-[260px] shrink-0 overflow-y-auto rounded-lg p-2" style={{ border: "1px solid var(--app-border)" }}>
      {loading ? (
        <div className="py-5 text-center" style={{ color: "var(--app-text-tertiary)" }}>{t("common:loading")}</div>
      ) : filteredVersions.length === 0 ? (
        <div className="py-5 text-center" style={{ color: "var(--app-text-tertiary)" }}>{t("noHistory")}</div>
      ) : (
        filteredVersions.map((version) => (
          <div
            key={version.id}
            className="px-3 py-2.5 rounded-md cursor-pointer transition-all mb-1"
            style={{
              background: selectedVersion?.id === version.id ? "var(--app-active-bg)" : undefined,
              borderLeft: selectedVersion?.id === version.id ? "3px solid var(--app-accent)" : "3px solid transparent",
            }}
            onClick={() => selectVersion(version)}
            onContextMenu={(e) => { e.preventDefault(); openLabelDialog(version); }}
          >
            <div className="flex items-center gap-1.5 text-[13px]" style={{ color: "var(--app-text-primary)" }}>
              <Clock size={12} />
              <span title={formatFullTime(version.createdAt)}>{formatRelativeTime(version.createdAt)}</span>
            </div>
            <div className="text-[11px] mt-1 pl-[18px] flex items-center gap-2" style={{ color: "var(--app-text-tertiary)" }}>
              <span>{formatSize(version.size)}</span>
              {version.branch ? (
                <Badge variant="outline" className="text-[10px] px-1 h-[18px]" style={{ borderColor: "#6366f1", color: "#6366f1" }}>
                  <GitBranch size={10} className="mr-1" />{version.branch}
                </Badge>
              ) : fileBranches.length > 1 ? (
                <span className="text-[10px] opacity-60">{t("unknownBranch")}</span>
              ) : null}
            </div>
            {getVersionLabels(version.id).length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5 pl-[18px]">
                {getVersionLabels(version.id).map((label) => (
                  <Badge
                    key={label.id}
                    variant="outline"
                    className="text-[10px] px-1.5 h-[18px]"
                    style={{ borderColor: getLabelColor(label.source), color: getLabelColor(label.source) }}
                  >
                    <Tag size={10} className="mr-1" />{label.name}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
