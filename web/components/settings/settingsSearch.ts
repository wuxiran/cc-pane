import type {
  SettingsPaneDefinition,
  SettingsPaneId,
  SettingsSearchEntry,
} from "./settingsRegistry";

export type SettingsMatchLayer = "pane" | "entry" | "description" | "keywords";

export interface SettingsSearchResult {
  id: string;
  paneId: SettingsPaneId;
  targetSectionId: string;
  title: string;
  description?: string;
  keywords?: string;
  score: number;
  layer: SettingsMatchLayer;
}

export type SettingsTranslator = (key: string) => string;

export interface SettingsCommandTarget {
  pane: SettingsPaneDefinition;
  entry: SettingsSearchEntry;
}

const LAYER_SCORES: Record<SettingsMatchLayer, number> = {
  pane: 900,
  entry: 700,
  description: 500,
  keywords: 300,
};

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

export function getSettingsCommandTargets(
  panes: readonly SettingsPaneDefinition[],
): SettingsCommandTarget[] {
  return panes.flatMap((pane) => pane.searchEntries.map((entry) => ({ pane, entry })));
}

function includesQuery(value: string | undefined, query: string): boolean {
  return value ? normalize(value).includes(query) : false;
}

function entryResult(
  pane: SettingsPaneDefinition,
  entry: SettingsSearchEntry,
  translate: SettingsTranslator,
  query: string,
): SettingsSearchResult | null {
  const title = translate(entry.titleKey);
  const description = entry.descriptionKey ? translate(entry.descriptionKey) : undefined;
  const keywords = entry.keywordsKey ? translate(entry.keywordsKey) : undefined;
  const matchedLayer: SettingsMatchLayer | null = includesQuery(title, query)
    ? "entry"
    : includesQuery(description, query)
      ? "description"
      : includesQuery(keywords, query)
        ? "keywords"
        : null;
  if (!matchedLayer) return null;
  return {
    id: `${pane.id}:${entry.id}`,
    paneId: pane.id,
    targetSectionId: entry.targetSectionId,
    title,
    description,
    keywords,
    score: LAYER_SCORES[matchedLayer],
    layer: matchedLayer,
  };
}

export function searchSettings(
  panes: readonly SettingsPaneDefinition[],
  translate: SettingsTranslator,
  rawQuery: string,
): SettingsSearchResult[] {
  const query = normalize(rawQuery);
  if (!query) return [];

  const results: Array<SettingsSearchResult & { order: number }> = [];
  panes.forEach((pane, paneIndex) => {
    const paneTitle = translate(pane.titleKey);
    if (includesQuery(paneTitle, query)) {
      results.push({
        id: `${pane.id}:pane`,
        paneId: pane.id,
        targetSectionId: `${pane.id}-root`,
        title: paneTitle,
        score: LAYER_SCORES.pane,
        layer: "pane",
        order: paneIndex * 1000,
      });
    }
    pane.searchEntries.forEach((entry, entryIndex) => {
      const result = entryResult(pane, entry, translate, query);
      if (result) results.push({ ...result, order: paneIndex * 1000 + entryIndex + 1 });
    });
  });

  return results
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .map(({ order: _order, ...result }) => result);
}
