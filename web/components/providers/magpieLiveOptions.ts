import type { MagpieCatalog, MagpieCatalogEntry } from "@/types/magpie";
import type { ProviderModel } from "@/types/provider";

/** 模型下拉里实时 Magpie 段最多列多少个模型（路由组全列）。 */
export const MAGPIE_LIVE_MODEL_LIMIT = 200;

export interface MagpieLiveOptions {
  groups: MagpieCatalogEntry[];
  models: MagpieCatalogEntry[];
  /** 实时段里出现的全部 id（含被截掉的模型），用于判断「已选的不是失效模型」。 */
  ids: Set<string>;
}

/**
 * 实时目录 → 模型下拉的附加段：去掉供应商模型表里已有的（避免同一 id 两项），
 * 路由组在前、模型截到上限（已选的那个除外）。目录不可用时三者皆空。
 */
export function magpieLiveOptions(
  catalog: MagpieCatalog | null,
  providerModels: readonly ProviderModel[],
  selectedModelId?: string | null,
): MagpieLiveOptions {
  if (!catalog?.available) return { groups: [], models: [], ids: new Set() };
  const configured = new Set(providerModels.map((model) => model.id));
  const fresh = (entry: MagpieCatalogEntry) => !configured.has(entry.id);
  const groups = catalog.groups.filter(fresh);
  const allModels = catalog.models.filter(fresh);
  const models = allModels.slice(0, MAGPIE_LIVE_MODEL_LIMIT);
  // 已选的模型被截掉时补回来，下拉才能显示成已选。
  const selected = allModels.find((entry) => entry.id === selectedModelId);
  if (selected && !models.includes(selected)) models.push(selected);
  return {
    groups,
    models,
    ids: new Set([...groups, ...allModels].map((entry) => entry.id)),
  };
}
