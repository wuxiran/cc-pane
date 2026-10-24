// Evaluated before the lazy browser controls render; the toolbar title stays eager.
import i18n from "./index";
import en from "./locales/en/browserTools.json";
import zh from "./locales/zh-CN/browserTools.json";

i18n.addResourceBundle("en", "browserTools", en, true, true);
i18n.addResourceBundle("zh-CN", "browserTools", zh, true, true);
