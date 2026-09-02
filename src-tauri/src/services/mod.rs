// Re-export core services from cc-panes-core
pub use cc_panes_core::services::*;

// Tauri-specific services (kept in src-tauri)
mod acp_chat_service;
mod automation_service;
mod browser_service;
mod comfy_runtime;
pub mod im_bridge;
mod launch_backfill_service;
mod notification_service;
pub mod orchestrator_service;
mod pi_rpc_event_bridge;
mod process_guard;
pub mod rest_launch_history;
mod resume_binding_service;
pub mod screenshot_overlay;
mod screenshot_service;
mod session_prompt_service;
mod skill_market_catalog;
mod skill_market_service;
mod skill_repo_fetcher;
mod tailscale_service;
mod task_queue_worker;
mod terminal_backend_state;
mod terminal_daemon_bridge_reliability;
mod terminal_daemon_control_link;
mod terminal_daemon_event_bridge;
mod terminal_daemon_lifecycle;
mod turn_notify_registry;
pub mod voice_service;
mod web_access_lifecycle;

pub use acp_chat_service::{AcpChatService, AcpChatSnapshot, AcpLaunchSpec, AUTO_APPROVE_ALL};
pub use automation_service::{AutomationDef, AutomationRun, AutomationService};
pub use browser_service::{
    BrowserBounds, BrowserOpenTabEvent, BrowserSpikeReport, BrowserTabManager,
};
pub use comfy_runtime::{ComfyRuntimeService, ComfyRuntimeStatus, COMFY_LOCAL_PROVIDER_ID};
pub use launch_backfill_service::rescue_null_codex_records;
pub use launch_backfill_service::run_launch_history_backfill;
pub(crate) use launch_backfill_service::{derive_project_name, detect_resume_session};
pub use notification_service::NotificationService;
pub use notification_service::{NotificationRequest, NotificationTriggerResult};
pub use orchestrator_service::{OrchestratorService, StartLocks};
pub use pi_rpc_event_bridge::{PiRpcEventBridge, PI_RPC_EVENT};
pub use resume_binding_service::{bind_resume_id, ResumeIdDetectedPayload};
pub use screenshot_service::{CaptureResult, ScreenshotService};
pub use session_prompt_service::extract_last_prompt;
pub use skill_market_catalog::CATEGORY_IDS as SKILL_MARKET_CATEGORY_IDS;
pub use skill_market_service::{SkillMarketEntry, SkillMarketService};
pub use tailscale_service::{detect_tailscale, TailscaleStatus};
pub use task_queue_worker::TaskQueueWorker;
pub use terminal_backend_state::{TerminalBackendKind, TerminalBackendState};
pub use terminal_daemon_bridge_reliability::BridgeStats;
pub use terminal_daemon_control_link::TerminalDaemonControlLink;
pub use terminal_daemon_control_link::{report_hidden_sessions, report_output_ack};
pub use terminal_daemon_event_bridge::TerminalDaemonEventBridge;
pub use terminal_daemon_lifecycle::TerminalDaemonLifecycle;
pub use turn_notify_registry::{TurnMark, TurnNotifyRegistry};
pub use web_access_lifecycle::{
    local_url as web_access_local_url, WebAccessLifecycle, WebAccessStatus,
};
