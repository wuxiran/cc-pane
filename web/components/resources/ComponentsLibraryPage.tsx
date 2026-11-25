// 资源库 · 组件：随 CC-Panes 附带、一键接入的能力（微信、飞书 CLI）。
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useActivityBarStore } from "@/stores";
import { useSharedMcpStore } from "@/stores/useSharedMcpStore";
import FeishuCliCard from "./FeishuCliCard";
import { LibraryTitle } from "./libraryChrome";
import WechatComponentSection from "./WechatComponentSection";

const STATUS_POLL_MS = 5000;

export default function ComponentsLibraryPage() {
  const { t } = useTranslation("settings");
  const active = useActivityBarStore((s) => s.appViewMode === "resources");
  const fetchStatus = useSharedMcpStore((s) => s.fetchStatus);

  // 微信组件的运行状态来自共享 MCP 的状态表，这页自己轮询
  useEffect(() => {
    if (!active) return;
    void fetchStatus();
    const timer = window.setInterval(() => void fetchStatus(), STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, fetchStatus]);

  return (
    <div className="flex h-full flex-col" data-testid="components-library-page" style={{ background: "var(--app-panel-bg)" }}>
      <header className="flex shrink-0 flex-wrap items-center gap-2 px-6 pb-3 pt-5">
        <LibraryTitle title={t("resourceLibrary.components")} intro={t("resourceLibrary.componentsIntro")} noProfiles={false} />
      </header>
      <div className="app-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pb-6">
        <WechatComponentSection active={active} />
        <FeishuCliCard active={active} />
      </div>
    </div>
  );
}
