// Loaded with TaskVerificationCard; its loading/entry title stays available at startup.
import i18n from "./index";
import en from "./locales/en/taskVerification.json";
import zh from "./locales/zh-CN/taskVerification.json";

i18n.addResourceBundle("en", "orchestration", en, true, true);
i18n.addResourceBundle("zh-CN", "orchestration", zh, true, true);
