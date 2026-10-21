// ACP 审批卡：agent 请求执行敏感操作时的 allow/reject 选项条。
// 选项集合由 agent 给出（allow_once / allow_always / reject_*），不在前端造。
// 当选项集不含 allow/reject 语义时按「agent 提问」渲染（AskUserQuestion 类
// 工具经适配器映射成 request_permission，多个中性选项就是问卷）。
import { ShieldQuestion } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AcpPermissionRequest } from "@/types/agentChat";
import PermissionQuestionCard from "./PermissionQuestionCard";

interface PermissionCardProps {
  request: AcpPermissionRequest;
  onRespond: (optionId: string | null) => void;
  responding?: boolean;
  error?: string | null;
}

function optionClass(kind: string): string {
  if (kind.startsWith("allow")) {
    return "border-[var(--app-status-success-border)] text-[var(--app-status-success)] hover:bg-[var(--app-status-success-bg)]";
  }
  if (kind.startsWith("reject")) {
    return "border-[var(--app-status-danger-border)] text-[var(--app-status-danger)] hover:bg-[var(--app-status-danger-bg)]";
  }
  return "border-[var(--app-border)] hover:bg-[var(--app-hover)]";
}

export default function PermissionCard({ request, onRespond, responding, error }: PermissionCardProps) {
  const { t } = useTranslation("panes");
  const title = request.params.toolCall?.title;
  const options = request.params.options ?? [];
  // 全部选项都不带 allow/reject 语义 = 提问而非审批，用中性样式。
  const isQuestion =
    options.length > 0
    && options.every(
      (option) => !option.kind.startsWith("allow") && !option.kind.startsWith("reject"),
    );

  if (isQuestion) return <PermissionQuestionCard key={request.requestKey} request={request} onRespond={onRespond} responding={responding} error={error} />;

  return (
    <div className="px-3 pb-2">
      <div
        className="mx-auto max-w-3xl rounded-xl border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-bg)] px-3.5 py-2.5 shadow-sm"
      >
        <div
          className="flex items-center gap-2 text-xs text-[var(--app-status-warning)]"
        >
          <ShieldQuestion className="h-4 w-4 shrink-0" />
          <span className="font-medium">
            {t("agentChatPermissionTitle")}
          </span>
        </div>
        {title ? (
          <div className="mt-1 text-xs text-[var(--app-text-primary)] break-all">{title}</div>
        ) : null}
        {error ? <div role="alert" className="mt-1 text-xs text-[var(--app-status-danger)]">{error}</div> : null}
        <div className="mt-2 flex flex-wrap gap-2">
          {options.map((option) => (
            <button
              key={option.optionId}
              type="button"
              disabled={responding}
              className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${optionClass(option.kind)}`}
              onClick={() => onRespond(option.optionId)}
            >
              {option.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
