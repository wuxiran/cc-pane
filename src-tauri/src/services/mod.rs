// Re-export core services from cc-panes-core
pub use cc_panes_core::services::*;

// Tauri-specific services (kept in src-tauri)
mod acp_chat_service;
mod acp_client_ops;
mod automation_service;
pub mod bot_service;
pub mod browser_cookie_import;
mod browser_service;
pub mod bundled_skills;
pub mod channel_purity;
pub mod feishu_cli;
pub mod heavy_command_recorder;
pub mod heavy_command_sampler;
mod heavy_job_policy_queue;
pub mod heavy_job_routes;
pub mod im_bridge;
pub mod keep_awake_runtime;
mod launch_backfill_service;
mod mcp_hub_handler;
mod mcp_market;
pub(crate) mod notification_preferences;
mod notification_service;
pub mod orchestrator_service;
mod orchestrator_token;
pub mod performance_recorder;
mod pi_rpc_event_bridge;
pub(crate) mod process_guard;
pub mod rest_launch_history;
mod resume_binding_service;
pub(crate) mod screenshot_events;
pub mod screenshot_overlay;
mod screenshot_service;
mod session_prompt_service;
mod skill_market_catalog;
mod skill_market_service;
mod tailscale_service;
mod task_queue_worker;
mod terminal_backend_state;
mod terminal_daemon_bridge_reliability;
mod terminal_daemon_control_link;
mod terminal_daemon_event_bridge;
mod terminal_daemon_lifecycle;
mod terminal_daemon_output_cursor;
pub mod tray_menu;
mod tray_refresh;
mod turn_notify_registry;
pub mod voice_local;
pub mod voice_service;
mod web_access_lifecycle;
pub mod wechat_component;

pub use acp_chat_service::edits::UndoAcpFileEdit;
pub use acp_chat_service::journal::{EventPage, RunFilter, RunPage};
pub(crate) use acp_chat_service::remote as acp_remote;
pub use acp_chat_service::{
    AcpChatEvent, AcpChatPhase, AcpChatService, AcpChatSnapshot, AcpLaunchSpec, ChatEventStream,
    PermissionBinding, PromptAnnouncement, AUTO_APPROVE_ALL,
};
pub use automation_service::{AutomationDef, AutomationRun, AutomationService};
pub use bot_service::{Bot, BotService, BotSummary};
pub use browser_service::{
    BrowserBounds, BrowserDomSnapshot, BrowserElement, BrowserHostState, BrowserOpenTabEvent,
    BrowserSpikeReport, BrowserTabInfo, BrowserTabManager, BrowserViewport, BrowserViewportRequest,
    BrowserViewportResult, BrowserWindowMode,
};
pub use heavy_command_recorder::HeavyCommandRecorder;
pub use heavy_command_sampler::HeavyCommandSampler;
pub use heavy_job_routes::{AppHeavyJobEnvironment, HeavyJobGateState};
pub use launch_backfill_service::rescue_null_codex_records;
pub use launch_backfill_service::run_launch_history_backfill;
pub(crate) use launch_backfill_service::{derive_project_name, detect_resume_session};
pub use mcp_market::{McpMarketResult, McpMarketService};
pub use notification_service::NotificationService;
pub use notification_service::{NotificationRequest, NotificationTriggerResult};
pub use orchestrator_service::{OrchestratorService, StartLocks};
pub use orchestrator_token::OrchestratorToken;
pub use pi_rpc_event_bridge::{PiRpcEventBridge, PI_RPC_EVENT};
pub use resume_binding_service::{
    apply_launch_failure, bind_resume_id, is_launch_failure_warning, LaunchFailurePayload,
    ResumeIdDetectedPayload,
};
pub use screenshot_service::{CaptureResult, ScreenshotService};
pub use session_prompt_service::extract_last_prompt;
pub use skill_market_catalog::CATEGORY_IDS as SKILL_MARKET_CATEGORY_IDS;
pub use skill_market_service::{SkillMarketEntry, SkillMarketService};
pub use tailscale_service::{
    detect_tailscale, tailscale_serve_disable, tailscale_serve_enable, tailscale_serve_status,
    TailscaleServeError, TailscaleServeStatus, TailscaleStatus,
};
pub use task_queue_worker::TaskQueueWorker;
pub use terminal_backend_state::{TerminalBackendKind, TerminalBackendState};
pub use terminal_daemon_bridge_reliability::BridgeStats;
pub use terminal_daemon_control_link::TerminalDaemonControlLink;
pub use terminal_daemon_control_link::{report_hidden_sessions, report_output_ack};
pub use terminal_daemon_event_bridge::TerminalDaemonEventBridge;
pub use terminal_daemon_lifecycle::TerminalDaemonLifecycle;
pub use turn_notify_registry::{TurnMark, TurnNotifyRegistry};
pub use web_access_lifecycle::{
    local_url as web_access_local_url, resolve_web_binary, WebAccessLifecycle, WebAccessStatus,
};
