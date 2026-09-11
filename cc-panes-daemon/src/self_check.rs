use std::path::PathBuf;
use std::time::Duration;

use cc_panes_core::services::TerminalDaemonClient;
use tracing::{info, warn};

use crate::server::{read_manifest, write_manifest, DaemonConfig, DaemonManifest};

const SELF_CHECK_INTERVAL: Duration = Duration::from_secs(30);
/// manifest 自愈重写连续失败上限，超过即退出（runtime_dir 已不可写，daemon 无法被发现）。
const MAX_REWRITE_FAILURES: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestAction {
    /// manifest 指向自己，正常。
    KeepRunning,
    /// manifest 缺失/损坏/指向一个已死的 daemon——自愈重写为自己
    /// （不能直接退出：误清 runtime_dir 时会杀死活跃会话）。
    Rewrite,
    /// manifest 指向另一个「可连通且 pid 匹配」的 daemon——自己已被取代，优雅退出。
    Shutdown,
}

/// 纯判定函数：`foreign_alive` 负责探测外部 manifest 指向的 daemon 是否健在
/// （health + status 且 status.pid 与 manifest.pid 一致），注入以便单测。
pub fn decide_manifest_action(
    manifest: Option<&DaemonManifest>,
    own_pid: u32,
    own_token: &str,
    own_has_live_sessions: bool,
    foreign_alive: impl FnOnce(&DaemonManifest) -> bool,
) -> ManifestAction {
    match manifest {
        Some(m) if m.pid == own_pid && m.token == own_token => ManifestAction::KeepRunning,
        Some(m) if m.pid != own_pid => {
            if foreign_alive(m) {
                if own_has_live_sessions {
                    ManifestAction::KeepRunning
                } else {
                    ManifestAction::Shutdown
                }
            } else {
                ManifestAction::Rewrite
            }
        }
        // pid 相同但 token 不同：上一世代残留（pid 复用），回收为自己的。
        Some(_) => ManifestAction::Rewrite,
        None => ManifestAction::Rewrite,
    }
}

/// manifest 连续自愈失败到上限后该怎么办。
///
/// runtime_dir 不可写（磁盘满 / 权限 / 被清理）只意味着这个 daemon 暂时不可被发现，
/// 不意味着该死：Windows 上会话树挂在 `KILL_ON_JOB_CLOSE` 的 Job Object 上，daemon
/// 一退，内核瞬杀全部活着的 CLI（用户视角就是「CLI 被卸载了」）。有活会话就留着继续
/// 重试，代价只是新 app 实例可能发现不到它。
pub fn should_shutdown_on_unrecoverable_manifest(own_has_live_sessions: bool) -> bool {
    !own_has_live_sessions
}

fn probe_foreign_daemon(manifest: &DaemonManifest) -> bool {
    let client = TerminalDaemonClient::new(manifest.addr.clone(), manifest.token.clone());
    if client.health().is_err() {
        return false;
    }
    client
        .status()
        .map(|status| status.pid == manifest.pid)
        .unwrap_or(false)
}

/// 周期自检 manifest：被新 daemon 取代即优雅退出（防孤儿 daemon 永久残留），
/// manifest 意外丢失/损坏则自愈重写。全程阻塞 I/O，跑在独立线程上。
pub fn spawn_manifest_self_check(runtime_dir: PathBuf, config: DaemonConfig) {
    std::thread::spawn(move || {
        let own_pid = std::process::id();
        let mut rewrite_failures = 0_u32;
        loop {
            std::thread::sleep(SELF_CHECK_INTERVAL);
            let manifest = read_manifest(&runtime_dir);
            let own_has_live_sessions = config
                .terminal_backend()
                .get_all_status()
                .map(|sessions| !sessions.is_empty())
                .unwrap_or(true);
            let action = decide_manifest_action(
                manifest.as_ref(),
                own_pid,
                config.token(),
                own_has_live_sessions,
                probe_foreign_daemon,
            );
            match action {
                ManifestAction::KeepRunning => {
                    rewrite_failures = 0;
                }
                ManifestAction::Shutdown => {
                    info!(
                        manifest_pid = manifest.map(|m| m.pid).unwrap_or_default(),
                        "manifest points to a live newer daemon; shutting down to avoid orphan"
                    );
                    config.request_shutdown();
                    return;
                }
                ManifestAction::Rewrite => match write_manifest(&runtime_dir, &config) {
                    Ok(_) => {
                        rewrite_failures = 0;
                        info!("manifest missing/stale; self-healed by rewriting own manifest");
                    }
                    Err(error) => {
                        rewrite_failures += 1;
                        warn!(
                            error = %error,
                            attempt = rewrite_failures,
                            "failed to self-heal manifest"
                        );
                        if rewrite_failures >= MAX_REWRITE_FAILURES {
                            if !should_shutdown_on_unrecoverable_manifest(own_has_live_sessions) {
                                warn!(
                                    "manifest unrecoverable, but sessions are live; staying up and retrying"
                                );
                                rewrite_failures = 0;
                                continue;
                            }
                            warn!("manifest unrecoverable; shutting down");
                            config.request_shutdown();
                            return;
                        }
                    }
                },
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(pid: u32, token: &str) -> DaemonManifest {
        DaemonManifest {
            addr: "127.0.0.1:1".to_string(),
            token: token.to_string(),
            pid,
            started_at: 0,
        }
    }

    #[test]
    fn own_manifest_keeps_running() {
        let m = manifest(42, "tok");
        let action = decide_manifest_action(Some(&m), 42, "tok", false, |_| {
            panic!("must not probe own manifest")
        });
        assert_eq!(action, ManifestAction::KeepRunning);
    }

    #[test]
    fn live_foreign_manifest_shuts_down() {
        let m = manifest(99, "other");
        let action = decide_manifest_action(Some(&m), 42, "tok", false, |_| true);
        assert_eq!(action, ManifestAction::Shutdown);
    }

    #[test]
    fn live_foreign_manifest_keeps_old_daemon_when_it_has_sessions() {
        let m = manifest(99, "other");
        let action = decide_manifest_action(Some(&m), 42, "tok", true, |_| true);
        assert_eq!(action, ManifestAction::KeepRunning);
    }

    #[test]
    fn dead_foreign_manifest_rewrites() {
        let m = manifest(99, "other");
        let action = decide_manifest_action(Some(&m), 42, "tok", false, |_| false);
        assert_eq!(action, ManifestAction::Rewrite);
    }

    #[test]
    fn missing_manifest_rewrites() {
        let action = decide_manifest_action(None, 42, "tok", false, |_| panic!("nothing to probe"));
        assert_eq!(action, ManifestAction::Rewrite);
    }

    #[test]
    fn same_pid_different_token_rewrites_without_probe() {
        let m = manifest(42, "stale-token");
        let action = decide_manifest_action(Some(&m), 42, "tok", false, |_| {
            panic!("must not probe pid-reuse manifest")
        });
        assert_eq!(action, ManifestAction::Rewrite);
    }

    #[test]
    fn unrecoverable_manifest_shuts_down_only_without_sessions() {
        // Windows 上 daemon 退出 = Job Object 瞬杀整棵 CLI 树，所以有会话时必须留着。
        assert!(!should_shutdown_on_unrecoverable_manifest(true));
        assert!(should_shutdown_on_unrecoverable_manifest(false));
    }
}
