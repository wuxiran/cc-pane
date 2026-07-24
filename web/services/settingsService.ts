/**
 * 设置服务 - 与后端设置交互
 */

import type {
  AppSettings,
  DataDirInfo,
  TailscaleStatus,
  UninstallCleanupReport,
  WebAccessStatus,
} from "@/types/settings";
import { invoke } from "@tauri-apps/api/core";
import { apiGet, apiJson, invokeOrApi, isTauriRuntime } from "./apiClient";

export const settingsService = {
  async getSettings(): Promise<AppSettings> {
    return invokeOrApi<AppSettings>("get_settings", undefined, () =>
      apiGet<AppSettings>("/api/settings"),
    );
  },

  async updateSettings(settings: AppSettings): Promise<void> {
    return invokeOrApi<void>("update_settings", { settings }, () =>
      apiJson<void>("/api/settings", "PUT", settings),
    );
  },

  async setWebAccessPassword(password: string): Promise<void> {
    return invokeOrApi<void>("set_web_access_password", { password }, () =>
      apiJson<void>("/api/settings/web-access/password", "POST", { password }),
    );
  },

  /** 探测本机 Tailscale 状态（仅桌面端；web 运行时返回 null 并隐藏引导区块） */
  async detectTailscaleStatus(): Promise<TailscaleStatus | null> {
    if (!isTauriRuntime()) return null;
    return invoke<TailscaleStatus>("detect_tailscale_status");
  },

  async getWebAccessStatus(): Promise<WebAccessStatus> {
    return invokeOrApi<WebAccessStatus>("get_web_access_status", undefined, async () => {
      const settings = await apiGet<AppSettings>("/api/settings");
      return {
        enabled: settings.webAccess.enabled,
        running: true,
        pid: null,
        url: window.location.origin + "/",
        bindHost: window.location.hostname,
        port: settings.webAccess.port,
        lanRequested: settings.webAccess.allowLan,
        lanActive: settings.webAccess.allowLan && settings.webAccess.authEnabled && Boolean(settings.webAccess.passwordHash),
        authRequired: settings.webAccess.authEnabled && Boolean(settings.webAccess.passwordHash),
        passwordConfigured: Boolean(settings.webAccess.passwordHash),
      };
    });
  },

  async startWebAccess(): Promise<WebAccessStatus> {
    return invokeOrApi<WebAccessStatus>("start_web_access", undefined, () =>
      this.getWebAccessStatus(),
    );
  },

  async stopWebAccess(): Promise<WebAccessStatus> {
    return invokeOrApi<WebAccessStatus>("stop_web_access", undefined, () =>
      this.getWebAccessStatus(),
    );
  },

  /// 停止终端 daemon（更新前调用，释放 cc-panes-daemon.exe 文件锁）。桌面端专用；
  /// 非 Tauri 运行时无 daemon，fallback 为 no-op。
  async stopTerminalDaemon(): Promise<void> {
    return invokeOrApi<void>("stop_terminal_daemon", undefined, async () => {});
  },

  async restartWebAccess(): Promise<WebAccessStatus> {
    return invokeOrApi<WebAccessStatus>("restart_web_access", undefined, () =>
      this.getWebAccessStatus(),
    );
  },

  async openWebAccess(): Promise<void> {
    return invokeOrApi<void>("open_web_access", undefined, async () => {
      window.open(window.location.origin + "/", "_blank", "noopener,noreferrer");
    });
  },

  async testProxy(): Promise<boolean> {
    return invokeOrApi<boolean>("test_proxy", undefined, async () => false);
  },

  async testCliLauncher(command: string, versionArgs?: string[]): Promise<string> {
    return invokeOrApi<string>(
      "test_cli_launcher",
      { command, versionArgs },
      async () => {
        throw new Error("CLI launcher testing is only available in the desktop app");
      },
    );
  },

  async getDataDirInfo(): Promise<DataDirInfo> {
    return invokeOrApi<DataDirInfo>("get_data_dir_info", undefined, async () => ({
      currentPath: "",
      defaultPath: "",
      isDefault: true,
      sizeBytes: 0,
    }));
  },

  async migrateDataDir(targetDir: string): Promise<void> {
    return invokeOrApi<void>("migrate_data_dir", { targetDir }, async () => {
      throw new Error("Data directory migration is only available in the desktop app");
    });
  },

  async cleanupBeforeUninstall(): Promise<UninstallCleanupReport> {
    return invokeOrApi<UninstallCleanupReport>("cleanup_before_uninstall", undefined, async () => {
      throw new Error("Uninstall cleanup is only available in the desktop app");
    });
  },

  async generateClaudeMd(): Promise<void> {
    return invokeOrApi<void>("generate_claude_md", undefined, async () => {
      throw new Error("Claude.md generation is only available in the desktop app");
    });
  },
};
