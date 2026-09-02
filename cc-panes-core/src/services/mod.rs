pub mod agent_transcript;
pub mod boundary_events;
pub mod claude_session_service;
pub mod codex_session_service;
pub mod comfy;
pub mod comfy_adapter;
pub mod comfy_events;
pub mod comfy_resources;
mod ctl_sidecar;
pub mod cursor_session_service;
mod daemon_client;
pub mod default_skill_service;
pub mod dsh_service;
mod external_skill_registry;
pub mod external_usage_session_service;
mod filesystem_service;
mod git_service;
mod history_service;
mod history_watch_manager;
mod journal_service;
mod launch_history_service;
mod launch_profile_service;
mod layout_snapshot_service;
pub mod mcp_config_service;
pub mod media_probe;
pub mod media_provider;
pub mod media_runtime;
pub mod media_service;
mod memory_service;
pub mod opencode_session_service;
pub mod pi_rpc_service;
pub(crate) mod pi_session_service;
pub mod pipe_event_service;
pub mod plan_archive_service;
pub mod plan_service;
mod port_scanner;
mod process_monitor_service;
mod project_cli_hooks_service;
mod project_context_service;
mod project_service;
mod project_skill_service;
mod provider_resolver;
mod provider_service;
mod quick_command_service;
pub mod resume_identity;
mod runner_service;
mod session_index_parser;
mod session_index_roots;
mod session_index_service;
pub mod session_provenance_persist;
mod session_restore_service;
pub mod session_state_machine;
mod settings_service;
mod shared_mcp_service;
pub mod skill_service;
mod spec_service;
mod ssh_connection_service;
mod ssh_credential_service;
mod ssh_file_service;
mod ssh_machine_service;
mod ssh_terminal_service;
mod system_stats_service;
mod task_binding_service;
mod task_dispatch_service;
mod task_queue_dispatcher;
mod task_queue_service;
mod terminal_backend;
pub mod terminal_output_flow;
mod terminal_path_link_service;
pub mod terminal_service;
mod todo_service;
mod uninstall_cleanup_service;
pub mod usage_stats_service;
mod user_skill_service;
mod wallpaper_service;
mod workspace_health;
mod workspace_service;
mod worktree_service;
// 模块内部自带平台门控：Windows 编译完整实现（inner mod），非 Windows 只暴露
// is_wsl_vm_running 恒 false stub —— 这里不能再整体 cfg 掉，否则非 Windows
// 调用方（usage_stats_service::wsl_scan_allowed）编译失败。
pub mod wsl_discovery_service;

