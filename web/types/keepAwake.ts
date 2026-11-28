/** 一侧（app 或 daemon）的保持唤醒状态，对应 Rust `KeepAwakeStatus`。 */
export interface KeepAwakeSideStatus {
  enabled: boolean;
  /** 是否真的持有系统锁 */
  holding: boolean;
  /** 当前在工作的会话 / 对话数 */
  busyCount: number;
}

/** `get_keep_awake_status` 返回值，对应 Rust `KeepAwakeReport`。 */
export interface KeepAwakeReport {
  enabled: boolean;
  /** app 或 daemon 任一侧持锁即为 true */
  holding: boolean;
  app: KeepAwakeSideStatus;
  /** null = 非 daemon 模式、daemon 不可达或旧 daemon 不支持 */
  daemon: KeepAwakeSideStatus | null;
}
