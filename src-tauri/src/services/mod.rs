// Re-export core services from cc-panes-core
pub use cc_panes_core::services::*;

// Tauri-specific services (kept in src-tauri)
mod notification_service;
pub mod orchestrator_service;
pub mod screenshot_overlay;
mod screenshot_service;
mod session_prompt_service;
mod skill_market_service;

pub use notification_service::NotificationService;
pub use notification_service::{NotificationRequest, NotificationTriggerResult};
pub use orchestrator_service::{OrchestratorService, StartLocks};
pub use screenshot_service::{CaptureResult, ScreenshotService};
pub use session_prompt_service::extract_last_prompt;
pub use skill_market_service::{SkillMarketEntry, SkillMarketService};
