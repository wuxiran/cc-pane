// Automations 编辑器里的「属于哪个工作空间 → 在其下哪个项目里跑」两个字段（docs/98 workspace-first）。
// 选了项目就填 cwd；也允许手填/浏览任意目录（cwd 与项目脱钩时 workspaceName 仍保留）。
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { useWorkspacesStore } from "@/stores";

interface AutomationScopeFieldsProps {
  workspaceName: string;
  cwd: string;
  selectClass: string;
  onChange: (next: { workspaceName: string; cwd: string }) => void;
  onBrowse: () => void;
}

/** 从 cwd 反推所属工作空间（编辑旧定义时用） */
export function inferWorkspaceName(
  workspaces: ReadonlyArray<{ name: string; projects: ReadonlyArray<{ path: string }> }>,
  cwd: string,
): string {
  if (!cwd) return "";
  return workspaces.find((workspace) => workspace.projects.some((project) => project.path === cwd))?.name ?? "";
}

export default function AutomationScopeFields({
  workspaceName,
  cwd,
  selectClass,
  onChange,
  onBrowse,
}: AutomationScopeFieldsProps) {
  const { t } = useTranslation("settings");
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const projects = useMemo(
    () => workspaces.find((workspace) => workspace.name === workspaceName)?.projects ?? [],
    [workspaces, workspaceName],
  );
  const cwdIsProject = projects.some((project) => project.path === cwd);

  return (
    <div className="flex flex-wrap items-end gap-3">
      <FormField label={t("automations.workspace")} className="flex min-w-[200px] flex-col gap-1.5" labelClassName="text-[12px]">
        {({ id }) => (
          <select
            id={id}
            className={selectClass}
            value={workspaceName}
            onChange={(event) => {
              const next = event.target.value;
              const first = workspaces.find((workspace) => workspace.name === next)?.projects[0];
              onChange({ workspaceName: next, cwd: first?.path ?? cwd });
            }}
          >
            <option value="">{t("automations.workspaceNone")}</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.name}>
                {workspace.alias || workspace.name}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField label={t("automations.cwd")} className="flex min-w-[260px] flex-1 flex-col gap-1.5" labelClassName="text-[12px]">
        {({ id }) =>
          workspaceName && projects.length > 0 ? (
            <select
              id={id}
              className={selectClass}
              value={cwdIsProject ? cwd : "__custom__"}
              onChange={(event) => {
                if (event.target.value !== "__custom__") onChange({ workspaceName, cwd: event.target.value });
              }}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.path}>
                  {project.alias || project.path}
                </option>
              ))}
              {!cwdIsProject && (
                <option value="__custom__">{cwd || t("automations.cwdCustom")}</option>
              )}
            </select>
          ) : (
            <div className="flex gap-2">
              <Input id={id} className="flex-1" value={cwd} onChange={(event) => onChange({ workspaceName, cwd: event.target.value })} />
              <Button variant="outline" size="sm" onClick={onBrowse}>
                {t("automations.browse")}
              </Button>
            </div>
          )
        }
      </FormField>
    </div>
  );
}
