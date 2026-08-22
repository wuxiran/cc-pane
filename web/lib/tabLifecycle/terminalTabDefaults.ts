// 终端标签的构造默认值（docs/78 批4）。
//
// 真身原先内联在 `usePanesStore.createTab`，登记表化后搬到这里：登记表的
// `createDefaults` 需要它，而 `lib → stores` 反向 import 会成环。搬家是纯移动，
// 标题推导与 leaf 字段一字未改。
//
// **不变式**：`launchId` 每次构造都新生成（docs/69）——它是「一次启动的身份」，
// 复用上一次的值会让 `bind_pty_session` 落空、resume id 永久丢失。
import { generateId } from "@/lib/paneTree";
import { inferCliTool, resolveRestoreMode } from "@/lib/terminalRestoreMode";
import type { Tab, TerminalPaneLeaf } from "@/types";
import type { CreateTabOptions } from "@/stores/panesStoreTypes";

/** 无 customTitle 时按「目录名 + 运行时/CLI 后缀」推导标题。 */
function deriveTerminalTitle(opts: CreateTabOptions): string {
  if (opts.customTitle) return opts.customTitle;
  const { projectPath, ssh, wsl, cliTool, resumeId, machineName } = opts;
  const name = projectPath.split(/[/\\]/).pop() || "Terminal";
  if (ssh) return `[${machineName || "SSH"}] ${name}`;
  if (cliTool && cliTool !== "none") {
    const toolLabel = cliTool.charAt(0).toUpperCase() + cliTool.slice(1);
    return wsl ? `${name} (${toolLabel} WSL)` : `${name} (${toolLabel})`;
  }
  if (resumeId === "new") return `${name} (Claude)`;
  if (resumeId) return `${name} (resume)`;
  return name;
}

/**
 * 新终端 leaf。sessionId 由调用方（已先建 PTY 的入口）可选带入。
 *
 * `terminalPaneId` 同理：后端派发的会话在建 PTY 时就把它写进了出生凭证，
 * 这里必须原样采用，另起 id 会让凭证锚点对不上真实窗格、重启后无法自动接管。
 */
export function createTerminalLeaf(opts: CreateTabOptions): TerminalPaneLeaf {
  return {
    type: "leaf",
    id: opts.terminalPaneId ?? generateId("terminal-pane"),
    launchId: opts.launchId ?? generateId("launch"),
    restoreMode: resolveRestoreMode({
      cliTool: inferCliTool(opts.cliTool, opts.resumeId),
      resumeId: opts.resumeId,
    }),
    sessionId: opts.sessionId ?? null,
    resumeId: opts.resumeId,
    workspaceName: opts.workspaceName,
    providerId: opts.providerId,
    modelId: opts.modelId,
    providerSelection: opts.providerSelection,
    launchProfileId: opts.launchProfileId,
    workspacePath: opts.workspacePath,
    workspaceSnapshotId: opts.workspaceSnapshotId,
    cliTool: opts.cliTool,
    launchClaude: (opts.cliTool && opts.cliTool !== "none") || undefined,
    ssh: opts.ssh,
    wsl: opts.wsl,
    machineName: opts.machineName,
    launchExtras: opts.launchExtras,
  };
}

/**
 * 终端标签的字段默认值（不含 `id`/`contentType`——那两个由 createTabOfType 的
 * 公共底座给）。tab 侧字段一律从 leaf 回读，双写口径与搬家前一致。
 */
export function terminalTabDefaults(opts: CreateTabOptions): Partial<Tab> {
  const terminalLeaf = createTerminalLeaf(opts);
  return {
    title: deriveTerminalTitle(opts),
    projectId: opts.projectId,
    projectPath: opts.projectPath,
    sessionId: terminalLeaf.sessionId,
    resumeId: terminalLeaf.resumeId,
    resumeIdSource: terminalLeaf.resumeIdSource,
    workspaceName: terminalLeaf.workspaceName,
    providerId: terminalLeaf.providerId,
    modelId: terminalLeaf.modelId,
    providerSelection: terminalLeaf.providerSelection,
    launchProfileId: terminalLeaf.launchProfileId,
    workspacePath: terminalLeaf.workspacePath,
    workspaceSnapshotId: terminalLeaf.workspaceSnapshotId,
    cliTool: terminalLeaf.cliTool,
    launchClaude: terminalLeaf.launchClaude,
    ssh: terminalLeaf.ssh,
    wsl: terminalLeaf.wsl,
    machineName: terminalLeaf.machineName,
    terminalRootPane: terminalLeaf,
    activeTerminalPaneId: terminalLeaf.id,
    parentTabId: opts.parentTabId,
    launchExtras: terminalLeaf.launchExtras,
    // launchError 不物化到 tab（批5 绞杀第一段：leaf 单源，tab 同名字段仅 legacy 兜底）
    launchAttempt: terminalLeaf.launchAttempt,
  };
}
