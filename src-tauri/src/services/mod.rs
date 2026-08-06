// Re-export core services from cc-panes-core
pub use cc_panes_core::services::*;

// Tauri-specific services (kept in src-tauri)
mod browser_service;
mod launch_backfill_service;
mod notification_service;
pub mod orchestrator_service;
mod process_guard;
pub mod rest_launch_history;
mod resume_binding_service;
pub mod screenshot_overlay;
mod screenshot_service;
mod session_prompt_service;
mod skill_market_service;
mod tailscale_service;
mod terminal_backend_state;
mod terminal_daemon_bridge_reliability;
mod terminal_daemon_control_link;
mod terminal_daemon_event_bridge;
mod terminal_daemon_lifecycle;
mod web_access_lifecycle;

pub use browser_service::{
    BrowserBounds, BrowserOpenTabEvent, BrowserSpikeReport, BrowserTabManager,
};
pub use launch_backfill_service::rescue_null_codex_records;
pub use launch_backfill_service::run_launch_history_backfill;
pub(crate) use launch_backfill_service::{derive_project_name, detect_resume_session};
pub use notification_service::NotificationService;
pub use notification_service::{NotificationRequest, NotificationTriggerResult};
pub use orchestrator_service::{OrchestratorService, StartLocks};
pub use resume_binding_service::{bind_resume_id, ResumeIdDetectedPayload};
pub use screenshot_service::{CaptureResult, ScreenshotService};
pub use session_prompt_service::extract_last_prompt;
pub use skill_market_service::{SkillMarketEntry, SkillMarketService};
pub use tailscale_service::{detect_tailscale, TailscaleStatus};
pub use terminal_backend_state::{TerminalBackendKind, TerminalBackendState};
pub use terminal_daemon_bridge_reliability::BridgeStats;
pub use terminal_daemon_control_link::report_hidden_sessions;
pub use terminal_daemon_control_link::TerminalDaemonControlLink;
pub use terminal_daemon_event_bridge::TerminalDaemonEventBridge;
pub use terminal_daemon_lifecycle::TerminalDaemonLifecycle;
pub use web_access_lifecycle::{
    local_url as web_access_local_url, WebAccessLifecycle, WebAccessStatus,
};
