use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::models::launch_profile::LaunchProviderSelection;

/// 由**同一份清单**生成 `CliTool` 枚举、`as_id`、`from_id` 与 `ALL`。
///
/// 手写这四处时，新增变体漏掉其中任何一处都不会编译失败——`ALL` 尤其危险，
/// 它漏项不会有任何信号，而下游穷举守卫（前端四张表的覆盖测试）正是靠它取全集，
/// 于是「守卫本身漏掉新 CLI」而看不出来。清单化之后这四者不可能不同步。
macro_rules! define_cli_tools {
    ($( $(#[$meta:meta])* $variant:ident => $id:literal ),+ $(,)?) => {
        /// CLI 工具类型
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
        #[serde(rename_all = "snake_case")]
        pub enum CliTool {
            $( $(#[$meta])* $variant, )+
        }

        impl CliTool {
            /// 转换为 CLI 适配器注册表中的 id 字符串
            pub fn as_id(&self) -> &str {
                match self {
                    $( CliTool::$variant => $id, )+
                }
            }

            /// `as_id` 的逆：从适配器注册表 id 解析回枚举。
            ///
            /// 这是**唯一**的正向解析入口。此前 `preview_cli_tool`
            /// （launch_profile_service）与 `parse_launch_cli_tool`
            /// （orchestrator_service）各抄了一份。调用方各自保留自己的错误语义与
            /// 准入白名单，但字符串到枚举的映射只在这里定义。
            pub fn from_id(id: &str) -> Option<Self> {
                Some(match id {
                    $( $id => CliTool::$variant, )+
                    _ => return None,
                })
            }

            /// 全部变体，供穷举遍历使用（与枚举同源生成，不可能漏项）。
            pub const ALL: &'static [CliTool] = &[ $( CliTool::$variant, )+ ];
        }
    };
}

define_cli_tools! {
    #[default]
    None => "none",
    Claude => "claude",
    Codex => "codex",
    Gemini => "gemini",
    Kimi => "kimi",
    Glm => "glm",
    Opencode => "opencode",
    Cursor => "cursor",
    Grok => "grok",
    Pi => "pi",
}

#[cfg(test)]
mod cli_tool_id_tests {
    use super::CliTool;

    #[test]
    fn from_id_round_trips_every_variant() {
        for tool in CliTool::ALL {
            assert_eq!(
                CliTool::from_id(tool.as_id()),
                Some(*tool),
                "round trip failed for {:?}",
                tool
            );
        }
    }

    /// id 必须两两不同——宏不会替我们查重，两个变体写同一个 id 时
    /// `from_id` 会静默只认后者，而 `as_id` 两边都返回它。
    #[test]
    fn ids_are_unique() {
        let mut ids: Vec<&str> = CliTool::ALL.iter().map(CliTool::as_id).collect();
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total, "duplicate CliTool id");
    }

    /// 未知 id 一律 None。**不要**拿将来打算支持的 CLI 名做断言——
    /// 那样等真的接进来时，这条会以「回归」的面目失败。
    #[test]
    fn from_id_rejects_unknown() {
        assert_eq!(CliTool::from_id("definitely-not-a-cli"), None);
        assert_eq!(CliTool::from_id(""), None);
        assert_eq!(CliTool::from_id("Claude"), None);
    }
}

/// WSL 启动信息
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslLaunchInfo {
    pub remote_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_remote_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distro: Option<String>,
}

/// 创建终端会话请求
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_id: Option<String>,
    pub project_path: String,
    pub cols: u16,
    pub rows: u16,
    pub workspace_name: Option<String>,
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default)]
    pub provider_selection: LaunchProviderSelection,
    pub launch_profile_id: Option<String>,
    pub workspace_path: Option<String>,
    pub workspace_snapshot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_layout_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_terminal_pane_id: Option<String>,
    /// Restore-only compare-and-create token. A claim-capable daemon atomically reuses this
    /// session when it is still live and identity-compatible, otherwise it creates only after
    /// proving the expected session is gone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_saved_session_id: Option<String>,
    #[serde(default)]
    pub launch_claude: bool,
    #[serde(default)]
    pub cli_tool: CliTool,
    pub resume_id: Option<String>,
    #[serde(default)]
    pub skip_mcp: bool,
    pub append_system_prompt: Option<String>,
    #[serde(default, alias = "prompt", skip_serializing_if = "Option::is_none")]
    pub initial_prompt: Option<String>,
    /// per-launch YOLO 覆盖：None = 跟随 launch profile 解析值
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yolo_mode: Option<bool>,
    /// per-launch adapter 选项（约定键：effort/extraArgs/verbose/maxTurns），
    /// 与 profile.adapter_options 合并，request 覆盖同名键
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter_options: Option<HashMap<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_env: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<crate::models::workspace::SshConnectionInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wsl: Option<WslLaunchInfo>,
}

