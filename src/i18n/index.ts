import i18n from "i18next";
import { initReactI18next } from "react-i18next";

// zh-CN
import zhCommon from "./locales/zh-CN/common.json";
import zhSidebar from "./locales/zh-CN/sidebar.json";
import zhSettings from "./locales/zh-CN/settings.json";
import zhPanes from "./locales/zh-CN/panes.json";
import zhDialogs from "./locales/zh-CN/dialogs.json";
import zhErrors from "./locales/zh-CN/errors.json";
import zhShortcuts from "./locales/zh-CN/shortcuts.json";
import zhNotifications from "./locales/zh-CN/notifications.json";

// en
import enCommon from "./locales/en/common.json";
import enSidebar from "./locales/en/sidebar.json";
import enSettings from "./locales/en/settings.json";
import enPanes from "./locales/en/panes.json";
import enDialogs from "./locales/en/dialogs.json";
import enErrors from "./locales/en/errors.json";
import enShortcuts from "./locales/en/shortcuts.json";
import enNotifications from "./locales/en/notifications.json";

export const defaultNS = "common";
export const resources = {
  "zh-CN": {
    common: zhCommon,
    sidebar: zhSidebar,
    settings: zhSettings,
    panes: zhPanes,
    dialogs: zhDialogs,
    errors: zhErrors,
    shortcuts: zhShortcuts,
    notifications: zhNotifications,
  },
  en: {
    common: enCommon,
    sidebar: enSidebar,
    settings: enSettings,
    panes: enPanes,
    dialogs: enDialogs,
    errors: enErrors,
    shortcuts: enShortcuts,
    notifications: enNotifications,
  },
} as const;

const LANG_STORAGE_KEY = "cc-panes-lang";
const savedLang = localStorage.getItem(LANG_STORAGE_KEY);

i18n.use(initReactI18next).init({
  resources,
  defaultNS,
  fallbackLng: "zh-CN",
  lng: savedLang || "zh-CN",
  interpolation: {
    escapeValue: false, // React 已自动处理 XSS
  },
});

// 语言切换时自动持久化
i18n.on("languageChanged", (lng) => {
  localStorage.setItem(LANG_STORAGE_KEY, lng);
});

export default i18n;
