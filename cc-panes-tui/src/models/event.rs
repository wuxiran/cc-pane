//! Event 模型 - 系统事件

use crossterm::event::KeyEvent;
use crate::ipc::StatusNotify;

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum Event {
    /// PTY 输出数据
    PtyOutput(Vec<u8>),
    /// PTY 进程退出
    PtyExit(i32),
    /// 键盘输入事件
    Key(KeyEvent),
    /// 终端大小变化
    Resize(u16, u16),
    /// 定时 tick（用于刷新 UI）
    Tick,
    /// 钩子状态通知
    StatusNotify(StatusNotify),
}
