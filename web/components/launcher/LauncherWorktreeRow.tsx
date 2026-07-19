// worktree 启动行：开关 + 分支名输入（默认 cc/<yyMMdd-HHmm>）。
// 仅本地环境且 worktreeService.isGitRepo(projectPath) 为真时可用；WSL/SSH/非 Git 置灰并注明原因。
// 实际创建发生在 LauncherDialog 提交时（add → 返回路径替换 PendingLaunch.path），本组件只管草稿。
import { useEffect, useState } from "react";
import { GitBranch } from "lucide-react";
import { useTranslation } from "react-i18next";
import { worktreeService } from "@/services";
import { defaultWorktreeBranch, type LauncherDraft } from "./launcherModel";

interface LauncherWorktreeRowProps {
  draft: LauncherDraft;
  onChange: (patch: Partial<LauncherDraft>) => void;
  /** 当前草稿解析出的项目路径；无则不可用 */
  projectPath?: string;
  /** 是否本地环境（WSL/SSH 为 false → 置灰） */
  isLocal: boolean;
}

export default function LauncherWorktreeRow({
  draft,
  onChange,
  projectPath,
  isLocal,
}: LauncherWorktreeRowProps) {
  const { t } = useTranslation("launcher");
  // null = 未知/检测中
  const [gitRepo, setGitRepo] = useState<boolean | null>(null);

  useEffect(() => {
    let disposed = false;
    setGitRepo(null);
    if (!projectPath || !isLocal) return;
    worktreeService
      .isGitRepo(projectPath)
      .then((value) => {
        if (!disposed) setGitRepo(value);
      })
      .catch(() => {
        if (!disposed) setGitRepo(false);
      });
    return () => {
      disposed = true;
    };
  }, [projectPath, isLocal]);

  const available = isLocal && gitRepo === true;
  const enabled = available && draft.worktree?.enabled === true;

  // 项目/环境切换导致不可用时，静默关掉已勾选的 worktree（避免提交时才失败）
  useEffect(() => {
    if (!available && draft.worktree?.enabled) {
      onChange({ worktree: { ...draft.worktree, enabled: false } });
    }
    // onChange 引用稳定性由父组件保证；仅在可用性/勾选态变化时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, draft.worktree?.enabled]);

  const reason = !projectPath
    ? t("worktreeUnavailableNoProject")
    : !isLocal
      ? t("worktreeUnavailableRemote")
      : gitRepo === false
        ? t("worktreeUnavailableNotGit")
        : gitRepo === null
          ? t("worktreeChecking")
          : null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          role="checkbox"
          aria-checked={enabled}
          aria-label={t("worktreeEnable")}
          disabled={!available}
          className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors duration-[var(--dur-fast)] enabled:hover:bg-[var(--app-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          style={
            enabled
              ? {
                  borderColor: "var(--app-accent)",
                  background: "color-mix(in srgb, var(--app-accent) 12%, transparent)",
                  color: "var(--app-accent)",
                }
              : { borderColor: "var(--app-border)", color: "var(--app-text-secondary)" }
          }
          onClick={() =>
            onChange({
              worktree: {
                enabled: !draft.worktree?.enabled,
                branch: draft.worktree?.branch || defaultWorktreeBranch(),
              },
            })
          }
        >
          <GitBranch className="h-3 w-3" />
          {t("worktreeEnable")}
        </button>

        <input
          type="text"
          className="h-7 min-w-[180px] rounded-md border bg-background px-2 text-[11px] disabled:cursor-not-allowed disabled:opacity-40"
          value={draft.worktree?.branch ?? ""}
          disabled={!enabled}
          placeholder={t("worktreeBranch")}
          aria-label={t("worktreeBranch")}
          onChange={(event) =>
            onChange({
              worktree: { enabled: draft.worktree?.enabled ?? false, branch: event.target.value },
            })
          }
        />
      </div>

      {reason && (
        <div
          data-testid="worktree-reason"
          className="text-[10.5px]"
          style={{ color: "var(--app-text-tertiary)" }}
        >
          {reason}
        </div>
      )}
    </div>
  );
}
