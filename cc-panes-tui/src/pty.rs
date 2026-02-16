//! PTY 进程管理模块

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize, PtyPair, MasterPty};
use std::io::{Read, Write};
use tokio::sync::mpsc;

use crate::models::Event;

/// PTY 管理器
pub struct PtyManager {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

impl PtyManager {
    /// 启动 Claude 进程
    pub fn spawn_claude(
        workspace_dir: &str,
        project_paths: &[String],
        resume_session_id: Option<&str>,
        size: PtySize,
        event_tx: mpsc::UnboundedSender<Event>,
    ) -> Result<Self> {
        let pty_system = native_pty_system();

        let pair: PtyPair = pty_system
            .openpty(size)
            .context("无法打开 PTY")?;

        let mut cmd = CommandBuilder::new("claude");

        // 如果有会话 ID，添加 --resume 参数
        if let Some(session_id) = resume_session_id {
            cmd.arg("--resume");
            cmd.arg(session_id);
        }

        // 添加所有项目路径
        for path in project_paths {
            cmd.arg("--add-dir");
            cmd.arg(path);
        }

        cmd.cwd(workspace_dir);

        let child = pair.slave
            .spawn_command(cmd)
            .context("无法启动 claude 进程")?;

        // 释放 slave 端
        drop(pair.slave);

        let master = pair.master;
        let mut reader = master
            .try_clone_reader()
            .context("无法克隆 PTY reader")?;
        let writer = master
            .take_writer()
            .context("无法获取 PTY writer")?;

        // 启动读取线程
        let tx = event_tx.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let _ = tx.send(Event::PtyOutput(buf[..n].to_vec()));
                    }
                    Err(_) => break,
                }
            }
        });

        // 启动进程监控线程
        let tx = event_tx;
        std::thread::spawn(move || {
            let mut child = child;
            if let Ok(status) = child.wait() {
                let code = status.exit_code() as i32;
                let _ = tx.send(Event::PtyExit(code));
            }
        });

        Ok(Self { master, writer })
    }

    /// 向 PTY 写入数据
    pub fn write(&mut self, data: &[u8]) -> Result<()> {
        self.writer.write_all(data)?;
        self.writer.flush()?;
        Ok(())
    }

    /// 调整 PTY 大小
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }
}
