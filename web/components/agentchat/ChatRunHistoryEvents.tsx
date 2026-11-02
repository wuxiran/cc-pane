import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AcpRunEvent } from "@/types/agentRuntime";
import { chatRunHistoryEntries, historyEventDetails, historyEventTitle } from "./chatRunHistoryEntries";

function ArchivedEvent({ event }: { event: AcpRunEvent }) {
  const { t } = useTranslation("agentRuntime");
  const [expanded, setExpanded] = useState(false);
  const archivedRequest = event.kind === "permission_request" || event.kind === "elicitation_request";
  return <details className="rounded border border-border p-2 text-xs" onToggle={(action) => setExpanded(action.currentTarget.open)}>
    <summary className="cursor-default break-all">{historyEventTitle(event)}{archivedRequest ? ` · ${t("archivedRequest")}` : ""}</summary>
    {expanded && <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">{historyEventDetails(event.payload)}</pre>}
  </details>;
}

export default function ChatRunHistoryEvents({ events }: { events: AcpRunEvent[] }) {
  const { t } = useTranslation("agentRuntime");
  const entries = useMemo(() => chatRunHistoryEntries(events), [events]);
  return <div className="flex flex-col gap-3">
    {entries.map((entry) => entry.kind === "event" ? <ArchivedEvent key={entry.id} event={entry.event} /> :
      <article key={entry.id} className="rounded-lg border border-border p-3 text-sm">
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t(`role.${entry.kind}`)}</p>
        <div className="whitespace-pre-wrap break-words">{entry.text}</div>
        {entry.attachments.map((attachment, index) => <p className="mt-2 break-all text-xs text-muted-foreground" key={`${index}-${attachment}`}>{t("attachment")}: {attachment}</p>)}
      </article>)}
  </div>;
}
