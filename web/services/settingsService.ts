/**
 * 设置服务 - 与后端设置交互
 */

import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, DataDirInfo } from "@/types/settings";

export const settingsService = {
  async getSettings(): Promise<AppSettings> {
    return invoke<AppSettings>("get_settings");
  },

  async updateSettings(settings: AppSettings): Promise<void> {
    return invoke("update_settings", { settings });
  },

  async testProxy(): Promise<boolean> {
    return invoke<boolean>("test_proxy");
  },

  async getDataDirInfo(): Promise<DataDirInfo> {
    return invoke<DataDirInfo>("get_data_dir_info");
  },

  async migrateDataDir(targetDir: string): Promise<void> {
    return invoke("migrate_data_dir", { targetDir });
  },

  async generateClaudeMd(): Promise<void> {
    return invoke<void>("generate_claude_md");
  },
};
