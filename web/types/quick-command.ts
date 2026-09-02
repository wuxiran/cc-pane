import type { CliTool } from "./terminal";

export type QuickCommandKind = "terminal" | "agentPrompt";
export type QuickCommandTarget = "currentPane" | "newTab";
/** 解析顺序 project → workspace → global；workspace 是 workspace-first 的默认层（docs/98） */
export type QuickCommandScope = "global" | "workspace" | "project";

export interface QuickCommand {
  id: string;
  name: string;
  kind: QuickCommandKind;
  text: string;
  appendEnter: boolean;
  target: QuickCommandTarget;
  cliTool?: CliTool;
  createdAt: string;
  updatedAt: string;
}

export type QuickCommandDraft = Omit<
  QuickCommand,
  "id" | "createdAt" | "updatedAt"
>;

export type ScopedQuickCommand = QuickCommand & { scope: QuickCommandScope };
