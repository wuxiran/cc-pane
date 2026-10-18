import { useMemo } from "react";
import {
  ArrowLeft,
  LoaderCircle,
  MessageSquareText,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAgentTranscript } from "./useAgentTranscript";
import type {
  AgentTranscriptErrorCode,
  TranscriptMessage,
  TranscriptRole,
} from "@/types/agentTranscript";
import { Button } from "@/components/ui/button";

export type TerminalViewMode = "terminal" | "chat";

interface AgentChatViewProps {
  cliTool?: string | null;
  resumeId?: string | null;
  cwd?: string | null;
  onBackToTerminal: () => void;
}

function roleLabelKey(role: TranscriptRole) {
  switch (role) {
    case "user":
      return "chatRoleUser";
    case "assistant":
      return "chatRoleAssistant";
    case "reasoning":
      return "chatRoleReasoning";
    case "tool":
      return "chatRoleTool";
  }
}

function roleColor(role: TranscriptRole): string {
  switch (role) {
    case "user":
      return "var(--app-text-primary)";
    case "assistant":
      return "var(--app-text-secondary)";
    case "reasoning":
      return "var(--app-text-tertiary)";
    case "tool":
      return "var(--app-text-tertiary)";
  }
}

function errorMessageKey(code: AgentTranscriptErrorCode | null | undefined) {
  switch (code) {
    case "notFound":
      return "chatNotFound";
    case "unsupportedCli":
      return "chatUnsupported";
    case "invalidSessionId":
      return "chatNoResumeId";
    case "cursorExpired":
      return "chatHistoryChanged";
    default:
      return null;
  }
}

function MessageBubble({ message }: { message: TranscriptMessage }) {
  const { t } = useTranslation("panes");
  return (
    <div
      className="border-b px-3 py-2.5 last:border-b-0"
      style={{ borderColor: "var(--app-border)" }}
      data-testid="agent-chat-message"
      data-role={message.role}
    >
      <div
        className="mb-1 text-[10px] font-medium uppercase tracking-wide"
        style={{ color: roleColor(message.role) }}
      >
        {t(roleLabelKey(message.role))}
        {message.toolName ? (
          <span className="ml-2 font-mono normal-case opacity-70">{message.toolName}</span>
        ) : null}
      </div>
      <div
        className="whitespace-pre-wrap break-words text-[12px] leading-5"
        style={{
          color:
            message.role === "reasoning"
              ? "var(--app-text-tertiary)"
              : "var(--app-text-primary)",
          fontFamily: message.role === "tool" ? "var(--font-mono, ui-monospace)" : undefined,
        }}
      >
        {message.text}
      </div>
    </div>
  );
}

export default function AgentChatView(props: AgentChatViewProps) {
  // A conversation change remounts its state immediately; old reads cannot
  // paint the previous conversation while the next effect is still pending.
  const key = JSON.stringify([props.cliTool, props.resumeId, props.cwd]);
  return <TranscriptView key={key} {...props} />;
}

function TranscriptView({
  cliTool,
  resumeId,
  cwd,
  onBackToTerminal,
}: AgentChatViewProps) {
  const { t } = useTranslation("panes");
  const {
    loading, loadingMore, result, error, messages: accumulated, hasEarlier,
    supported, hasResume, refresh: handleRefresh, loadEarlier: handleLoadEarlier,
  } = useAgentTranscript(cliTool, resumeId, cwd);

  const headerMeta = useMemo(() => {
    const total = result?.totalEstimate ?? accumulated.length;
    return t("chatMessageCount", { shown: accumulated.length, total });
  }, [accumulated.length, result?.totalEstimate, t]);

  const bareError = !hasResume
    ? t("chatNoResumeId")
    : !supported
      ? t("chatUnsupported")
      : null;

  const resultErrorKey = errorMessageKey(error?.errorCode ?? undefined);
  const resultError =
    bareError ??
    (resultErrorKey
      ? t(resultErrorKey)
      : error?.errorMessage
        ? t("chatLoadFailed", { error: error.errorMessage })
        : null);

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col"
      style={{ background: "var(--app-terminal-bg)", color: "var(--app-terminal-fg)" }}
      data-testid="agent-chat-view"
    >
      <div
        className="flex h-8 shrink-0 items-center gap-2 border-b px-2"
        style={{ borderColor: "var(--app-border)", background: "var(--app-menubar)" }}
      >
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 gap-1 px-1.5 text-[11px]"
          onClick={onBackToTerminal}
          data-testid="agent-chat-back"
        >
          <ArrowLeft className="size-3.5" />
          {t("chatBackToTerminal")}
        </Button>
        <MessageSquareText className="size-3.5 opacity-60" aria-hidden="true" />
        <span className="text-[11px] font-medium">{t("chatViewTitle")}</span>
        {cliTool ? (
          <span className="rounded px-1 text-[10px] opacity-70" style={{ background: "var(--app-hover)" }}>
            {cliTool}
          </span>
        ) : null}
        {resumeId && resumeId !== "new" ? (
          <span className="max-w-[28%] truncate font-mono text-[10px] opacity-50" title={resumeId}>
            {resumeId}
          </span>
        ) : null}
        <span className="flex-1" />
        {!loading && !resultError ? (
          <span className="text-[10px] opacity-50">{headerMeta}</span>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-[11px]"
          onClick={handleRefresh}
          disabled={loading || !hasResume || !supported}
          data-testid="agent-chat-refresh"
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
          {t("chatRefresh")}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs opacity-60">
            <LoaderCircle className="size-4 animate-spin" />
            {t("chatLoading")}
          </div>
        ) : resultError && accumulated.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs opacity-80">
            <TriangleAlert className="size-5 opacity-60" />
            <p className="max-w-md leading-5">{resultError}</p>
          </div>
        ) : accumulated.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs opacity-60">
            {t("chatEmpty")}
          </div>
        ) : (
          <>
            {resultError ? (
              <div role="alert" className="border-b px-3 py-2 text-xs" style={{ borderColor: "var(--app-border)" }}>
                {resultError}
              </div>
            ) : null}
            {hasEarlier ? (
              <div className="flex justify-center border-b py-2" style={{ borderColor: "var(--app-border)" }}>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px]"
                  onClick={handleLoadEarlier}
                  disabled={loadingMore}
                  data-testid="agent-chat-load-earlier"
                >
                  {loadingMore ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : null}
                  {t("chatLoadEarlier")}
                </Button>
              </div>
            ) : null}
            {accumulated.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
