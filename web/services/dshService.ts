import { invoke } from "@tauri-apps/api/core";

/**
 * 一个托管中的 DeepSeek Harness（dsh）实例。
 *
 * dsh 是 profile 启动器而非 TUI——它的界面是浏览器 UI，所以这里承载的是
 * 「一个本地 Web 服务的地址」，由浏览器窗格导航过去。每个标签一个进程、
 * 各自独立 `$DSH_HOME`（dsh 的持久化是单写者模型，共享会静默丢数据）。
 */
export interface DshInstance {
  tabId: string;
  port: number;
  pid: number;
  dshHome: string;
  /** 浏览器窗格要导航的地址，形如 `http://127.0.0.1:<port>` */
  url: string;
}

export const dshService = {
  /**
   * 启动该标签的 dsh 实例并返回其地址。
   *
   * 幂等：同一 `workspacePath` 的实例已在跑就复用它（只登记一次引用），
   * 所以窗格重挂载不会起第二个进程——React 19 严格模式 dev 下双挂载时尤其重要。
   *
   * 实例按**工作空间**而非标签划分：API key（存在 dsh 自己的
   * `.credentials.yaml` 里）、工作区注册与会话历史因此在同工作空间的
   * 标签间共享，不必每开一个新标签重填一次。
   *
   * 注入（MCP / skills / hooks / provider）全部在 Rust 侧装配，各项**可缺失**：
   * orchestrator 没起来就没有 MCP，hook 桥装不上就没有 hooks，都不阻断启动。
   */
  start(tabId: string, projectDir?: string, workspacePath?: string): Promise<DshInstance> {
    return invoke("start_dsh_instance", {
      tabId,
      projectDir: projectDir ?? null,
      workspacePath: workspacePath ?? null,
    });
  },

  /**
   * 释放该标签对实例的引用。**最后一个标签走了才真停进程**——同工作空间的
   * 其他标签还开着时返回 false（没有真停）。
   */
  stop(tabId: string): Promise<boolean> {
    return invoke("stop_dsh_instance", { tabId });
  },

  list(): Promise<DshInstance[]> {
    return invoke("list_dsh_instances");
  },

  get(tabId: string): Promise<DshInstance | null> {
    return invoke("get_dsh_instance", { tabId });
  },
};
