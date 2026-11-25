// 分层原生 CLI 配置：预览 / 片段校验 / 从外部来源补充原生配置（封装 invoke）。
import { invokeOrApi } from "./apiClient";
import type { LaunchProfileDraft, NativeConfigIssue, NativeConfigPreview } from "@/types";
import type { ExternalProviderSource } from "@/types/provider";

const desktopOnly = (feature: string) => async (): Promise<never> => {
  throw new Error(`${feature} is only available in the desktop app`);
};

export const nativeConfigService = {
  /** 运行配置草稿（可未保存）+ CLI → 生效配置（每个键带来源层）、各运行位置是否生效、校验问题。 */
  preview(draft: LaunchProfileDraft, cliTool: string): Promise<NativeConfigPreview> {
    return invokeOrApi<NativeConfigPreview>(
      "preview_launch_profile_native_config",
      { draft, cliTool },
      desktopOnly("Native config preview"),
    );
  },

  /** 只校验一个片段：空数组 = 可以保存。 */
  validate(cliTool: string, text: string): Promise<NativeConfigIssue[]> {
    return invokeOrApi<NativeConfigIssue[]>(
      "validate_native_config_fragment",
      { cliTool, text },
      desktopOnly("Native config validation"),
    );
  },

  /**
   * 快捷开关：在片段原文里设置（`value` 非 null）或删除（`value` 为 null）一个点分键，返回新原文。
   * 只改文本不落盘；片段本身有语法错误时 reject，不覆盖原文。
   */
  setKey(cliTool: string, fragment: string, key: string, value: string | number | boolean | null): Promise<string> {
    return invokeOrApi<string>(
      "set_native_config_key",
      { cliTool, fragment, key, value },
      desktopOnly("Native config quick toggles"),
    );
  },

  /** 「补充原生配置」：只填已存在中转站里空着的片段与模型上下文窗口。返回改动的中转站数。 */
  supplementExternalProviders(source: ExternalProviderSource, keys: string[]): Promise<number> {
    return invokeOrApi<number>(
      "supplement_external_providers",
      { source, keys },
      desktopOnly("Importing providers"),
    );
  },
};
