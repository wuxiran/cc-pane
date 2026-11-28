//! 终端回滚缓冲落盘（daemon 侧）。
//!
//! PTY 托管到 daemon 之后，回滚缓冲只存在于本进程内存里。桌面侧退出时读的是它
//! 自己进程内的 `TerminalService`（daemon 模式下恒为空），于是 `sessions/*.output`
//! 从此不再产生——会话真死掉后恢复出来的终端只能是空白。
//!
//! 落盘时机取"会话不可能再产出内容"的两个点：会话退出、daemon 优雅关闭。
//! 都由 daemon 自己完成，因此 app 被强杀、app 与 daemon 先后顺序颠倒都不丢历史。

use std::sync::mpsc;
use std::sync::{Arc, Weak};

use cc_panes_core::services::{write_session_checkpoint, write_session_output, TerminalService};
use cc_panes_core::utils::AppPaths;
use tracing::{debug, info, warn};

struct PersistWork {
    session_id: String,
    completed: mpsc::SyncSender<()>,
}

pub struct SessionOutputStore {
    sink: Arc<OutputSink>,
    queue: mpsc::SyncSender<PersistWork>,
}

struct OutputSink {
    service: Weak<TerminalService>,
    app_paths: Arc<AppPaths>,
}

impl SessionOutputStore {
    pub fn new(service: &Arc<TerminalService>, app_paths: Arc<AppPaths>) -> Self {
        let sink = Arc::new(OutputSink {
            service: Arc::downgrade(service),
            app_paths,
        });
        let worker_sink = sink.clone();
        let (queue, receiver) = mpsc::sync_channel::<PersistWork>(64);
        if let Err(error) =
            cc_panes_core::pty::thread::spawn_named("cc-panes-output-store", move || {
                while let Ok(work) = receiver.recv() {
                    worker_sink.persist_session(&work.session_id);
                    let _ = work.completed.send(());
                }
            })
        {
            warn!(%error, "output worker unavailable; completion threads will persist synchronously");
        }
        Self { sink, queue }
    }

    /// Called by the PTY completion thread, after reader and batcher have drained.
    /// Acknowledge before core shrinks its dead-session cache. No UI/PTY reader waits on disk.
    pub fn schedule_session_persist(&self, session_id: &str) {
        let (completed, receiver) = mpsc::sync_channel(1);
        if self
            .queue
            .send(PersistWork {
                session_id: session_id.to_owned(),
                completed,
            })
            .is_ok()
        {
            if let Err(error) = receiver.recv() {
                warn!(session_id, %error, "output worker did not acknowledge; persisting synchronously");
                self.sink.persist_session(session_id);
            }
        } else {
            warn!(
                session_id,
                "terminal output persistence worker stopped; persisting synchronously"
            );
            self.sink.persist_session(session_id);
        }
    }

    pub fn persist_all(&self) {
        if let Some(service) = self.sink.service.upgrade() {
            for session_id in service.session_output_ids() {
                self.schedule_session_persist(&session_id);
            }
        }
    }
}

impl OutputSink {
    /// 落盘单个会话。只取该会话的缓冲——`get_all_session_outputs` 会持 sessions 锁
    /// 复制全部活跃 + dead buffer，为一条会话退出扫全量是 O(n) 放大。
    pub fn persist_session(&self, session_id: &str) {
        let Some(service) = self.service.upgrade() else {
            return;
        };
        // resume 失败退出（如 Claude `No conversation found`）：这段输出只是报错，
        // 落盘的话下次重启会被当成 "Session restored" 原样冷重放。连同可能残留的
        // 旧文件一起清掉，下次恢复直接新建。
        if service.is_cold_replay_suppressed(session_id) {
            debug!(session_id, "skipped persisting output of failed resume");
            discard_cold_replay_output(&self.app_paths, session_id);
            return;
        }
        // 0 = 整个缓冲区。会话不存在（已过 dead_buffers 保留期）时返回 Err，属正常路径。
        match service.get_session_output(session_id, 0) {
            Ok(output) => self.write(session_id, &output.lines),
            Err(error) => debug!(session_id, %error, "no buffered output to persist"),
        }
        self.write_checkpoint(session_id, &service);
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

/// 删掉某会话的冷重放 `.output`（不存在属正常路径）。
fn discard_cold_replay_output(app_paths: &AppPaths, session_id: &str) {
    let path = app_paths.session_output_path(session_id);
    match std::fs::remove_file(&path) {
        Ok(()) => info!(session_id, "discarded cold-replay output of failed resume"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => warn!(session_id, %error, "failed to discard cold-replay output"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discard_cold_replay_output_removes_existing_file_and_tolerates_missing() {
        let dir = tempfile::tempdir().expect("temp dir");
        let app_paths = AppPaths::new(Some(dir.path().to_string_lossy().to_string()));
        write_session_output(&app_paths, "failed", &["No conversation found".to_string()])
            .expect("write output");
        assert!(app_paths.session_output_path("failed").exists());

        discard_cold_replay_output(&app_paths, "failed");
        assert!(!app_paths.session_output_path("failed").exists());
        // 再删一次（文件已不在）不应报错。
        discard_cold_replay_output(&app_paths, "failed");
    }
}
