import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";
import { toastErr, toastOk } from "@/lib/feedback";
import { automationService, listAcpEngines } from "@/services";
import { useWorkspacesStore } from "@/stores";
import type { AcpEngineInfo, AutomationDef, AutomationRun } from "@/types";
import { inferWorkspaceName } from "@/components/settings/AutomationScopeFields";
import AutomationDetail from "./AutomationDetail";
import AutomationEditor from "./AutomationEditor";
import AutomationTaskList from "./AutomationTaskList";
import AutomationTemplateGallery from "./AutomationTemplateGallery";
import { emptyDraft, toDef, toDraft, type EditorDraft } from "./automationDraft";
import type { AutomationTemplate } from "./automationTemplates";

/**
 * 定时任务主界面：左栏任务列表，右栏三态——
 * 没选中 = 模板画廊；选中 = 详情（Prompt + 运行历史）；新建/编辑 = 表单。
 */
export default function AutomationsWorkspace() {
  const { t } = useTranslation("settings");
  const [defs, setDefs] = useState<AutomationDef[]>([]);
  const [engines, setEngines] = useState<AcpEngineInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [saving, setSaving] = useState(false);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const expandedWorkspaceId = useWorkspacesStore((state) => state.expandedWorkspaceId);
  // workspace-first：新建默认落当前展开的工作空间及其第一个项目
  const currentWorkspace = workspaces.find((workspace) => workspace.id === expandedWorkspaceId);
  const selected = defs.find((def) => def.id === selectedId) ?? null;

  const reload = useCallback(async () => {
    try {
      setDefs(await automationService.listAutomations());
    } catch {
      // 非 Tauri 环境（web 模式）没有该命令，保持空列表即可。
    }
  }, []);

  useEffect(() => {
    void reload();
    void listAcpEngines().then(setEngines).catch(() => setEngines([]));
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void automationService
      .listenAutomationsChanged(() => void reload())
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [reload]);

  useEffect(() => {
    if (!selectedId) {
      setRuns([]);
      return;
    }
    let stale = false;
    void automationService
      .listAutomationRuns(selectedId)
      .then((next) => { if (!stale) setRuns(next); })
      .catch(() => { if (!stale) setRuns([]); });
    return () => { stale = true; };
  }, [selectedId, defs]);

  const defaultEngineId = engines.find((engine) => engine.available)?.id ?? engines[0]?.id ?? "";
  const startNew = (template?: AutomationTemplate) => {
    const base = emptyDraft(defaultEngineId, currentWorkspace?.name ?? "", currentWorkspace?.projects[0]?.path ?? "");
    setDraft(template
      ? {
        ...base,
        name: t(`automations.templates.${template.id}.title` as never),
        prompt: t(`automations.templates.${template.id}.prompt` as never),
        schedule: template.schedule,
      }
      : base);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const saved = await automationService.saveAutomation(toDef(draft));
      setDraft(null);
      setSelectedId(saved?.id ?? draft.id ?? null);
      await reload();
    } catch (error) {
      toastErr(String(error));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (def: AutomationDef, enabled: boolean) => {
    try {
      await automationService.saveAutomation({ ...def, enabled });
      await reload();
    } catch (error) {
      toastErr(String(error));
    }
  };

  const remove = async (automationId: string) => {
    try {
      await automationService.deleteAutomation(automationId);
      setSelectedId(null);
      await reload();
    } catch (error) {
      toastErr(String(error));
    }
  };

  const runNow = async (automationId: string) => {
    try {
      await automationService.runAutomationNow(automationId);
      toastOk(t("automations.runStarted"));
    } catch (error) {
      toastErr(String(error));
    }
  };

  const browseCwd = async () => {
    const picked = await openDirectoryDialog({ directory: true, multiple: false });
    if (typeof picked === "string") setDraft((current) => (current ? { ...current, cwd: picked } : current));
  };

  return (
    <div data-testid="automations-workspace" className="flex h-full min-h-0 w-full overflow-hidden">
      <AutomationTaskList
        defs={defs}
        selectedId={draft ? null : selectedId}
        onSelect={(automationId) => {
          setDraft(null);
          setSelectedId(automationId);
        }}
        onNew={() => {
          setSelectedId(null);
          startNew();
        }}
      />
      <main className="app-scrollbar min-w-0 flex-1 overflow-y-auto bg-[var(--app-content)]">
        {draft ? (
          <AutomationEditor
            draft={draft}
            engines={engines}
            saving={saving}
            onChange={setDraft}
            onBrowseCwd={() => void browseCwd()}
            onCancel={() => setDraft(null)}
            onSave={() => void save()}
          />
        ) : selected ? (
          <AutomationDetail
            def={selected}
            engineLabel={engines.find((engine) => engine.id === selected.engineId)?.label ?? selected.engineId}
            workspaceName={selected.workspaceName || inferWorkspaceName(workspaces, selected.cwd)}
            runs={runs}
            onToggleEnabled={(enabled) => void toggleEnabled(selected, enabled)}
            onRunNow={() => void runNow(selected.id)}
            onEdit={() => setDraft(toDraft(selected, inferWorkspaceName(workspaces, selected.cwd)))}
            onDelete={() => void remove(selected.id)}
          />
        ) : (
          <AutomationTemplateGallery onPick={(template) => startNew(template)} />
        )}
      </main>
    </div>
  );
}
