// 开发环境探测：Node.js / Git / WSL / CLI 工具安装状态（首启预检与设置页共用）。
// 从 terminalService 拆出（行数棘轮约束），语义不变。
import { invokeOrApi } from "./apiClient";
import type { EnvironmentInfo } from "@/types";
import type { EnvironmentInfoRaw } from "@/types/settings";

/** 将 Rust 返回的 cliTools 数组规范化为含向后兼容字段的 EnvironmentInfo */
export function normalizeEnvironmentInfo(raw: EnvironmentInfoRaw): EnvironmentInfo {
  const findTool = (id: string) => {
    const tool = raw.cliTools?.find((t) => t.id === id);
    return {
      installed: tool?.installed ?? false,
      version: tool?.version ?? null,
    };
  };
  return {
    ...raw,
    git: raw.git ?? { installed: false, version: null },
    wsl: raw.wsl ?? { installed: false, version: null, applicable: false },
    cliTools: raw.cliTools ?? [],
    claude: findTool("claude"),
    codex: findTool("codex"),
  };
}

/** 检测开发环境（Node.js + Git + WSL + CLI 工具） */
export async function checkEnvironment(): Promise<EnvironmentInfo> {
  const raw = await invokeOrApi<EnvironmentInfoRaw>("check_environment", undefined, async () => ({
    node: { installed: false, version: null },
    git: { installed: false, version: null },
    wsl: { installed: false, version: null, applicable: false },
    cliTools: [],
  }));
  return normalizeEnvironmentInfo(raw);
}
