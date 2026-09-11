/**
 * CLI 工具服务 — 封装 Tauri/API 调用
 */
import type { CliToolInfo } from "@/types";
import { apiGet, invokeOrApi } from "./apiClient";

/** 列出所有已注册的 CLI 工具（含实时检测状态） */
export async function listCliTools(): Promise<CliToolInfo[]> {
  return invokeOrApi<CliToolInfo[]>("list_cli_tools", undefined, () =>
    apiGet<CliToolInfo[]>("/api/cli-tools"),
  );
}

export interface CliToolDetectionProbe {
  /** app 进程侧（与设置页同一份检测）能否解析到这个 CLI */
  installedInApp: boolean;
  /** app 侧解析到的可执行文件路径，作为「确实装着」的实证 */
  resolvedPath: string | null;
}

const DETECTION_PROBE_TIMEOUT_MS = 6000;

/**
 * 启动失败后反查 app 进程侧的 CLI 检测结果。
 *
 * CLI 可执行文件是在 cc-panes-daemon 进程里解析的，而 daemon 的环境是它被拉起那一刻的
 * 快照（Windows 上连 PATH 注入都没有，见 terminal_daemon_lifecycle.rs）；`list_cli_tools`
 * 跑在 app 进程，是另一套环境。两边结论不一致时「未安装」是误判，真正的病因是 launcher
 * 环境陈旧——文案必须分开，否则用户会被引导去重装一个本来就装好的 CLI。
 *
 * 尽力而为：超时/失败/查无此工具一律返回 null，让文案退回保守的「未安装」说法。
 * detect_all 是串行的（每个已装工具还要跑一次 --version，单次 5s 超时），所以这里必须
 * 自带 deadline，不能让失败提示被拖到几十秒后才出现。
 */
export async function probeCliToolDetection(
  toolName: string,
  timeoutMs = DETECTION_PROBE_TIMEOUT_MS,
): Promise<CliToolDetectionProbe | null> {
  const key = toolName.trim().toLowerCase();
  if (!key) return null;
  try {
    const tools = await withDeadline(listCliTools(), timeoutMs);
    const matched = tools.find((tool) => {
      // 老 daemon / web 部署可能少字段：缺字段当成不匹配，别让 TypeError 把取证整个吞掉。
      const id = typeof tool.id === "string" ? tool.id.toLowerCase() : "";
      const executable = typeof tool.executable === "string" ? tool.executable.toLowerCase() : "";
      return id === key || executable === key;
    });
    if (!matched) return null;
    return { installedInApp: matched.installed === true, resolvedPath: matched.path ?? null };
  } catch {
    return null;
  }
}

function withDeadline<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`cli detection probe timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
