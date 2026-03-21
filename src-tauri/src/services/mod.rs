// Re-export core services from cc-panes-core
pub use cc_panes_core::services::*;

// Tauri-specific services (kept in src-tauri)
mod notification_service;
pub mod orchestrator_service;
pub mod screenshot_overlay;
mod screenshot_service;

pub use notification_service::NotificationService;
pub use orchestrator_service::OrchestratorService;
pub use screenshot_service::{CaptureResult, ScreenshotService};
