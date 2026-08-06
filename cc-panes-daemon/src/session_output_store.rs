//! 终端回滚缓冲落盘（daemon 侧）。
//!
//! PTY 托管到 daemon 之后，回滚缓冲只存在于本进程内存里。桌面侧退出时读的是它
//! 自己进程内的 `TerminalService`（daemon 模式下恒为空），于是 `sessions/*.output`
//! 从此不再产生——会话真死掉后恢复出来的终端只能是空白。
//!
//! 落盘时机取"会话不可能再产出内容"的两个点：会话退出、daemon 优雅关闭。
//! 都由 daemon 自己完成，因此 app 被强杀、app 与 daemon 先后顺序颠倒都不丢历史。

use std::sync::{Arc, Weak};
use std::time::Duration;

use cc_panes_core::services::{write_session_checkpoint, write_session_output, TerminalService};
use cc_panes_core::utils::AppPaths;
use tracing::{debug, warn};

/// 会话退出到落盘之间的宽限期，等 reader 线程把 PTY 尾部排空。
const EXIT_PERSIST_GRACE: Duration = Duration::from_millis(500);

pub struct SessionOutputStore {
    /// Weak：`TerminalService` 持有 emitter，emitter 又要回查缓冲，强引用会成环。
    service: Weak<TerminalService>,
    app_paths: Arc<AppPaths>,
}

impl SessionOutputStore {
    pub fn new(service: &Arc<TerminalService>, app_paths: Arc<AppPaths>) -> Self {
        Self {
            service: Arc::downgrade(service),
            app_paths,
        }
    }

    /// 会话退出后延迟落盘。
    ///
    /// **不能在 `terminal-exit` 到达时立刻写**：该事件由 wait 线程在进程回收时发出，
    /// 而 reader 线程可能仍在把 PTY 尾部追加进 buffer，两者之间没有 join/握手。
    /// 立刻落盘会丢掉最后一段输出，短命会话甚至可能落成空文件。
    /// dead_buffers 保留 5 分钟，因此延迟读取仍能取到；宽限期取其一个很小的零头。
    pub fn schedule_session_persist(self: &Arc<Self>, session_id: &str) {
        let store = Arc::clone(self);
        let owned_id = session_id.to_string();
        let spawned = std::thread::Builder::new()
            .name("cc-panes-persist-output".into())
            .spawn(move || {
                std::thread::sleep(EXIT_PERSIST_GRACE);
                store.persist_session(&owned_id);
            });
        if let Err(error) = spawned {
            warn!(session_id, %error, "failed to spawn persist thread; writing inline");
            self.persist_session(session_id);
        }
    }

    /// 落盘单个会话。只取该会话的缓冲——`get_all_session_outputs` 会持 sessions 锁
    /// 复制全部活跃 + dead buffer，为一条会话退出扫全量是 O(n) 放大。
    pub fn persist_session(&self, session_id: &str) {
        let Some(service) = self.service.upgrade() else {
            return;
        };
        // 0 = 整个缓冲区。会话不存在（已过 dead_buffers 保留期）时返回 Err，属正常路径。
        match service.get_session_output(session_id, 0) {
            Ok(output) => self.write(session_id, &output.lines),
            Err(error) => debug!(session_id, %error, "no buffered output to persist"),
        }
        self.write_checkpoint(session_id, &service);
    }

    /// 落盘所有仍有内容的会话（daemon 优雅关闭时调用）。
    pub fn persist_all(&self) {
        let Some(service) = self.service.upgrade() else {
            return;
        };
        let outputs = service.get_all_session_outputs();
        debug!(count = outputs.len(), "persisting session outputs");
        for (session_id, lines) in &outputs {
            self.write(session_id, lines);
            self.write_checkpoint(session_id, &service);
        }
    }

    /// 顺带落盘 checkpoint 恢复快照（M3b-5，只写不读）。photo+delta 是唯一带
    /// 画面语义的死会话历史；无照片时也写（纯 delta 形状，读侧统一）。
    fn write_checkpoint(&self, session_id: &str, service: &Arc<TerminalService>) {
        match service.get_session_recovery_snapshot(session_id) {
            Ok(Some(recovery)) => {
                if let Err(error) = write_session_checkpoint(&self.app_paths, session_id, &recovery)
                {
                    warn!(session_id, error, "failed to persist session checkpoint");
                }
            }
            Ok(None) => {}
            Err(error) => debug!(session_id, %error, "no recovery snapshot to persist"),
        }
    }

    fn write(&self, session_id: &str, lines: &[String]) {
        if lines.is_empty() {
            return;
        }
        if let Err(error) = write_session_output(&self.app_paths, session_id, lines) {
            warn!(session_id, error, "failed to persist session output");
        }
    }
}
