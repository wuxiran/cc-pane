import type { TerminalOutput } from "@/types";

export interface CCChanSettings {
  aiEngine: "claude" | "codex";
  defaultPetId: string;
  autoStart: boolean;
  soundEnabled: boolean;
  windowVisible: boolean;
  windowX: number | null;
  windowY: number | null;
}

export interface PetMeta {
  id: string;
  displayName: string;
  description: string;
  spritesheetUrl: string;
  atlas: { cellW: number; cellH: number; cols: number; rows: number };
  animations: Record<string, { row: number; frames: number; fps: number; colOffset?: number }>;
}

export interface CCChanEvent {
  kind: "task-complete" | "task-failed" | "task-waiting";
  sessionId: string;
  title: string | null;
  ok: boolean;
  ts: number;
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
