//! 「Codex」单引擎（App Server 优先、ACP 兜底）+ 运行配置注入。
//!
//! ## 引擎 id 兼容决策（改这里前先读完）
//!
//! 可见 id 保留 **`codex-app-server`**，只把标签改成「Codex」；旧 id **`codex`**（codex-acp 桥）
//! 仍是合法引擎，只是不再出现在引擎列表里。
//!
//! - 新会话选「Codex」→ 先起原生 App Server；起不来（老版本没有 `app-server` 子命令 /
//!   spawn 失败 / initialize 失败）自动改走 `codex`。快照与历史 meta 如实记 `codex`，
//!   所以之后的重启 / 续接 / 换引擎历史都自然走 ACP。
//! - 带 `codex` 的一切（最近会话、`session/load`、重启、换引擎历史、Automations）原样走 ACP。
//! - 带 `codex-app-server` 续接时看 meta：记的是 `codex`（自动降级产生的会话）→ ACP；
//!   其余 → 原生。「始终 ACP」设置只影响新会话，不改写已有原生会话的传输。
//!
//! 为什么不把可见 id 改成 `codex`：那样旧 `codex` 会话就分不清「当初就是 ACP」还是
//! 「新统一入口」，必须做数据迁移；保留两个 id 各自的历史语义 = 零迁移。
//!
//! ## 能力探测
//!
//! 不额外跑 `codex app-server --help`（每次开聊多一个进程）：直接起 App Server，失败再降级，
//! 并按「二进制身份」缓存负结果，同一个二进制之后直接走 ACP、零延迟。身份 = 规范化路径 +
//! 文件大小 + 修改时间——升级 codex 必然改写二进制（npm / brew / 安装脚本皆然），等价于按
//! 版本缓存，又不必为取版本号多起一个进程。缓存只在本进程内有效（重启 app 即重新探测）。
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use cc_panes_core::models::CliTool;
use cc_panes_core::services::AgentChatLaunchOverlay;
use serde_json::Value;

use super::ResolvedEngine;
use crate::utils::AppError;

/// 引擎列表里唯一的 Codex（原生 App Server 优先）。
pub(super) const CODEX_ENGINE: &str = "codex-app-server";
/// codex-acp 桥。不在列表里显示，但旧会话 / 降级会话 / Automations 仍按此 id 启动。
pub(super) const CODEX_ACP_ENGINE: &str = "codex";

/// 不在引擎列表里显示、但仍可按 id 启动的引擎。
pub(super) fn is_hidden_engine(engine_id: &str) -> bool {
    engine_id == CODEX_ACP_ENGINE
}

/// 该引擎能接收哪个 CLI 的运行配置（None = 不支持）。
pub(super) fn launch_profile_cli(engine_id: &str) -> Option<CliTool> {
    match engine_id {
        CODEX_ENGINE | CODEX_ACP_ENGINE => Some(CliTool::Codex),
        "claude" => Some(CliTool::Claude),
        _ => None,
    }
}

/// 自动改走 ACP 的原因（写进快照 `transportFallback`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FallbackReason {
    /// 本机 codex 已知不支持 App Server（能力缓存命中）。
    Unsupported,
    /// 这一次 App Server 没起来（spawn / initialize 失败）。
    StartFailed,
    /// 远程（SSH）会话：原生 App Server 只在本机跑。
    Remote,
}

impl FallbackReason {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Unsupported => "unsupported",
            Self::StartFailed => "startFailed",
            Self::Remote => "remote",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CodexRoute {
    Native,
    /// 走 ACP 桥；`Some` = 自动降级（界面提示），`None` = 按会话历史 / 用户设置本就该走 ACP。
    Acp(Option<FallbackReason>),
}

#[derive(Debug, Clone, Copy, Default)]
pub(super) struct RouteInput<'a> {
    /// 续接会话时 meta 里记的引擎（新会话 None）。
    pub resume_engine: Option<&'a str>,
    pub force_acp: bool,
    pub remote: bool,
    pub known_unsupported: bool,
}

