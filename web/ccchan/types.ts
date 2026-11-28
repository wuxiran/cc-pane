export interface CCChanSettings {
  /** 没有 Bot（或 Bot 没选形象）时用的角色。 */
  defaultPetId: string;
  autoStart: boolean;
  windowVisible: boolean;
  /** 物理像素桌面坐标（windowPosPhysical=false 时是旧版本的逻辑像素）。 */
  windowX: number | null;
  windowY: number | null;
  windowPosPhysical: boolean;
  petSize: number;
  /** 桌宠当前代表的 Bot；缺省 / 已删除 = 第一个 Bot，没有 Bot 时用 cc酱。 */
  activeBotId?: string | null;
  /** 外观：桌宠 / 任务球（缺省 = 桌宠）。 */
  appearance: CCChanAppearance;
  /** 任务球列表排序。 */
  orbSort: CCChanOrbSort;
  /** 任务球列表「悬停即切换」。 */
  orbHoverSwitch: boolean;
}

export type CCChanAppearance = "pet" | "orb";
export type CCChanOrbSort = "recent" | "attention";

export interface PetAnimationSpec {
  row: number;
  frames: number;
  fps: number;
  colOffset?: number;
}

export interface PetMeta {
  id: string;
  displayName: string;
  description: string;
  spritesheetUrl: string;
  atlas: { cellW: number; cellH: number; cols: number; rows: number };
  animations: Record<string, PetAnimationSpec>;
  /** 像素风精灵：缩放用最近邻（pixelated）；缺省为插画风平滑缩放。 */
  pixelArt?: boolean;
  /** builtin / user / codex（只读的 ~/.codex/pets）。 */
  source?: string;
}

export interface CCChanEvent {
  kind: "task-complete" | "task-failed" | "task-waiting";
  sessionId: string;
  ok: boolean;
  ts: number;
}

/** 主窗口推给宠物窗口的会话目录：会话名 + 用户是否正在看它。 */
export interface SessionDirectoryEntry {
  sessionId: string;
  title: string;
  /** 主窗口聚焦且该会话所在标签可见。 */
  viewed: boolean;
  /** 最后一次真实键盘输入（主窗口 useTerminalInputActivityStore）；切换会话不算。 */
  lastInputAt?: number | null;
  /** 主窗口当前激活面板里的那个会话（任务球「当前」，不进列表）。 */
  active?: boolean;
}

export interface SessionDirectoryPayload {
  sessions: SessionDirectoryEntry[];
}
