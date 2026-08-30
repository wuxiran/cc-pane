// 每引擎的模型偏好缓存（localStorage）。
//
// ACP 的模型列表要等 session/new 握手后才知道，启动页无从枚举。折衷：每次
// 会话启动/模型切换时把该引擎的模型表与偏好落缓存，下次启动页就能直接选，
// 启动成功后自动 set_model 应用。首次使用某引擎时下拉不显示（诚实降级）。

import type { AcpSessionModel } from "@/types/agentChat";

const STORAGE_KEY = "ccpanes.acpEngineModelPrefs";

export interface EngineModelPrefs {
  models: AcpSessionModel[];
  /** null = 跟随引擎默认，不主动 set_model。 */
  preferredModelId: string | null;
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
  return prefs;
}

/** 会话握手后回填模型表；保留既有偏好（模型消失则清掉）。 */
export function saveEngineModels(engineId: string, models: AcpSessionModel[]): void {
  if (models.length === 0) return;
  const map = loadAll();
  const previous = map[engineId];
  const preferred = previous?.preferredModelId ?? null;
  map[engineId] = {
    models,
    preferredModelId:
      preferred && models.some((model) => model.modelId === preferred) ? preferred : null,
  };
  saveAll(map);
}

export function savePreferredModel(engineId: string, modelId: string | null): void {
  const map = loadAll();
  const previous = map[engineId];
  map[engineId] = {
    models: previous?.models ?? [],
    preferredModelId: modelId,
  };
  saveAll(map);
}
