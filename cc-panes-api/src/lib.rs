//! CC-Panes HTTP/WebSocket API adapter
//!
//! This crate provides an axum Router that exposes cc-panes-core services
//! over HTTP and WebSocket. It does NOT depend on Tauri.
//!
//! Currently a placeholder — routes will be incrementally migrated from
//! src-tauri's OrchestratorService.

pub mod error;
pub mod routes;
