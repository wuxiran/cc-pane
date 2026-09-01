/**
 * 全局常量（1:1 对齐 Flutter 版 lib/core/config.dart，单位统一为毫秒/数值）。
 */
export class AppConfig {
  /** 会话列表轮询间隔（ms） */
  static readonly SESSION_POLL_INTERVAL_MS: number = 5000;

  /** HTTP 请求超时（连接/读取，ms） */
  static readonly HTTP_TIMEOUT_MS: number = 10000;

  /** WebSocket 握手超时（ms） */
  static readonly WS_CONNECT_TIMEOUT_MS: number = 10000;

  /** 布局快照陈旧阈值：savedAt 距今超过此值 → 显示 stale 提示（ms）。 */
  static readonly SNAPSHOT_STALE_MS: number = 90000;

  /** 孤儿会话过旧阈值：/api/sessions 里无布局归属且 updatedAt 超此值 → 视为残留，隐藏（ms）。 */
  static readonly ORPHAN_STALE_MS: number = 300000;

  /** 新建会话默认终端尺寸 */
  static readonly DEFAULT_COLS: number = 120;
  static readonly DEFAULT_ROWS: number = 30;

  /** 启动历史拉取条数 */
  static readonly LAUNCH_HISTORY_LIMIT: number = 100;

  /** 会话卡最近输出预览行数（懒加载一次） */
  static readonly OUTPUT_PREVIEW_LINES: number = 2;

  /** 终端 resize 去抖（ms）：conpty 每次 resize 都整屏重绘，高频下发会留残行。
   *  注：Flutter 版 config.dart 的 resizeDebounce 为 250ms，此处取 300ms（非 1:1，
   *  全仓注释与 PLAN 均按 300ms 表述）。 */
  static readonly RESIZE_DEBOUNCE_MS: number = 300;

  /** 终端输出合批窗口（ms）：窗口内的多段 VT 输出在字节层合并为一次 runJavaScript 下发。 */
  static readonly TERMINAL_WRITE_BATCH_MS: number = 8;

  /** 首页相对时间/stale 的 UI 重算 tick（ms）：轮询停摆时避免『同步于 X 前』冻结。 */
  static readonly SNAPSHOT_UI_TICK_MS: number = 30000;
}
