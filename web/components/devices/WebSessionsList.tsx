// 「已授权的客户端」里的第二个列表：网页登录会话（用账号密码登录本机 Web 端的浏览器）。
// 会话只在 Web 服务进程内存里，服务没在跑时必然为空。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { SettingsBlock, SettingsHint, SettingsRow } from "@/components/settings/layout";
import { listWebSessions, revokeWebSession, type WebSessionList, type WebSessionInfo } from "@/services/accessService";
import { nativeConfirm } from "@/services/nativeDialog";
import { getErrorMessage } from "@/utils";
import { describeLastSeen, summarizeUserAgent } from "./deviceAccessFormat";

/** 网页会话列表状态；`error` 不为空时列表不可信（读取失败）。 */
export function useWebSessions() {
  const [list, setList] = useState<WebSessionList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setList(await listWebSessions());
      setError(null);
    } catch (reason) {
      setError(getErrorMessage(reason));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { list, error, reload };
}

interface WebSessionsListProps {
  list: WebSessionList | null;
  error: string | null;
  now: number;
  onChanged: () => void;
}

export default function WebSessionsList({ list, error, now, onChanged }: WebSessionsListProps) {
  const { t } = useTranslation("settings");

  const revoke = async (session: WebSessionInfo) => {
    if (!(await nativeConfirm(t("deviceAccess.webSessions.revokeConfirm")))) return;
    try {
      await revokeWebSession(session.id);
    } catch (reason) {
      toast.error(getErrorMessage(reason));
    }
    onChanged();
  };

  const sessions = list?.sessions ?? [];
  const emptyText = error
    ? t("deviceAccess.webSessions.loadFailed", { error })
    : list && !list.webRunning
      ? t("deviceAccess.webSessions.notRunning")
      : t("deviceAccess.webSessions.empty");

  return (
    <>
      <SettingsBlock className="flex flex-col gap-0.5 py-2.5">
        <span className="text-[length:var(--text-row)] font-medium text-[var(--app-text-primary)]">
          {t("deviceAccess.webSessions.title")}
        </span>
        <SettingsHint>{t("deviceAccess.webSessions.description")}</SettingsHint>
      </SettingsBlock>
      {sessions.length === 0 ? (
        <SettingsBlock className="py-3">
          <SettingsHint className={error ? "text-[var(--app-status-danger)]" : undefined}>{emptyText}</SettingsHint>
        </SettingsBlock>
      ) : sessions.map((session) => (
        <WebSessionRow key={session.id} session={session} now={now} onRevoke={() => void revoke(session)} />
      ))}
    </>
  );
}

function WebSessionRow({ session, now, onRevoke }: { session: WebSessionInfo; now: number; onRevoke: () => void }) {
  const { t } = useTranslation("settings");
  const seen = describeLastSeen(session.lastActivityAt, now);
  const activity = seen.kind === "online"
    ? t("deviceAccess.activity.online")
    : seen.kind === "never"
      ? t("deviceAccess.activity.never")
      : t(`deviceAccess.activity.${seen.kind}`, { count: seen.count });
  const title = summarizeUserAgent(session.userAgent) ?? t("deviceAccess.webSessions.unknownBrowser");

  return (
    <SettingsRow
      icon={Globe}
      data-testid={`web-session-row-${session.id.slice(0, 8)}`}
      title={(
        <>
          {title}
          {session.current ? (
            <span className="ml-2 text-[length:var(--text-small)] font-normal text-[var(--app-accent)]">
              {t("deviceAccess.webSessions.current")}
            </span>
          ) : null}
        </>
      )}
      description={(
        <>
          {activity}
          {session.ip ? <>{" · "}{t("deviceAccess.activity.ip", { ip: session.ip })}</> : null}
          {" · "}
          <code>{session.id.slice(0, 8)}</code>
          {" · "}
          {t("deviceAccess.webSessions.createdAt", { date: new Date(session.createdAt).toLocaleString() })}
        </>
      )}
      control={session.current ? undefined : (
        <Button type="button" size="sm" variant="ghost" className="text-[var(--app-status-danger)]" onClick={onRevoke}>
          {t("deviceAccess.webSessions.revoke")}
        </Button>
      )}
    />
  );
}
