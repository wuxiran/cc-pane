export type AiPanelFormat = "html" | "markdown";

/** 调用方请求的展示形态（MCP 入参）。 */
export type AiPanelDisplay = "auto" | "dialog" | "dock" | "silent";

/** 前端回给调用方的真实投递结果。 */
export type AiPanelDelivery = "dialog" | "dock" | "unread" | "disabled";

export interface AiPanel {
  panelId: string;
  title: string;
  format: AiPanelFormat;
  content: string;
  driverName: string;
  updatedAt: string;
}

/** 历史列表项：不含正文，正文按需单独取（单个上限 256 KiB）。 */
export interface AiPanelSummary {
  panelId: string;
  /** null 表示该面板没有 TaskBinding，归入「未归类」分组。 */
  workspaceName: string | null;
  projectPath: string | null;
  title: string;
  format: AiPanelFormat;
  driverName: string;
  /** null 表示无人持有，可被任意会话认领。 */
  ownerSessionId: string | null;
  contentBytes: number;
  createdAt: string;
  updatedAt: string;
}

/** 历史面板正文（`get_ai_panel_content` 的返回）。 */
export interface StoredAiPanel extends Omit<AiPanelSummary, "contentBytes"> {
  content: string;
}

/** 历史列表按工作空间分组后的一组。 */
export interface AiPanelWorkspaceGroup {
  workspaceName: string | null;
  panels: AiPanelSummary[];
}

export interface AiPanelChangedEvent {
  operation: "open" | "update" | "close";
  panelId: string;
  panel?: AiPanel;
  /** 旧后端不带此字段，缺失按 "auto" 处理。 */
  display?: AiPanelDisplay;
  /** 缺失表示本次不需要回执（如 close，或旧后端）。 */
  deliveryId?: string;
}
