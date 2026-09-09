// 工作空间层配置在远端会话里的可达性提示（MCP 页 / Skill 页顶部）：
// - SSH：工作空间层 MCP / skills 完全不注入
// - WSL：skills 通过 /mnt 挂载没问题；MCP 只有 HTTP 型能进，stdio 型要提醒
import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";
import type { LaunchProfile, Workspace } from "@/types";
import { workspaceRemoteRuntimes } from "./launchProfileHelpers";

interface RemoteRuntimeNoticeProps {
  workspace: Workspace | undefined;
  profile: LaunchProfile | null;
  subject: "mcp" | "skills";
  className?: string;
}

export default function RemoteRuntimeNotice({ workspace, profile, subject, className }: RemoteRuntimeNoticeProps) {
  const { t } = useTranslation("providers");
  const runtimes = workspaceRemoteRuntimes(workspace, profile);
  const key = runtimes.includes("ssh")
    ? `remoteRuntimeNotice.ssh.${subject}`
    : runtimes.includes("wsl") && subject === "mcp"
      ? "remoteRuntimeNotice.wsl.mcp"
      : null;
  if (!key) return null;
  return (
    <div
      role="note"
      data-testid="remote-runtime-notice"
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] leading-relaxed ${className ?? ""}`}
      style={{
        borderColor: "color-mix(in srgb, var(--app-status-warning) 40%, transparent)",
        background: "color-mix(in srgb, var(--app-status-warning) 8%, transparent)",
        color: "var(--app-text-secondary)",
      }}
    >
      <TriangleAlert size={14} className="mt-0.5 shrink-0" style={{ color: "var(--app-status-warning)" }} />
      <span>{t(key as never)}</span>
    </div>
  );
}
