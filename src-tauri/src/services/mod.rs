// Re-export core services from cc-panes-core
pub use cc_panes_core::services::*;

// Tauri-specific services (kept in src-tauri)
mod notification_service;
mod screenshot_service;
pub mod screenshot_overlay;
pub mod orchestrator_service;

pub use notification_service::NotificationService;
pub use screenshot_service::{ScreenshotService, CaptureResult};
pub use orchestrator_service::OrchestratorService;
