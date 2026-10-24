// Evaluated before the lazy review panel renders, so no untranslated frame is shown.
import i18n from "./index";
import en from "./locales/en/review.json";
import zh from "./locales/zh-CN/review.json";

i18n.addResourceBundle("en", "review", en, true, true);
i18n.addResourceBundle("zh-CN", "review", zh, true, true);