impl CreateSessionRequest {
    /// 兼容映射：优先使用 cli_tool，fallback 到 launch_claude
    pub fn effective_cli_tool(&self) -> CliTool {
        match self.cli_tool {
            CliTool::None if self.launch_claude => CliTool::Claude,
            other => other,
        }
    }
}

/// 调整终端大小请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeRequest {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

/// 终端输出事件
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    pub session_id: String,
    pub data: String,
    /// 本批数据最后一个 raw chunk 的 seq（与 ReplayBuffer 记账同源，M3b-2）。
    /// None = 该路径不产 seq（轮询降级 / 旧 daemon）；旧端收到多字段自然忽略。
    #[serde(default, rename = "endSeq", skip_serializing_if = "Option::is_none")]
    pub end_seq: Option<u64>,
}

/// 终端重放快照的屏幕模式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalBufferMode {
    Normal,
    Alternate,
}

/// attach-existing 时用于重建当前屏幕状态的原始 VT 快照
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalReplaySnapshot {
    pub data: String,
    pub buffer_mode: TerminalBufferMode,
}

/// 前端拍摄的终端画面照片（SerializeAddon 产物），以 raw 流字节锚点配对。
///
/// `anchor_seq` = 拍照时前端已确认写入 xterm 的最后一个 raw chunk 的 endSeq；
/// 照片语义 = 「seq ≤ anchor 的全部 raw 字节的渲染效果」。
/// `checkpoint_epoch` 由 ReplayBuffer 创建时生成，daemon 重启 / 会话重建后
/// 必不相同，天然失效旧照片（绝不复用 daemon_generation）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCheckpoint {
    pub checkpoint_epoch: u64,
    pub anchor_seq: u64,
    pub snapshot_ansi: String,
    pub buffer_mode: TerminalBufferMode,
    pub cols: u16,
    pub rows: u16,
    pub checkpointed_at_ms: u64,
}

/// checkpoint+delta 结构化恢复响应（裁决 B：photo 直写、delta 必须过
/// renderTerminalData，二者写入管道不同，不能预拼接）。
///
/// `checkpoint_epoch` 随读返回：前端上传照片时必须带同一 epoch。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRecoverySnapshot {
    #[serde(default)]
    pub checkpoint: Option<TerminalCheckpoint>,
    pub delta: String,
    pub buffer_mode: TerminalBufferMode,
    pub end_seq: u64,
    pub checkpoint_epoch: u64,
}

/// store_checkpoint 的结构化结果（tag 化以便未来跨 REST 传输）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StoreCheckpointOutcome {
    #[serde(rename_all = "camelCase")]
    Accepted { anchor_seq: u64 },
    /// epoch 不等：照片来自旧的 buffer 世代（daemon 重启 / 会话重建）。
    RejectedEpochMismatch,
    /// anchor ≤ 现有照片锚点：旧照片不覆盖新照片。
    RejectedStaleAnchor,
    /// anchor < 窗口起点：anchor 之后的中段字节已被 front-drop 丢弃。
    RejectedAnchorGap,
    /// anchor > 当前 pushed_seq：声称渲染了尚未产生的字节。
    RejectedFutureAnchor,
    /// snapshot_ansi 超过 8MB 上限。
    RejectedTooLarge,
}

/// 终端退出事件
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExit {
    pub session_id: String,
    pub exit_code: i32,
}
