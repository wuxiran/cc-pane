import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { islandService } from "@/services/islandService";
import type { IslandPosition, IslandSession } from "@/types/island";
import { IslandNeedsDot } from "./IslandIcons";
import { approvalTones, optionIndexForKey } from "./islandView";

interface IslandApprovalCardProps {
  session: IslandSession;
  edge: IslandPosition;
  /** 指针在岛内时才响应数字键（窗口级监听，不挂任何全局热键）。 */
  keysActive: boolean;
  onRespond: (session: IslandSession, optionId: string) => void;
  onJump: (session: IslandSession) => void;
  onBack: () => void;
}

/** 终端 CLI：读屏幕底部取审批问题原文，打开卡片时按需取一次。 */
function useTerminalQuestion(session: IslandSession): string | null {
  const [question, setQuestion] = useState<string | null>(null);
  useEffect(() => {
    if (session.kind !== "terminal") return undefined;
    let disposed = false;
    void islandService.getTerminalPendingApproval(session.id)
      .then((text) => { if (!disposed) setQuestion(text ?? null); })
      .catch(() => {});
    return () => { disposed = true; };
  }, [session.id, session.kind, session.since]);
  return question;
}

/**
 * 等你批准：Agent Chat 显示真实 ACP 选项（数字键 1–9 直选）；终端会话只给「在窗格里看」，
 * 岛上不向 PTY 注入任何按键。
 */
export default function IslandApprovalCard({ session, edge, keysActive, onRespond, onJump, onBack }: IslandApprovalCardProps) {
  const { t } = useTranslation("island");
  const approval = session.kind === "chat" ? session.approval : null;
  const terminalQuestion = useTerminalQuestion(session);
  const options = approval?.options ?? [];
  const tones = approvalTones(options);

  useEffect(() => {
    if (!keysActive) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Enter") {
        event.preventDefault();
        onJump(session);
        return;
      }
      if (event.key === "Escape") {
        onBack();
        return;
      }
      const index = optionIndexForKey(event.key, options.length);
      const option = index === null ? null : options[index];
      if (!option || approval?.responding) return;
      event.preventDefault();
      onRespond(session, option.optionId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [approval?.responding, keysActive, onBack, onJump, onRespond, options, session]);

  const question = approval
    ? approval.title ?? t("approvalFallback")
    : terminalQuestion ?? session.activity ?? t("terminalNoQuestion");

  return (
    <div className="island-panel" data-edge={edge}>
      <div className="island-head">
        <IslandNeedsDot />
        <b className="island-ellipsis">{session.name}</b>
        {session.cli ? <span className="island-tag" style={{ marginLeft: 0 }}>{session.cli}</span> : null}
        <span className="island-spacer" />
        <button type="button" className="island-link" onClick={onBack}>{t("back")}</button>
      </div>
      <div className="island-question">{question}</div>
      {approval?.detail ? <div className="island-code island-mono">{approval.detail}</div> : null}
      {approval ? (
        <div className="island-options">
          {options.map((option, index) => (
            <button
              key={option.optionId}
              type="button"
              className="island-btn"
              data-tone={tones[index]}
              disabled={approval.responding}
              onClick={() => onRespond(session, option.optionId)}
            >
              <span>{option.name}</span>
              {index < 9 ? <span className="island-kbd">{index + 1}</span> : null}
            </button>
          ))}
        </div>
      ) : (
        <div className="island-row-detail">{t("terminalHint")}</div>
      )}
      {approval?.error ? <div role="alert" className="island-error">{approval.error}</div> : null}
      <div className="island-foot">
        <span>
          {approval?.responding
            ? t("responding")
            : approval && approval.queued > 0 ? t("pendingMore", { count: approval.queued }) : null}
        </span>
        <button type="button" className="island-link" onClick={() => onJump(session)}>
          {t("viewInPane")}
          <span className="island-kbd">↵</span>
        </button>
      </div>
    </div>
  );
}
