// 系统托盘相关 IPC 的薄封装：组件/钩子不直接 invoke。
// 命令名与 src-tauri 托盘实现共同约定，勿擅改。
import { invokeIfTauri } from "./runtime";

export const trayService = {
  /** 用户在退出确认对话框中同意退出：交给 Rust 执行真正的退出流程。 */
  confirmTrayQuit: (): Promise<void | undefined> => invokeIfTauri<void>("confirm_tray_quit"),
};
