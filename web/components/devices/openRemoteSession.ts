// 把设备上的会话开成本机窗格里的标签（docs/111-multi-device.md 阶段 3）。
//
// 后端先把会话 id 登记到远程路由，前端再用 adoptSession 建一个"待重连"的标签：
// 它走的是重连本机既有会话的同一条恢复路径（recovery snapshot + 事件桥），
// 写入 / 调整大小 / 关闭都由后端按会话 id 透明转发到对端。
import { attachDeviceSession, createDeviceSession } from "@/services/deviceService";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { usePanesStore } from "@/stores/usePanesStore";
import { useTerminalStatusStore } from "@/stores/useTerminalStatusStore";
import type { DeviceSummary } from "@/types/device";

export interface RemoteSessionMeta {
  projectPath: string;
  projectName?: string | null;
  cliTool?: string | null;
}

function projectLabel(meta: RemoteSessionMeta): string {
  return meta.projectName || meta.projectPath.split("/").filter(Boolean).pop() || meta.projectPath;
}

function openTab(device: DeviceSummary, sessionId: string, meta: RemoteSessionMeta): string | null {
  // 恢复路径据此判断"会话活着、直接接上"，而不是走新建（新建会把对端路径当成本机路径）。
  useTerminalStatusStore.getState().markSessionLive(sessionId);
  const tabId = usePanesStore.getState().adoptSession(sessionId, {
    projectPath: meta.projectPath,
    projectId: `device:${device.id}:${meta.projectPath}`,
    cliTool: meta.cliTool ?? undefined,
    customTitle: `${device.name} · ${projectLabel(meta)}`,
  });
  const activity = useActivityBarStore.getState();
  if (activity.appViewMode !== "panes") activity.setAppViewMode("panes");
  return tabId;
}

export async function openRemoteSession(
  device: DeviceSummary,
  sessionId: string,
  meta: RemoteSessionMeta,
): Promise<string | null> {
  await attachDeviceSession(device.id, sessionId);
  return openTab(device, sessionId, meta);
}

export async function startRemoteSession(
  device: DeviceSummary,
  project: { path: string; name?: string | null },
  workspace: { name: string; path?: string | null } | null,
  cliTool: string,
): Promise<string | null> {
  const sessionId = await createDeviceSession(device.id, {
    projectPath: project.path,
    workspaceName: workspace?.name,
    workspacePath: workspace?.path ?? undefined,
    cliTool,
    cols: 120,
    rows: 32,
  });
  return openTab(device, sessionId, { projectPath: project.path, projectName: project.name, cliTool });
}
