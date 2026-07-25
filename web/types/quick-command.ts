import type { CliTool } from "./terminal";

export type QuickCommandKind = "terminal" | "agentPrompt";
export type QuickCommandTarget = "currentPane" | "newTab";
export type QuickCommandScope = "global" | "project";

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
