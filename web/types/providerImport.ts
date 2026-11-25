// 外部导入（cc-switch / Magpie）里依赖本地网关的条目与带原因的略过项（镜像后端 external_provider_import）。

/** 依赖本地网关运行的导入条目（镜像后端 `ExternalRelayInfo`）。 */
export interface ExternalRelayInfo {
  kind: "magpie_group" | "cc_switch_proxy";
  /** 路由方式（Magpie：smart / order / rotate / usage / pace…；cc-switch：failover）。 */
  routing?: string | null;
  /** 路由组成员数 / cc-switch 故障转移队列里的供应商数。 */
  memberCount?: number | null;
  note: string;
}

/** 预览里带原因略过的一条（不含密钥）。 */
export interface ExternalSkippedItem {
  name: string;
  reason: string;
}
