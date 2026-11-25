// 合并模型选择器（ChatModelPicker）的纯逻辑：行表构造、搜索过滤、折叠、⌘数字快捷键、
// 推理档位提取。UI 与存储都不在这里，方便单测。
import type { AcpChatSnapshot, AcpConfigOption } from "@/types/agentChat";

/** 左栏「收藏」项的伪引擎 id（不会与真实 engineId 冲突）。 */
export const FAVORITES_RAIL = "__favorites__";
/** 未展开时中栏显示的行数，其余收进「显示更多」。 */
export const COLLAPSED_ROWS = 5;
/** ⌘1…⌘9。 */
export const MAX_SHORTCUTS = 9;

export interface PickerModelRow {
  engineId: string;
  /** null = 引擎默认（不主动设置模型）。 */
  modelId: string | null;
  label: string;
  description?: string;
}

export interface FavoriteModel {
  engineId: string;
  modelId: string;
}

/** 行的稳定 key（cmdk value / React key 共用）。 */
export function rowKey(row: Pick<PickerModelRow, "engineId" | "modelId">): string {
  return `${row.engineId}\u0000${row.modelId ?? ""}`;
}

export function isFavorite(favorites: readonly FavoriteModel[], row: Pick<PickerModelRow, "engineId" | "modelId">): boolean {
  return row.modelId !== null && favorites.some((item) => item.engineId === row.engineId && item.modelId === row.modelId);
}

/** 切换收藏；引擎默认行（modelId = null）不可收藏，原样返回。 */
export function toggleFavorite(favorites: readonly FavoriteModel[], row: Pick<PickerModelRow, "engineId" | "modelId">): FavoriteModel[] {
  if (row.modelId === null) return [...favorites];
  if (isFavorite(favorites, row)) {
    return favorites.filter((item) => !(item.engineId === row.engineId && item.modelId === row.modelId));
  }
  return [...favorites, { engineId: row.engineId, modelId: row.modelId }];
}

/**
 * 会话快照里的模型表。与 composer 既有口径一致：legacy `models` 在场时优先（会话里走
 * set_model），缺席时才用 configOptions 的 model 类别（走 set_config_option）。
 */
export function snapshotModels(snapshot: AcpChatSnapshot): { rows: PickerModelRow[]; currentId: string | null; configId: string | null } {
  const models = snapshot.models?.availableModels ?? [];
  if (models.length > 0) {
    return {
      rows: models.map((model) => ({
        engineId: snapshot.engineId, modelId: model.modelId, label: model.name || model.modelId, description: model.description,
      })),
      currentId: snapshot.models?.currentModelId ?? null,
      configId: null,
    };
  }
  const config = snapshot.configOptions?.find((option) => option.category === "model");
  return {
    rows: (config?.options ?? []).map((choice) => ({
      engineId: snapshot.engineId, modelId: choice.value, label: choice.name || choice.value, description: choice.description,
    })),
    currentId: config?.currentValue == null ? null : String(config.currentValue),
    configId: config?.configId ?? null,
  };
}

/** 收藏 → 行：能在已知模型表里找到的用其展示名，否则退回 modelId。 */
export function favoriteRows(
  favorites: readonly FavoriteModel[],
  modelsOf: (engineId: string) => readonly PickerModelRow[],
  knownEngine: (engineId: string) => boolean,
): PickerModelRow[] {
  return favorites
    .filter((favorite) => knownEngine(favorite.engineId))
    .map((favorite) => modelsOf(favorite.engineId).find((row) => row.modelId === favorite.modelId)
      ?? { engineId: favorite.engineId, modelId: favorite.modelId, label: favorite.modelId });
}

/** 空白分词、全部命中才算匹配（名称 / id / 引擎名，大小写不敏感）。 */
export function filterRows(
  rows: readonly PickerModelRow[],
  query: string,
  engineLabel: (engineId: string) => string = () => "",
): PickerModelRow[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...rows];
  return rows.filter((row) => {
    const haystack = `${row.label} ${row.modelId ?? ""} ${engineLabel(row.engineId)}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

/** 折叠：搜索中或已展开时全显示；否则前 COLLAPSED_ROWS 行 + 隐藏数。 */
export function visibleRows(
  rows: readonly PickerModelRow[],
  { expanded, query }: { expanded: boolean; query: string },
): { rows: PickerModelRow[]; hidden: number } {
  if (expanded || query.trim() || rows.length <= COLLAPSED_ROWS) return { rows: [...rows], hidden: 0 };
  return { rows: rows.slice(0, COLLAPSED_ROWS), hidden: rows.length - COLLAPSED_ROWS };
}

/** 键盘事件 → 快捷键序号（0 起）；不是 ⌘/Ctrl + 1…9 时为 null。 */
export function shortcutIndex(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  isMac: boolean,
): number | null {
  const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier || event.altKey || event.shiftKey) return null;
  if (!/^[1-9]$/.test(event.key)) return null;
  return Number(event.key) - 1;
}

/** 右栏标题用的短名：去掉括注（如「(recommended)」），空则原样。 */
export function modelShortName(label: string): string {
  const short = label.replace(/\s*[(（][^)）]*[)）]\s*/g, " ").trim();
  return short || label;
}

export interface EffortChoice {
  value: string;
  label: string;
  description?: string;
  isDefault: boolean;
}

export interface EffortControl {
  option: AcpConfigOption;
  current: string | null;
  choices: EffortChoice[];
}

/**
 * 推理档位配置项：ACP `thought_level` 类别，或 Codex App Server 的 `reasoning_effort`
 * （后者不带 category）。只认 select 型且有选项的。
 */
export function isEffortOption(option: AcpConfigOption): boolean {
  return (option.category === "thought_level" || option.configId === "reasoning_effort")
    && (option.type ?? "select") === "select"
    && Array.isArray(option.options) && option.options.length > 0;
}

/**
 * 当前模型实际广告的推理档位。不发明档位：引擎没广告就返回 null。
 * 「默认」只在协议本身给出名为 default 的档位时标注——Codex App Server 的
 * defaultReasoningEffort 不在 configOptions 里，前端无从得知，宁可不标。
 */
export function effortControl(options: readonly AcpConfigOption[] | undefined): EffortControl | null {
  const option = (options ?? []).find(isEffortOption);
  if (!option) return null;
  const current = option.currentValue == null ? null : String(option.currentValue);
  return {
    option,
    current,
    choices: (option.options ?? []).map((choice) => ({
      value: choice.value,
      label: choice.name || choice.value,
      description: choice.description,
      isDefault: choice.value.toLowerCase() === "default",
    })),
  };
}

/** 选择器接管的配置项（model / mode / 推理档位），其余仍由 ConfigOptionSelectors 渲染。 */
export function isPickerManagedOption(option: AcpConfigOption): boolean {
  return option.category === "model" || option.category === "mode" || isEffortOption(option);
}
