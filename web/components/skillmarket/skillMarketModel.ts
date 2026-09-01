// 技能市场的纯函数层：分类、精选挑选、过滤、展示格式化。
// 不碰 store / 网络，方便单测；数据获取在 useSkillMarket。
import type { SkillMarketEntry } from "@/types";

/** 分类页签顺序（与后端 CATEGORY_IDS 一致；"other" 永远压底） */
export const CATEGORY_ORDER = [
  "dev",
  "docs",
  "data",
  "learning",
  "agent",
  "productivity",
  "content",
  "work",
  "search",
  "design",
  "life",
  "other",
] as const;

export type SkillCategory = (typeof CATEGORY_ORDER)[number];
export type CategoryFilter = SkillCategory | "all";

const CATEGORY_SET: ReadonlySet<string> = new Set(CATEGORY_ORDER);

export function categoryOf(entry: SkillMarketEntry): SkillCategory {
  const raw = entry.category?.trim();
  return raw && CATEGORY_SET.has(raw) ? (raw as SkillCategory) : "other";
}

/** 只保留目录里实际出现过的分类，避免一排空页签 */
export function presentCategories(entries: readonly SkillMarketEntry[]): SkillCategory[] {
  const present = new Set(entries.map(categoryOf));
  return CATEGORY_ORDER.filter((category) => present.has(category));
}

export function filterByCategory(
  entries: readonly SkillMarketEntry[],
  category: CategoryFilter,
): SkillMarketEntry[] {
  if (category === "all") return [...entries];
  return entries.filter((entry) => categoryOf(entry) === category);
}

/**
 * 精选横排：先取显式 featured，再用 recommended 的安装量补位，最多 max 条。
 * 不重复、保持输入相对顺序（后端已按 recommended / 分类 / 名称排好）。
 */
export function pickFeatured(entries: readonly SkillMarketEntry[], max = 8): SkillMarketEntry[] {
  const featured = entries.filter((entry) => entry.featured);
  if (featured.length >= max) return featured.slice(0, max);
  const seen = new Set(featured.map((entry) => entry.id));
  const fillers = entries
    .filter((entry) => !seen.has(entry.id) && entry.recommended)
    .sort((left, right) => (right.installs ?? 0) - (left.installs ?? 0));
  return [...featured, ...fillers].slice(0, max);
}

/** 1234 → "1.2k"，1234567 → "1.2M"；用于卡片角标，不做本地化数字格式 */
export function formatInstalls(count: number | null | undefined): string | null {
  if (count == null || count <= 0) return null;
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${trimZero(count / 1000)}k`;
  return `${trimZero(count / 1_000_000)}M`;
}

function trimZero(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

const TAG_TONES = ["blue", "purple", "cyan", "green", "amber", "pink"] as const;
export type TagTone = (typeof TAG_TONES)[number];

/** 名称哈希到固定色板，让同一技能的图标底色稳定 */
export function toneFor(name: string): TagTone {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  return TAG_TONES[hash % TAG_TONES.length];
}

/** 卡片图标字：取名称首个字母/汉字，大写 */
export function iconGlyph(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const first = Array.from(trimmed)[0];
  return first.toUpperCase();
}

/** GitHub 仓库短名（owner/repo）；skills.sh 条目的 homepage 是 skills.sh 页面，仍以 repo 为主 */
export function repoLabel(entry: SkillMarketEntry): string | null {
  const repo = entry.repo?.trim();
  return repo ? repo : null;
}

export type SourceLabelKey = "sources.curated" | "sources.anthropics" | "sources.skills-sh";

/** 来源 → i18n 键；后端未知来源按精选清单显示 */
export function sourceLabelKey(source: string): SourceLabelKey {
  switch (source) {
    case "anthropics":
      return "sources.anthropics";
    case "skills-sh":
      return "sources.skills-sh";
    default:
      return "sources.curated";
  }
}

/** 需要补描述的条目（搜索结果常见）：有仓库、没描述 */
export function needsDescription(entry: SkillMarketEntry): boolean {
  return Boolean(entry.repo) && !(entry.description && entry.description.trim());
}
