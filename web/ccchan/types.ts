import type { TerminalOutput } from "@/types";

export interface CCChanSettings {
  aiEngine: "claude" | "codex";
  defaultPetId: string;
  autoStart: boolean;
  soundEnabled: boolean;
  windowVisible: boolean;
  windowX: number | null;
  windowY: number | null;
  wanderEnabled: boolean;
  petSize: number;
}

export interface PetMeta {
  id: string;
  displayName: string;
  description: string;
  spritesheetUrl: string;
  atlas: { cellW: number; cellH: number; cols: number; rows: number };
  animations: Record<string, { row: number; frames: number; fps: number; colOffset?: number }>;
  /** 像素风精灵：缩放用最近邻（pixelated）；缺省为插画风平滑缩放。 */
  pixelArt?: boolean;
}

export interface CCChanEvent {
  kind: "task-complete" | "task-failed" | "task-waiting";
  sessionId: string;
  title: string | null;
  ok: boolean;
  ts: number;
}

export interface CCChanChatOutputPayload {
  sessionId: string;
  role: "assistant";
  text: string;
}

export interface CCChanChatStatusPayload {
  sessionId: string;
  status: "starting" | "thinking" | "ready" | "exited" | "error";
  message?: string | null;
}

export type CCChanPetState =
  | "idle"
  | "working"
  | "waiting"
  | "happy"
  | "sad"
  | "thinking"
  | "walking"
  | "jumping";

export type TerminalOutputPayload = TerminalOutput;
