export type AiPanelFormat = "html" | "markdown";

export interface AiPanel {
  panelId: string;
  title: string;
  format: AiPanelFormat;
  content: string;
  driverName: string;
  updatedAt: string;
}

export interface AiPanelChangedEvent {
  operation: "open" | "update" | "close";
  panelId: string;
  panel?: AiPanel;
}
