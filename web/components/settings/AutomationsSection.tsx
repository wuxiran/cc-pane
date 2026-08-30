import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { CalendarClock, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/EmptyState";
import { automationService, listAcpEngines } from "@/services";
import type { AcpEngineInfo, AutomationDef, AutomationRun } from "@/types";
import {
  buildCron,
  parseCron,
  weekdayLabels,
  type ScheduleDraft,
  type SchedulePreset,
} from "./automationsCron";

interface EditorDraft {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  engineId: string;
  schedule: ScheduleDraft;
  enabled: boolean;
  graceMinutes: number;
  timeoutMinutes: number;
  autoApprove: boolean;
}

const PRESETS: SchedulePreset[] = ["hourly", "daily", "weekdays", "weekly", "custom"];

function emptyDraft(defaultEngineId: string): EditorDraft {
  return {
    id: "",
    name: "",
    prompt: "",
    cwd: "",
    engineId: defaultEngineId,
    schedule: { preset: "daily", time: "09:00", weekday: 1, cron: "0 9 * * *" },
    enabled: true,
    graceMinutes: 10,
    timeoutMinutes: 30,
    autoApprove: true,
  };
}

function toDraft(def: AutomationDef): EditorDraft {
  return {
    id: def.id,
    name: def.name,
    prompt: def.prompt,
    cwd: def.cwd,
    engineId: def.engineId,
    schedule: parseCron(def.schedule),
    enabled: def.enabled,
    graceMinutes: def.graceMinutes,
    timeoutMinutes: def.timeoutMinutes,
    autoApprove: def.autoApprove,
  };
}

function formatMillis(millis: number | null | undefined): string {
  if (!millis) return "—";
  return new Date(millis).toLocaleString();
}

export default function AutomationsSection() {
  const { t, i18n } = useTranslation("settings");
  const [defs, setDefs] = useState<AutomationDef[]>([]);
  const [engines, setEngines] = useState<AcpEngineInfo[]>([]);
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [runsFor, setRunsFor] = useState<string | null>(null);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      setDefs(await automationService.listAutomations());
    } catch {
      // 非 Tauri 环境（web 模式）没有该命令，节内空态即可。
    }
  }, []);

  useEffect(() => {
    void reload();
    void listAcpEngines().then(setEngines).catch(() => setEngines([]));
    let unlisten: (() => void) | undefined;
    void automationService
      .listenAutomationsChanged(() => void reload())
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, [reload]);

  useEffect(() => {
    if (!runsFor) return;
    void automationService.listAutomationRuns(runsFor).then(setRuns).catch(() => setRuns([]));
  }, [runsFor, defs]);

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await automationService.saveAutomation({
        id: draft.id,
        name: draft.name,
        prompt: draft.prompt,
        cwd: draft.cwd,
        engineId: draft.engineId,
        schedule: buildCron(draft.schedule),
        enabled: draft.enabled,
        graceMinutes: draft.graceMinutes,
        timeoutMinutes: draft.timeoutMinutes,
        autoApprove: draft.autoApprove,
        createdAt: 0,
        updatedAt: 0,
        nextRunAt: null,
      });
      setDraft(null);
      await reload();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSaving(false);
    }
  }, [draft, reload]);

  const toggleEnabled = useCallback(
    async (def: AutomationDef, enabled: boolean) => {
      try {
        await automationService.saveAutomation({ ...def, enabled });
        await reload();
      } catch (error) {
        toast.error(String(error));
      }
    },
    [reload],
  );

  const remove = useCallback(
    async (automationId: string) => {
      try {
        await automationService.deleteAutomation(automationId);
        if (runsFor === automationId) setRunsFor(null);
        await reload();
      } catch (error) {
        toast.error(String(error));
      }
    },
    [reload, runsFor],
  );

  const runNow = useCallback(async (automationId: string) => {
    try {
      await automationService.runAutomationNow(automationId);
      toast.success(t("automations.runStarted"));
    } catch (error) {
      toast.error(String(error));
    }
  }, [t]);

  const browseCwd = useCallback(async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string" && draft) {
      setDraft({ ...draft, cwd: picked });
    }
  }, [draft]);

  const weekdays = weekdayLabels(i18n.language);
  const selectClass =
    "h-8 rounded-md border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-2 text-[12px]";

  return (
    <div className="flex flex-col gap-4" data-testid="automations-section">
      <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-5 py-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-[13px] font-medium">
              <CalendarClock className="h-4 w-4" />
              {t("automations.title")}
            </h3>
            <p className="mt-1 text-[12px] text-[var(--app-text-muted)]">
              {t("automations.description")}
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => setDraft(emptyDraft(engines.find((engine) => engine.available)?.id ?? engines[0]?.id ?? ""))}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t("automations.add")}
          </Button>
        </div>
      </div>

      {draft && (
        <div className="flex flex-col gap-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-5 py-4 shadow-sm">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-[12px]">{t("automations.name")}</Label>
              <Input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-[12px]">{t("automations.engine")}</Label>
              <select
                className={selectClass}
                value={draft.engineId}
                onChange={(event) => setDraft({ ...draft, engineId: event.target.value })}
              >
                {engines.map((engine) => (
                  <option key={engine.id} value={engine.id} disabled={!engine.available}>
                    {engine.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-[12px]">{t("automations.prompt")}</Label>
            <textarea
              className="min-h-[72px] rounded-md border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-2 py-1.5 text-[12px]"
              value={draft.prompt}
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-[12px]">{t("automations.cwd")}</Label>
            <div className="flex gap-2">
              <Input
                className="flex-1"
                value={draft.cwd}
                onChange={(event) => setDraft({ ...draft, cwd: event.target.value })}
              />
              <Button variant="outline" size="sm" onClick={() => void browseCwd()}>
                {t("automations.browse")}
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-[12px]">{t("automations.schedule")}</Label>
              <select
                className={selectClass}
                value={draft.schedule.preset}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    schedule: { ...draft.schedule, preset: event.target.value as SchedulePreset },
                  })
                }
              >
                {PRESETS.map((preset) => (
                  <option key={preset} value={preset}>
                    {t(`automations.preset.${preset}`)}
                  </option>
                ))}
              </select>
            </div>
            {draft.schedule.preset !== "hourly" && draft.schedule.preset !== "custom" && (
              <div className="flex flex-col gap-1.5">
                <Label className="text-[12px]">{t("automations.time")}</Label>
                <Input
                  type="time"
                  className="w-28"
                  value={draft.schedule.time}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      schedule: { ...draft.schedule, time: event.target.value },
                    })
                  }
                />
              </div>
            )}
            {draft.schedule.preset === "weekly" && (
              <div className="flex flex-col gap-1.5">
                <Label className="text-[12px]">{t("automations.weekday")}</Label>
                <select
                  className={selectClass}
                  value={draft.schedule.weekday}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      schedule: { ...draft.schedule, weekday: Number(event.target.value) },
                    })
                  }
                >
                  {weekdays.map((label, day) => (
                    <option key={day} value={day}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {draft.schedule.preset === "custom" && (
              <div className="flex flex-col gap-1.5">
                <Label className="text-[12px]">{t("automations.cron")}</Label>
                <Input
                  className="w-44 font-mono"
                  value={draft.schedule.cron}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      schedule: { ...draft.schedule, cron: event.target.value },
                    })
                  }
                />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label className="text-[12px]">{t("automations.timeoutMinutes")}</Label>
              <Input
                type="number"
                className="w-24"
                min={1}
                value={draft.timeoutMinutes}
                onChange={(event) =>
                  setDraft({ ...draft, timeoutMinutes: Number(event.target.value) || 30 })
                }
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-[12px]">
            <Switch
              checked={draft.autoApprove}
              onCheckedChange={(autoApprove) => setDraft({ ...draft, autoApprove })}
            />
            {t("automations.autoApprove")}
          </label>
          <p className="text-[11px] text-[var(--app-text-muted)]">
            {t("automations.autoApproveHint")}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setDraft(null)}>
              {t("automations.cancel")}
            </Button>
            <Button size="sm" disabled={saving} onClick={() => void save()}>
              {t("automations.save")}
            </Button>
          </div>
        </div>
      )}

      {defs.length === 0 && !draft ? (
        <EmptyState icon={CalendarClock} title={t("automations.empty")} />
      ) : (
        defs.map((def) => (
          <div
            key={def.id}
            className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-5 py-3 shadow-sm"
          >
            <div className="flex items-center gap-3">
              <Switch
                checked={def.enabled}
                onCheckedChange={(enabled) => void toggleEnabled(def, enabled)}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{def.name}</span>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {def.schedule}
                  </Badge>
                  <Badge variant="secondary" className="text-[10px]">
                    {engines.find((engine) => engine.id === def.engineId)?.label ?? def.engineId}
                  </Badge>
                </div>
                <p className="mt-0.5 truncate text-[11px] text-[var(--app-text-muted)]">
                  {t("automations.nextRun")}: {def.enabled ? formatMillis(def.nextRunAt) : "—"}
                  {" · "}
                  {def.cwd}
                </p>
              </div>
              <Button variant="ghost" size="sm" title={t("automations.runNow")} onClick={() => void runNow(def.id)}>
                <Play className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="sm" title={t("automations.edit")} onClick={() => setDraft(toDraft(def))}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="sm" title={t("automations.delete")} onClick={() => void remove(def.id)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRunsFor(runsFor === def.id ? null : def.id)}
              >
                {t("automations.runs")}
              </Button>
            </div>
            {runsFor === def.id && (
              <div className="mt-3 flex flex-col gap-1 border-t border-[var(--app-border)] pt-2">
                {runs.length === 0 ? (
                  <p className="text-[11px] text-[var(--app-text-muted)]">{t("automations.noRuns")}</p>
                ) : (
                  runs.map((run) => (
                    <div key={run.id} className="flex items-center gap-2 text-[11px]">
                      <Badge
                        variant={run.status === "completed" ? "secondary" : "outline"}
                        className={
                          run.status === "failed"
                            ? "border-[var(--app-status-danger-border)] text-[var(--app-status-danger)]"
                            : run.status !== "completed"
                              ? "text-[var(--app-text-muted)]"
                              : undefined
                        }
                      >
                        {t(`automations.status.${run.status}`)}
                      </Badge>
                      <span className="text-[var(--app-text-muted)]">{formatMillis(run.startedAt)}</span>
                      {run.finishedAt != null && (
                        <span className="text-[var(--app-text-muted)]">
                          {Math.max(0, Math.round((run.finishedAt - run.startedAt) / 1000))}s
                        </span>
                      )}
                      {run.stopReason && <span>{run.stopReason}</span>}
                      {run.detail && (
                        <span className="truncate text-[var(--app-text-muted)]">{run.detail}</span>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
