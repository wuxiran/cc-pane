import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useDescriptionLangStore } from "@/stores/useDescriptionLangStore";
import {
  pickLocalized,
  toDescriptionLocale,
  type DescriptionLocale,
  type LocalizedDescriptions,
} from "@/utils/localizedText";

/** 当前介绍语言（已把 auto 解析成具体值）+ 取文案的便捷函数 */
export function useDescriptionLang() {
  const { i18n } = useTranslation();
  const preference = useDescriptionLangStore((s) => s.preference);
  const setPreference = useDescriptionLangStore((s) => s.setPreference);
  const locale: DescriptionLocale =
    preference === "auto" ? toDescriptionLocale(i18n.resolvedLanguage ?? i18n.language) : preference;

  const describe = useCallback(
    (descriptions: LocalizedDescriptions, fallback?: string | null) =>
      pickLocalized(descriptions, locale, fallback),
    [locale],
  );

  return { locale, setLocale: setPreference, describe };
}