pub use agent_transcript::read_agent_transcript;
pub use comfy::{
    canonical_json, json_fingerprint, ComfyEvent, ComfyHistoryResult, ComfyObjectInfoResponse,
    ComfyOutputRef, ComfyPromptNode, ComfyPromptResponse, ComfyWorkflow,
    COMFY_OBJECT_INFO_SCHEMA_VERSION, COMFY_WORKFLOW_SCHEMA_VERSION,
};
pub use comfy_adapter::{
    shared_comfy_adapter_cache, ComfyAdapterCache, ComfyAdapterProfile, ComfyInputRef,
    ComfyMediaAdapter,
};
pub use comfy_events::{comfy_websocket_url, ComfyEventStream};
pub use comfy_resources::{
    ComfyDeviceInfo, ComfyMemoryReleaseResult, ComfySystemInfo, ComfySystemStats,
    COMFY_SYSTEM_STATS_SCHEMA_VERSION,
};
pub use daemon_client::{
    app_instance_id, TerminalDaemonClient, TerminalDaemonManifest, TerminalDaemonStatus,
};
pub use default_skill_service::{
    BundledSkillInfo, DefaultSkillCleanupReport, DefaultSkillService,
    LEGACY_CLEANUP_REPORT_FILE_NAME, MANAGED_SKILLS_SUBDIR,
};
pub use dsh_service::DshService;
pub use external_skill_registry::{
    parse_skill_metadata, skill_frontmatter_field, ExternalSkillRegistry,
};
pub use filesystem_service::{ContentSearchLimits, FileSystemService};
pub use git_service::GitService;
pub use history_service::HistoryService;
pub use history_watch_manager::{HistoryWatchManager, HistoryWatchStats};
pub use journal_service::{JournalIndex, JournalService, SessionSummary};
pub use launch_history_service::{CreatedLaunchHistory, LaunchHistoryService};
pub use launch_profile_service::LaunchProfileService;
pub use layout_snapshot_service::LayoutSnapshotService;
pub use mcp_config_service::McpConfigService;
pub use media_probe::{
    parse_ffprobe_json, MediaProbe, MediaProbeConfig, MediaProbeReport, MediaProbeStatus,
    MEDIA_PROBE_EXECUTABLE_ENV,
};
pub use media_provider::{
    apply_media_run_protocol, parse_openai_status_response, parse_openai_submit_response,
    parse_openai_submit_response_for_kind, parse_status_response, parse_status_response_for_kind,
    parse_submit_response, parse_submit_response_for_kind, registry_from_providers,
    DownloadedAsset, MediaHttpMethod, MediaInputAsset, MediaJobStatus, MediaProtocol,
    MediaProviderAdapter, MediaProviderCapabilities, MediaProviderFuture, MediaProviderProfile,
    MediaProviderRegistry, NormalizedMediaRequest, OpenAiCompatibleMediaAdapter, RemoteJob,
    RemoteJobError, RemoteJobStatus, RemoteOutput,
};
pub use media_runtime::{DeterministicMockMediaProvider, MediaJobWorker};
pub use media_service::MediaService;
pub use memory_service::MemoryService;
pub use pi_rpc_service::{
    PiRpcCommandResponse, PiRpcEvent, PiRpcLaunchSpec, PiRpcService, PiRpcSessionPhase,
    PiRpcSessionSnapshot,
};
pub use pipe_event_service::{PipeEventRequest, PipeEventService};
pub use plan_archive_service::PlanArchiveService;
pub use plan_service::PlanService;
pub use port_scanner::{ListeningSocket, PortScanner};
pub use process_monitor_service::ProcessMonitorService;
pub use project_cli_hooks_service::{ProjectCliHookGroupStatus, ProjectCliHooksService};
pub use project_context_service::ProjectContextService;
pub use project_service::ProjectService;
pub use provider_resolver::{
    managed_provider_conflict_env_keys, resolve_provider_plan, validate_provider_runtime,
    ProviderMode, ProviderResolutionInput, ProviderSource, ResolvedProviderPlan,
};
pub use provider_service::ProviderService;
pub use quick_command_service::QuickCommandService;
pub use resume_identity::{should_replace_source, should_retain_incoming, source_priority};
pub use runner_service::RunnerService;
pub use session_index_service::SessionIndexService;
pub use session_provenance_persist::{
    backfill_missing_provenance, cleanup_failed_session_persistence,
    persist_created_session_observation, persist_created_session_or_cleanup,
    ProvenanceBackfillReport,
};
pub use session_restore_service::{
    write_session_checkpoint, write_session_output, SessionRestoreService,
};
pub use session_state_machine::{SessionStateMachine, StateTransition, TransitionListener};
pub use settings_service::SettingsService;
pub use shared_mcp_service::SharedMcpService;
pub use project_skill_service::{
    ProjectSkill, ProjectSkillContent, ProjectSkillRoot, ProjectSkillService, PROJECT_SKILL_ROOTS,
};
pub use skill_service::SkillService;
pub use spec_service::SpecService;
pub use ssh_connection_service::SshConnectionService;
pub use ssh_credential_service::SshCredentialService;
pub use ssh_file_service::SshFileService;
pub use ssh_machine_service::{SshConnectivityResult, SshMachineService};
pub use system_stats_service::SystemStatsService;
pub use task_binding_service::TaskBindingService;
pub use task_dispatch_service::TaskDispatchService;
pub use task_queue_dispatcher::{
    BackendTaskQueueDispatchGateway, TaskQueueDispatchGateway, TaskQueueDispatchOutcome,
    TaskQueueDispatcher, TaskQueueReadiness, TaskQueueSubmitFailure,
};
pub use task_queue_service::{
    TaskQueueService, UnattendedPermissionDecision, TASK_QUEUE_IMAGE_MAX_BYTES,
};
pub use terminal_backend::{
    set_claim_lost_hook, AutomaticWriteAuthority, CreateSessionOutcome, DaemonTerminalBackend,
    InProcessTerminalBackend, TerminalAdoptionSnapshot, TerminalBackend,
};
pub use terminal_path_link_service::{
    resolve_terminal_path_link, resolve_terminal_path_link_for_desktop, ResolvedTerminalPathLink,
    TerminalLinkContext, TerminalPathKind,
};
pub use terminal_service::{
    codex_rollout_exists, KillReason, OrchestratorInfo, SessionStatusInfo, ShellInfo,
    TerminalService,
};
pub use todo_service::TodoService;
pub use uninstall_cleanup_service::{UninstallCleanupReport, UninstallCleanupService};
pub use usage_stats_service::UsageStatsService;
pub use user_skill_service::{InstalledUserSkill, UserSkillContent, UserSkillService};
pub use wallpaper_service::{WallpaperFileInfo, WallpaperService};
pub use workspace_health::{check_project_paths, classify_path, PathStatusKind, ProjectPathStatus};
pub use workspace_service::{WorkspaceProjectIdentityMigrationReport, WorkspaceService};
pub use worktree_service::{WorktreeInfo, WorktreeService};
