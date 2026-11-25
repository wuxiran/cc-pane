/**
 * 从本机 Chromium 系浏览器（目前仅 macOS）一次性导入 cookies 到内置浏览器。
 * 后端命令：`list_browser_import_sources` / `import_browser_cookies`。
 */
import { invoke } from "@tauri-apps/api/core";

export interface BrowserImportProfile {
  /** 配置目录名，如 `Default`、`Profile 2` */
  id: string;
  name: string;
}

export interface BrowserImportSource {
  /** 浏览器标识，如 `chrome`、`brave`、`edge` */
  id: string;
  name: string;
  profiles: BrowserImportProfile[];
}

export interface BrowserCookieImportResult {
  imported: number;
  skipped: number;
  failed: number;
  domains: number;
}

/** 后端返回的错误码（`AppError.code`）。 */
export const BROWSER_IMPORT_ERROR_CODES = [
  "BROWSER_IMPORT_UNSUPPORTED_PLATFORM",
  "BROWSER_IMPORT_SOURCE_NOT_FOUND",
  "BROWSER_IMPORT_KEYCHAIN_DENIED",
  "BROWSER_IMPORT_KEYCHAIN_NOT_FOUND",
  "BROWSER_IMPORT_READ_FAILED",
  "BROWSER_IMPORT_NO_WEBVIEW",
] as const;

export type BrowserImportErrorCode = (typeof BROWSER_IMPORT_ERROR_CODES)[number];

export const browserImportService = {
  listSources(): Promise<BrowserImportSource[]> {
    return invoke<BrowserImportSource[]>("list_browser_import_sources");
  },
  importCookies(source: string, profile: string): Promise<BrowserCookieImportResult> {
    return invoke<BrowserCookieImportResult>("import_browser_cookies", { source, profile });
  },
};
