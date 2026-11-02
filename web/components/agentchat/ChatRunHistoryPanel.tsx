import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AcpRunQuery } from "@/types/agentRuntime";
import ChatRunHistoryEvents from "./ChatRunHistoryEvents";
import { useChatRunHistory } from "./useChatRunHistory";

interface Props {
  chatId: string;
  engineId?: string;
  acpSessionId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenCheckpoint?: (chatId: string, checkpointId: string) => void;
}

export default function ChatRunHistoryPanel({ chatId, engineId, acpSessionId, open, onOpenChange, onOpenCheckpoint }: Props) {
  const { t } = useTranslation("agentRuntime");
  const [scope, setScope] = useState("tab");
  const [engineFilter, setEngineFilter] = useState("");
  const [sessionFilter, setSessionFilter] = useState("");
  const [query, setQuery] = useState<AcpRunQuery>({ chatId });
  const history = useChatRunHistory(query, open);
  const selected = history.runs.find((run) => run.id === history.selectedId);
  const applyFilters = () => setQuery({
    chatId: scope === "tab" ? chatId : undefined,
    engineId: scope === "session" ? engineId : engineFilter.trim() || undefined,
    acpSessionId: scope === "session" ? acpSessionId : sessionFilter.trim() || undefined,
  });

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-5xl">
      <DialogHeader><DialogTitle>{t("title")}</DialogTitle><DialogDescription>{t("readOnly")}</DialogDescription></DialogHeader>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); applyFilters(); }}>
        <label className="flex flex-col gap-1 text-xs">{t("scope")}
          <select className="h-8 rounded border border-input bg-transparent px-2" value={scope} onChange={(event) => setScope(event.target.value)}>
            <option value="tab">{t("currentTab")}</option>
            {engineId && acpSessionId && <option value="session">{t("currentSession")}</option>}
            <option value="all">{t("allRuns")}</option>
          </select>
        </label>
        <label className="flex min-w-24 flex-1 flex-col gap-1 text-xs">{t("engineFilter")}
          <input className="h-8 rounded border border-input bg-transparent px-2" value={scope === "session" ? engineId : engineFilter}
            disabled={scope === "session"} onChange={(event) => setEngineFilter(event.target.value)} />
        </label>
        <label className="flex min-w-32 flex-1 flex-col gap-1 text-xs">{t("sessionFilter")}
          <input className="h-8 rounded border border-input bg-transparent px-2" value={scope === "session" ? acpSessionId : sessionFilter}
            disabled={scope === "session"} onChange={(event) => setSessionFilter(event.target.value)} />
        </label>
        <Button size="sm" type="submit">{t("applyFilters")}</Button>
        <Button size="sm" type="button" variant="outline" onClick={history.reload} disabled={history.loadingRuns}>{t("refresh")}</Button>
      </form>
      {history.error && <p role="alert" className="break-words text-sm text-destructive">{history.error}</p>}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden sm:flex-row">
        <aside className="max-h-48 shrink-0 overflow-auto rounded border border-border sm:max-h-[60vh] sm:w-64" aria-label={t("runs")}>
          {history.runs.map((run) => <button key={run.id} type="button" aria-pressed={history.selectedId === run.id}
            className={`block w-full border-b border-border p-3 text-left text-xs hover:bg-muted ${history.selectedId === run.id ? "bg-muted" : ""}`} onClick={() => history.select(run.id)}>
            <span className="block">{new Date(run.startedAt).toLocaleString()} · {run.engineId}</span>
            <span className={`mt-1 block ${run.status === "interrupted" || run.status === "failed" ? "text-[var(--app-status-warning)]" : "text-muted-foreground"}`}>{t(`status.${run.status}`)} · {t("eventCount", { count: run.eventCount })}</span>
          </button>)}
          {history.loadingRuns && <p role="status" className="p-3 text-xs">{t("loading")}</p>}
          {!history.loadingRuns && !history.runs.length && <p className="p-3 text-xs text-muted-foreground">{t("empty")}</p>}
          {history.moreRuns && <Button variant="ghost" size="sm" disabled={history.loadingRuns} onClick={() => void history.loadMoreRuns()}>{t("moreRuns")}</Button>}
        </aside>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pr-1" aria-label={t("events")}>
          {selected && <div className="mb-3 space-y-2 text-xs">
            <p className="break-all text-muted-foreground">{selected.cwd}</p>
            <p className="break-all text-muted-foreground">{selected.engineId} · {selected.acpSessionId}</p>
            {selected.checkpointId && onOpenCheckpoint && <Button type="button" size="sm" variant="outline"
              onClick={() => onOpenCheckpoint(selected.chatId, selected.checkpointId!)}>{t("viewCheckpoint")}</Button>}
            {selected.status === "interrupted" && <p className="text-[var(--app-status-warning)]">{t("interruptedHelp")}</p>}
            {selected.recordingError && <p role="alert" className="break-words text-destructive">{t("recordingError")}: {selected.recordingError}</p>}
          </div>}
          <ChatRunHistoryEvents events={history.events} />
          {history.loadingEvents && <p role="status" className="mt-3 text-xs">{t("loadingEvents")}</p>}
          {selected && !history.loadingEvents && history.events.length === 0 && <p className="text-xs text-muted-foreground">{t("noEvents")}</p>}
          {history.moreEvents && <Button className="mt-3" variant="outline" size="sm" disabled={history.loadingEvents} onClick={() => void history.loadMoreEvents()}>{t("moreEvents")}</Button>}
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
