// 「介绍」类文案的双语层：后端给 { "zh-CN": …, "en": … }，前端按开关取一份，取不到再回落原文。
export const DESCRIPTION_LOCALES = ["zh-CN", "en"] as const;
export type DescriptionLocale = (typeof DESCRIPTION_LOCALES)[number];

export type LocalizedDescriptions = Partial<Record<string, string>> | null | undefined;

/** i18n 里的 `zh`, `zh-Hans`, `en-US` 之类归到两种介绍语言 */
export function toDescriptionLocale(language: string | undefined): DescriptionLocale {
  return language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/**
 * 取当前语言的介绍；缺失时依次回落：另一种语言 → 原文。
 * 返回 `null` 表示什么都没有，调用方自己决定占位。
 */
export function pickLocalized(
  descriptions: LocalizedDescriptions,
  locale: DescriptionLocale,
  fallback?: string | null,
): string | null {
  const own = descriptions?.[locale]?.trim();
  if (own) return own;
  const other = DESCRIPTION_LOCALES.find((candidate) => candidate !== locale);
  const alternate = other ? descriptions?.[other]?.trim() : undefined;
  if (alternate) return alternate;
  const raw = fallback?.trim();
  return raw ? raw : null;
}

/** 是否真的有两份不同语言的文案（有才值得给用户切换） */
export function hasBothLocales(descriptions: LocalizedDescriptions): boolean {
  return DESCRIPTION_LOCALES.every((locale) => Boolean(descriptions?.[locale]?.trim()));
}
