//! 进程级的 sidecar 资源目录（docs/110 批 1）。
//!
//! 资源目录（`resources/claude-bundle/default-skills`、ctl 二进制候选）只有 app 进程从 Tauri
//! 拿得到。daemon 模式下会话在 daemon 进程里创建，`TerminalService::set_sidecar_resource_dir`
//! 从未被调用，依赖它的可移植技能提示词与托管 Pi 技能发布会静默丢失（terminal_service 的
//! `portable_bundled_skill_prompt` / `inject_managed_pi_skills`）。
//!
//! 修法：app 启动时 [`remember_process_resource_dir`]；daemon 客户端把它作为创建请求的
//! `sidecarResourceDir` 字段带过去（旧 daemon 忽略未知字段）；daemon 收到后同样记进本进程，
//! `TerminalService` 在自身字段为空时退回这里。

use std::path::{Path, PathBuf};

use parking_lot::RwLock;

static PROCESS_RESOURCE_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);

/// 记下本进程可用的资源目录。只接受存在的绝对目录（请求来源是已认证的 app，但路径仍要像样）。
pub fn remember_process_resource_dir(resource_dir: &Path) -> bool {
    if !resource_dir.is_absolute() || !resource_dir.is_dir() {
        return false;
    }
    let mut slot = PROCESS_RESOURCE_DIR.write();
    if slot.as_deref() != Some(resource_dir) {
        *slot = Some(resource_dir.to_path_buf());
    }
    true
}

/// 本进程记下的资源目录（没有则 None）。
pub fn process_resource_dir() -> Option<PathBuf> {
    PROCESS_RESOURCE_DIR.read().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_existing_absolute_dirs_are_remembered() {
        assert!(!remember_process_resource_dir(Path::new("relative/dir")));
        assert!(!remember_process_resource_dir(Path::new(
            "/definitely/not/here/ccpanes"
        )));
        let temp = tempfile::tempdir().unwrap();
        assert!(remember_process_resource_dir(temp.path()));
        assert_eq!(process_resource_dir().as_deref(), Some(temp.path()));
        *PROCESS_RESOURCE_DIR.write() = None;
    }
}
