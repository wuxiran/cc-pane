// Loaded with the fork dialogs; the entry-point label stays in the eager panes resource.
import i18n from "./index";
import en from "./locales/en/forkReview.json";
import zh from "./locales/zh-CN/forkReview.json";

i18n.addResourceBundle("en", "panes", en, true, true);
i18n.addResourceBundle("zh-CN", "panes", zh, true, true);
