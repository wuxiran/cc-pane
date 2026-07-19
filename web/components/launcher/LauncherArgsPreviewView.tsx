// Args 预览展示：mono 块逐行渲染 buildArgsPreview 结果 + 「近似，以后端为准」标注。
import { useTranslation } from "react-i18next";
import { buildArgsPreview, type ArgsPreviewInput } from "./launcherArgsPreview";

export default function LauncherArgsPreview({ input }: { input: ArgsPreviewInput }) {
  const { t } = useTranslation("launcher");
  const lines = buildArgsPreview(input);
  if (lines.length === 0) return null;

  return (
    <div
      className="rounded-md border px-2.5 py-2"
      style={{ borderColor: "var(--app-border)", background: "var(--app-hover)" }}
    >
      <div
        className="overflow-x-auto whitespace-pre text-[11px] leading-5"
        style={{ color: "var(--app-text-secondary)", fontFamily: "var(--font-mono, monospace)" }}
      >
        {lines.join("\n")}
      </div>
      <div className="mt-1 text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>
        {t("argsPreviewApproximate")}
      </div>
    </div>
  );
}
