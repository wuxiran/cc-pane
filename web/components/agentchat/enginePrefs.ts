// 每引擎的模型偏好缓存（localStorage）。
//
// ACP 的模型列表要等 session/new 握手后才知道，启动页无从枚举。折衷：每次
// 会话启动/模型切换时把该引擎的模型表与偏好落缓存，下次启动页就能直接选，
// 启动成功后自动 set_model 应用。首次使用某引擎时下拉不显示（诚实降级）。

import type { AcpSessionMode, AcpSessionModel } from "@/types/agentChat";

const STORAGE_KEY = "ccpanes.acpEngineModelPrefs";

export interface EngineModelPrefs {
  models: AcpSessionModel[];
  /** null = 跟随引擎默认，不主动 set_model。 */
  preferredModelId: string | null;
  /** 会话模式（权限档等）表，同样来自握手缓存。旧缓存无此字段。 */
  modes?: AcpSessionMode[];
  /** null/undefined = 跟随引擎默认，不主动 set_mode。 */
  preferredModeId?: string | null;
  /** 旧字段：整体 YOLO 开关。读取时迁移为 `autoApproveKinds: ["*"]`。 */
  autoApprove?: boolean;
  /** 自动放行的 ACP ToolKind 集合（`*` = 全部）；空/缺失 = 每次都问。 */
  autoApproveKinds?: string[];
}

type PrefsMap = Record<string, EngineModelPrefs>;

function loadAll(): PrefsMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as PrefsMap) : {};
  } catch {
    return {};
  }
}

function saveAll(map: PrefsMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // 存储不可用（隐私模式等）时静默降级为无缓存。
  }
}

export function loadEnginePrefs(engineId: string): EngineModelPrefs | null {
  const prefs = loadAll()[engineId];
  if (!prefs || !Array.isArray(prefs.models)) return null;
  // 旧版单开关 → 新版按类集合（一次性迁移，不回写）。
  if (prefs.autoApproveKinds === undefined && prefs.autoApprove) {
    return { ...prefs, autoApproveKinds: ["*"] };
  }
  return prefs;
}

/** 该引擎的自动放行集合（含旧字段迁移）；无缓存时为空 = 每次都问。 */
export function loadAutoApproveKinds(engineId: string): string[] {
  const prefs = loadAll()[engineId];
  if (!prefs) return [];
  if (Array.isArray(prefs.autoApproveKinds)) return prefs.autoApproveKinds;
  return prefs.autoApprove ? ["*"] : [];
}

function merge(engineId: string, patch: Partial<EngineModelPrefs>): void {
  const map = loadAll();
  const previous = map[engineId] ?? { models: [], preferredModelId: null };
  map[engineId] = { ...previous, ...patch };
  saveAll(map);
}

/** 会话握手后回填模型表；保留既有偏好（模型消失则清掉）。 */
export function saveEngineModels(engineId: string, models: AcpSessionModel[]): void {
  if (models.length === 0) return;
  const preferred = loadAll()[engineId]?.preferredModelId ?? null;
  merge(engineId, {
    models,
    preferredModelId:
      preferred && models.some((model) => model.modelId === preferred) ? preferred : null,
  });
}

/** 会话握手后回填模式表；保留既有偏好（模式消失则清掉）。 */
export function saveEngineModes(engineId: string, modes: AcpSessionMode[]): void {
  if (modes.length === 0) return;
  const preferred = loadAll()[engineId]?.preferredModeId ?? null;
  merge(engineId, {
    modes,
    preferredModeId: preferred && modes.some((mode) => mode.id === preferred) ? preferred : null,
  });
}

export function savePreferredModel(engineId: string, modelId: string | null): void {
  merge(engineId, { preferredModelId: modelId });
}

export function savePreferredMode(engineId: string, modeId: string | null): void {
  merge(engineId, { preferredModeId: modeId });
}

export function saveAutoApproveKinds(engineId: string, autoApproveKinds: string[]): void {
  // 同时清掉旧开关，避免迁移逻辑在下次读取时又把 `*` 加回来。
  merge(engineId, { autoApproveKinds, autoApprove: undefined });
}