/// 选了「Codex」（`codex-app-server`）时走哪条传输。纯函数，见文件头的兼容决策。
pub(super) fn plan_codex_route(input: RouteInput<'_>) -> CodexRoute {
    if input.resume_engine == Some(CODEX_ACP_ENGINE) {
        return CodexRoute::Acp(None);
    }
    if input.remote {
        return CodexRoute::Acp(Some(FallbackReason::Remote));
    }
    let resuming_native = input.resume_engine == Some(CODEX_ENGINE);
    if input.force_acp && !resuming_native {
        return CodexRoute::Acp(None);
    }
    if input.known_unsupported {
        return CodexRoute::Acp(Some(FallbackReason::Unsupported));
    }
    CodexRoute::Native
}

/// App Server「起不来」类错误（可以改走 ACP）。握手后段（thread/start 等）的失败
/// 被原生层包成 `CODEX_NATIVE_START_FAILED`，不在此列——那是会话本身的问题，换传输救不了。
pub(super) fn is_app_server_unavailable(error: &AppError) -> bool {
    error.code().is_some_and(|code| {
        code.starts_with("CODEX_APP_SERVER_") && code != "CODEX_APP_SERVER_CONFIG"
    })
}

/// 确定性的「不支持」：可执行文件缺失 / 起不来 / 没等到 initialize 就退出 / initialize 被拒。
/// 超时、繁忙属于偶发，不写进负缓存。
fn is_definitive_unavailable(error: &AppError) -> bool {
    matches!(
        error.code(),
        Some(
            "CODEX_APP_SERVER_EXECUTABLE"
                | "CODEX_APP_SERVER_SPAWN"
                | "CODEX_APP_SERVER_CLOSED"
                | "CODEX_APP_SERVER_RPC_ERROR"
                | "CODEX_APP_SERVER_PROTOCOL"
        )
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) struct BinaryIdentity {
    path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
}

pub(super) fn binary_identity(executable: &Path) -> Option<BinaryIdentity> {
    let path = dunce::canonicalize(executable).ok()?;
    let metadata = std::fs::metadata(&path).ok()?;
    Some(BinaryIdentity {
        path,
        len: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

fn capability_cache() -> &'static Mutex<HashMap<BinaryIdentity, bool>> {
    static CACHE: OnceLock<Mutex<HashMap<BinaryIdentity, bool>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn known_unsupported(identity: Option<&BinaryIdentity>) -> bool {
    let Some(identity) = identity else {
        return false;
    };
    capability_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(identity)
        == Some(&false)
}

/// 记一次 App Server 启动结果。成功总是记（顺带清掉旧的负结果）；失败只记确定性的。
pub(super) fn remember_outcome(identity: Option<&BinaryIdentity>, error: Option<&AppError>) {
    let Some(identity) = identity else {
        return;
    };
    let supported = match error {
        None => true,
        Some(error) if is_definitive_unavailable(error) => false,
        Some(_) => return,
    };
    capability_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(identity.clone(), supported);
}

/// 把运行配置叠加层装进引擎启动描述，返回要先删掉的继承变量。
///
/// - 原生 App Server：`-c key=value` 放在 `app-server` 子命令**之前**（全局 flag）。
/// - codex-acp 桥：它不认 `-c`，配置经 `CODEX_CONFIG`（JSON）传进去，由它在
///   thread/start 时下发；密钥 / `CODEX_HOME` 走进程环境，它启动的 App Server 会继承。
/// - Claude（claude-agent-acp）：只有环境变量。
pub(super) fn apply_overlay(
    engine: &mut ResolvedEngine,
    overlay: &AgentChatLaunchOverlay,
) -> Vec<String> {
    if !overlay.codex_config.is_empty() {
        if engine.id == CODEX_ENGINE {
            let mut args: Vec<String> = overlay
                .codex_config
                .iter()
                .flat_map(|entry| ["-c".to_string(), entry.clone()])
                .collect();
            args.append(&mut engine.args);
            engine.args = args;
        } else if engine.id == CODEX_ACP_ENGINE {
            let (config, rejected) =
                cc_panes_core::services::codex_config_overrides_to_json(&overlay.codex_config);
            if !rejected.is_empty() {
                tracing::warn!(keys = ?rejected, "codex-acp: skipped native config overrides it cannot parse");
            }
            if !config.is_empty() {
                engine.env.push((
                    "CODEX_CONFIG".to_string(),
                    Value::Object(config).to_string(),
                ));
            }
        }
    }
    engine.env.extend(overlay.env.iter().cloned());
    overlay.env_remove.clone()
}

/// 本次启动用哪个运行配置：显式传入优先（空串 = 明确选「系统默认」），
/// 未传时续接沿用该会话 meta 里记的。
pub(super) fn effective_profile_id(
    requested: Option<&str>,
    resumed: Option<&str>,
) -> Option<String> {
    match requested {
        Some(id) => Some(id.trim())
            .filter(|id| !id.is_empty())
            .map(str::to_string),
        None => resumed
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine(id: &str, args: &[&str]) -> ResolvedEngine {
        ResolvedEngine {
            id: id.into(),
            label: id.into(),
            executable: "codex".into(),
            args: args.iter().map(|arg| arg.to_string()).collect(),
            requirement: String::new(),
            env: Vec::new(),
        }
    }

    #[test]
    fn new_codex_session_prefers_native_app_server() {
        assert_eq!(plan_codex_route(RouteInput::default()), CodexRoute::Native);
    }

    #[test]
    fn old_acp_codex_session_resumes_through_acp_even_from_unified_entry() {
        // 旧 id `codex` 的会话（或自动降级产生的会话）续接时绝不改走原生。
        let route = plan_codex_route(RouteInput {
            resume_engine: Some(CODEX_ACP_ENGINE),
            ..Default::default()
        });
        assert_eq!(route, CodexRoute::Acp(None));
    }

    #[test]
    fn native_session_keeps_app_server_even_when_acp_is_forced() {
        let route = plan_codex_route(RouteInput {
            resume_engine: Some(CODEX_ENGINE),
            force_acp: true,
            ..Default::default()
        });
        assert_eq!(route, CodexRoute::Native);
    }

    #[test]
    fn force_acp_applies_to_new_sessions_without_notice() {
        let route = plan_codex_route(RouteInput {
            force_acp: true,
            ..Default::default()
        });
        assert_eq!(route, CodexRoute::Acp(None));
    }

    #[test]
    fn cached_unsupported_binary_and_remote_fall_back_with_notice() {
        let cached = plan_codex_route(RouteInput {
            known_unsupported: true,
            ..Default::default()
        });
        assert_eq!(cached, CodexRoute::Acp(Some(FallbackReason::Unsupported)));
        let remote = plan_codex_route(RouteInput {
            remote: true,
            ..Default::default()
        });
        assert_eq!(remote, CodexRoute::Acp(Some(FallbackReason::Remote)));
    }

    #[test]
    fn only_spawn_and_initialize_failures_trigger_fallback() {
        for code in [
            "CODEX_APP_SERVER_EXECUTABLE",
            "CODEX_APP_SERVER_SPAWN",
            "CODEX_APP_SERVER_CLOSED",
            "CODEX_APP_SERVER_TIMEOUT",
            "CODEX_APP_SERVER_RPC_ERROR",
        ] {
            assert!(
                is_app_server_unavailable(&AppError::coded(code, "x")),
                "{code}"
            );
        }
        for code in ["CODEX_NATIVE_START_FAILED", "CODEX_APP_SERVER_CONFIG"] {
            assert!(
                !is_app_server_unavailable(&AppError::coded(code, "x")),
                "{code}"
            );
        }
        assert!(!is_app_server_unavailable(&AppError::from("plain")));
    }

    #[test]
    fn capability_cache_is_keyed_by_binary_identity_and_ignores_transient_errors() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("codex");
        std::fs::write(&binary, "v1").unwrap();
        let identity = binary_identity(&binary);
        assert!(!known_unsupported(identity.as_ref()));
        remember_outcome(
            identity.as_ref(),
            Some(&AppError::coded("CODEX_APP_SERVER_TIMEOUT", "slow")),
        );
        assert!(
            !known_unsupported(identity.as_ref()),
            "timeouts are not cached"
        );
        remember_outcome(
            identity.as_ref(),
            Some(&AppError::coded("CODEX_APP_SERVER_CLOSED", "no subcommand")),
        );
        assert!(known_unsupported(identity.as_ref()));
        // 升级（内容 / 大小变化）= 新身份，重新探测。
        std::fs::write(&binary, "version two").unwrap();
        assert!(!known_unsupported(binary_identity(&binary).as_ref()));
        remember_outcome(identity.as_ref(), None);
        assert!(!known_unsupported(identity.as_ref()));
    }

    #[test]
    fn overlay_goes_before_app_server_subcommand_and_into_codex_config_for_acp() {
        let overlay = AgentChatLaunchOverlay {
            codex_config: vec![
                "model_provider=\"ccpanes_relay\"".into(),
                "model=\"gpt-5\"".into(),
            ],
            env: vec![("CODEX_HOME".into(), "/accounts/a".into())],
            env_remove: vec!["OPENAI_API_KEY".into()],
            ..Default::default()
        };
        let mut native = engine(CODEX_ENGINE, &["app-server", "--listen", "stdio://"]);
        let removed = apply_overlay(&mut native, &overlay);
        assert_eq!(
            native.args,
            vec![
                "-c",
                "model_provider=\"ccpanes_relay\"",
                "-c",
                "model=\"gpt-5\"",
                "app-server",
                "--listen",
                "stdio://"
            ]
        );
        assert_eq!(removed, vec!["OPENAI_API_KEY".to_string()]);
        assert!(native
            .env
            .contains(&("CODEX_HOME".into(), "/accounts/a".into())));

        let mut acp = engine(
            CODEX_ACP_ENGINE,
            &["-y", "@agentclientprotocol/codex-acp@2.2.2"],
        );
        apply_overlay(&mut acp, &overlay);
        assert_eq!(acp.args, vec!["-y", "@agentclientprotocol/codex-acp@2.2.2"]);
        let config = acp
            .env
            .iter()
            .find(|(key, _)| key == "CODEX_CONFIG")
            .map(|(_, value)| serde_json::from_str::<Value>(value).unwrap())
            .unwrap();
        assert_eq!(config["model_provider"], "ccpanes_relay");
        assert_eq!(config["model"], "gpt-5");
    }

    #[test]
    fn profile_follows_explicit_choice_then_resumed_session() {
        assert_eq!(
            effective_profile_id(Some("p1"), Some("p0")),
            Some("p1".into())
        );
        assert_eq!(effective_profile_id(Some(""), Some("p0")), None);
        assert_eq!(effective_profile_id(None, Some("p0")), Some("p0".into()));
        assert_eq!(effective_profile_id(None, None), None);
    }

    #[test]
    fn both_codex_ids_stay_resolvable_but_only_one_is_listed() {
        // 旧 `codex` 会话（最近会话 / 重启 / 换引擎历史 / Automations）按 id 启动必须仍然命中内置条目。
        let ids: Vec<&str> = super::super::built_in_engine_ids().collect();
        assert!(ids.contains(&CODEX_ENGINE));
        assert!(ids.contains(&CODEX_ACP_ENGINE));
        let listed: Vec<&str> = ids.into_iter().filter(|id| !is_hidden_engine(id)).collect();
        assert_eq!(
            listed.iter().filter(|id| id.starts_with("codex")).count(),
            1
        );
    }

    #[test]
    fn only_codex_and_claude_take_launch_profiles() {
        assert_eq!(launch_profile_cli(CODEX_ENGINE), Some(CliTool::Codex));
        assert_eq!(launch_profile_cli(CODEX_ACP_ENGINE), Some(CliTool::Codex));
        assert_eq!(launch_profile_cli("claude"), Some(CliTool::Claude));
        assert_eq!(launch_profile_cli("gemini"), None);
        assert!(is_hidden_engine(CODEX_ACP_ENGINE));
        assert!(!is_hidden_engine(CODEX_ENGINE));
    }
}
