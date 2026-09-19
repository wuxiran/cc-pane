use cc_cli_adapters::CliToolRegistry;

use crate::models::{
    CliTool, TaskDispatchEnvelope, TaskDispatchMcpCapability, TaskDispatchMode, TaskDispatchPlan,
    TaskDispatchRequest, TASK_DISPATCH_ENVELOPE_VERSION,
};

/// Plans cross-CLI task dispatches from the registered adapter capabilities.
///
/// This deliberately does not use the CLI's MCP support as a launch gate: a
/// target without MCP can still receive its initial task prompt and execute it.
pub struct TaskDispatchService {
    registry: CliToolRegistry,
}

impl TaskDispatchService {
    pub fn with_builtin_adapters() -> Self {
        Self {
            registry: CliToolRegistry::with_builtin_adapters(),
        }
    }

    pub fn plan(&self, request: TaskDispatchRequest) -> Result<TaskDispatchPlan, String> {
        if request
            .prompt
            .as_deref()
            .is_some_and(|prompt| prompt.trim().is_empty())
        {
            return Err("prompt cannot be empty".to_string());
        }
        if request
            .resume_id
            .as_deref()
            .is_some_and(|resume_id| resume_id.trim().is_empty())
        {
            return Err("resumeId cannot be empty".to_string());
        }

        let resume_id = request
            .resume_id
            .as_deref()
            .map(str::trim)
            .filter(|resume_id| !resume_id.is_empty())
            .map(str::to_string);
        let mode = match (&request.prompt, &resume_id) {
            (Some(_), None) => TaskDispatchMode::Prompt,
            (None, Some(_)) => TaskDispatchMode::Resume,
            (Some(_), Some(_)) => {
                return Err("prompt and resumeId are mutually exclusive".to_string())
            }
            (None, None) => return Err("must provide either prompt or resumeId".to_string()),
        };

        let requested_cli_tool = request
            .cli_tool
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_ascii_lowercase());
        let resolved_cli_tool = requested_cli_tool
            .clone()
            .unwrap_or_else(|| "claude".to_string());
        let cli_tool = CliTool::from_id(&resolved_cli_tool).ok_or_else(|| {
            format!(
                "Unknown cliTool '{}'; expected one of {}",
                resolved_cli_tool,
                self.known_tool_ids().join(", ")
            )
        })?;
        let adapter = self.registry.get(&resolved_cli_tool).ok_or_else(|| {
            format!(
                "CLI tool '{}' is not registered for task dispatch",
                resolved_cli_tool
            )
        })?;
        let capabilities = adapter.capabilities();
        if mode == TaskDispatchMode::Resume && !capabilities.supports_resume {
            return Err(format!(
                "CLI tool '{}' does not support resume dispatch",
                resolved_cli_tool
            ));
        }
        let mcp_supported = capabilities.supports_mcp;
        // project_path is an identity (including SSH URIs and WSL proxy paths).
        // Resolve an omitted cwd only after the orchestrator selects the runtime.
        let cwd = request
            .cwd
            .as_deref()
            .map(|cwd| resolve_dispatch_cwd(&request.project_path, Some(cwd)))
            .transpose()?;
        dispatch_permission_yolo_mode(request.permission_mode.as_deref())?;

        Ok(TaskDispatchPlan {
            cli_tool,
            envelope: TaskDispatchEnvelope {
                version: TASK_DISPATCH_ENVELOPE_VERSION,
                task_id: uuid::Uuid::new_v4().to_string(),
                binding_id: None,
                requested_cli_tool,
                resolved_cli_tool,
                project_path: request.project_path,
                workspace_name: clean_optional(request.workspace_name),
                profile_id: clean_optional(request.profile_id),
                runtime_kind: clean_optional(request.runtime_kind),
                cwd,
                permission_mode: clean_optional(request.permission_mode),
                model_id: clean_optional(request.model_id),
                mode,
                resume_id,
                skill_delivery_modes: adapter.skill_delivery_modes(),
                mcp: TaskDispatchMcpCapability {
                    supported: mcp_supported,
                    can_control_orchestration: mcp_supported,
                    can_report_result: adapter.can_report_task_result(),
                },
                parent_binding_id: clean_optional(request.parent_binding_id),
                parent_session_id: clean_optional(request.parent_session_id),
            },
        })
    }

    fn known_tool_ids(&self) -> Vec<&str> {
        self.registry
            .list_tools()
            .into_iter()
            .map(|tool| tool.id.as_str())
            .collect()
    }
}

impl Default for TaskDispatchService {
    fn default() -> Self {
        Self::with_builtin_adapters()
    }
}

/// Dispatch works in the registered project unless the caller explicitly chooses
/// another absolute directory. Runtime-specific existence/conversion is core-owned.
pub fn resolve_dispatch_cwd(project_path: &str, cwd: Option<&str>) -> Result<String, String> {
    let cwd = cwd.unwrap_or(project_path).trim();
    if cwd.is_empty() || cwd.chars().any(char::is_control) {
        return Err("cwd must be a non-empty absolute directory without control characters".into());
    }
    let drive_absolute = cwd.as_bytes().get(1) == Some(&b':')
        && cwd.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        && matches!(cwd.as_bytes().get(2), Some(b'/' | b'\\'));
    if !cwd.starts_with('/') && !cwd.starts_with(r"\\") && !drive_absolute {
        return Err("cwd must be an absolute directory".into());
    }
    Ok(cwd.to_string())
}

/// None inherits the launch profile. `default` only disables CC-Panes' YOLO
/// override; the CLI's own user settings remain under the user's control.
pub fn dispatch_permission_yolo_mode(mode: Option<&str>) -> Result<Option<bool>, String> {
    match mode.map(str::trim) {
        None => Ok(None),
        Some("default") => Ok(Some(false)),
        Some("bypassPermissions") => Ok(Some(true)),
        Some(_) => Err("permissionMode must be default or bypassPermissions".into()),
    }
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cc_cli_adapters::SkillDeliveryMode;

    fn request(cli_tool: Option<&str>) -> TaskDispatchRequest {
        TaskDispatchRequest {
            cli_tool: cli_tool.map(str::to_string),
            project_path: "C:/repo".to_string(),
            prompt: Some("implement the task".to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn dispatch_cwd_and_permission_overrides_validate_and_survive_round_trip() {
        let mut input = request(Some("claude"));
        input.cwd = Some("D:/worktree".into());
        input.permission_mode = Some("default".into());
        input.model_id = Some("model-override".into());
        let envelope = TaskDispatchService::default().plan(input).unwrap().envelope;
        assert_eq!(envelope.cwd.as_deref(), Some("D:/worktree"));
        assert_eq!(envelope.permission_mode.as_deref(), Some("default"));
        assert_eq!(envelope.model_id.as_deref(), Some("model-override"));
        let json = serde_json::to_value(&envelope).unwrap();
        assert_eq!(json["cwd"], "D:/worktree");
        assert_eq!(
            serde_json::from_value::<TaskDispatchEnvelope>(json).unwrap(),
            envelope
        );
        assert_eq!(
            resolve_dispatch_cwd("C:/project", None).unwrap(),
            "C:/project"
        );
        assert_eq!(
            resolve_dispatch_cwd("C:/project", Some("/home/user/repo")).unwrap(),
            "/home/user/repo"
        );
        for invalid in ["", " ", "relative/path", "D:relative", "x\n/y", "x\0/y"] {
            assert!(resolve_dispatch_cwd("C:/project", Some(invalid)).is_err());
        }
        assert_eq!(dispatch_permission_yolo_mode(None).unwrap(), None);
        assert_eq!(
            dispatch_permission_yolo_mode(Some("default")).unwrap(),
            Some(false)
        );
        assert_eq!(
            dispatch_permission_yolo_mode(Some("bypassPermissions")).unwrap(),
            Some(true)
        );
        assert!(dispatch_permission_yolo_mode(Some("invalid")).is_err());
        assert!(dispatch_permission_yolo_mode(Some("")).is_err());
    }

    #[test]
    fn omitted_cwd_leaves_remote_project_identity_for_runtime_resolution() {
        let mut input = request(Some("claude"));
        input.project_path = "ssh://user@host/home/user/repo".into();
        input.runtime_kind = Some("ssh".into());
        let envelope = TaskDispatchService::default().plan(input).unwrap().envelope;
        assert!(envelope.cwd.is_none());
        assert_eq!(envelope.project_path, "ssh://user@host/home/user/repo");
    }

    #[test]
    fn old_dispatch_envelopes_deserialize_without_overrides() {
        let envelope = TaskDispatchService::default()
            .plan(request(Some("claude")))
            .unwrap()
            .envelope;
        let mut json = serde_json::to_value(&envelope).unwrap();
        let object = json.as_object_mut().unwrap();
        for key in ["cwd", "permissionMode", "modelId"] {
            object.remove(key);
        }
        let old: TaskDispatchEnvelope = serde_json::from_value(json).unwrap();
        assert!(old.cwd.is_none());
        assert!(old.permission_mode.is_none());
        assert!(old.model_id.is_none());
    }

    #[test]
    fn defaults_to_claude_and_records_delivery_capabilities() {
        let plan = TaskDispatchService::default().plan(request(None)).unwrap();

        assert_eq!(plan.cli_tool, CliTool::Claude);
        assert_eq!(plan.envelope.resolved_cli_tool, "claude");
        assert_eq!(plan.envelope.mode, TaskDispatchMode::Prompt);
        assert!(plan.envelope.mcp.can_control_orchestration);
        assert_eq!(
            plan.envelope.skill_delivery_modes,
            vec![
                SkillDeliveryMode::NativeCommand,
                SkillDeliveryMode::NativeSkill,
                SkillDeliveryMode::SessionPrompt,
            ]
        );
    }

    #[test]
    fn every_builtin_cli_is_dispatchable_without_a_fixed_whitelist() {
        let service = TaskDispatchService::default();

        for cli_tool in [
            "claude", "codex", "gemini", "kimi", "opencode", "cursor", "grok", "pi",
        ] {
            let plan = service.plan(request(Some(cli_tool))).unwrap();
            assert_eq!(plan.envelope.resolved_cli_tool, cli_tool);
        }
    }

    #[test]
    fn no_mcp_target_remains_dispatchable_as_a_prompt_worker() {
        let plan = TaskDispatchService::default()
            .plan(request(Some("gemini")))
            .unwrap();

        assert_eq!(plan.cli_tool, CliTool::Gemini);
        assert!(!plan.envelope.mcp.supported);
        assert!(!plan.envelope.mcp.can_report_result);
        assert!(plan.envelope.skill_delivery_modes.is_empty());
    }

    #[test]
    fn opencode_reports_durable_results_separately_from_hook_lifecycle_events() {
        let plan = TaskDispatchService::default()
            .plan(request(Some("opencode")))
            .unwrap();

        assert!(plan.envelope.mcp.supported);
        assert!(plan.envelope.mcp.can_control_orchestration);
        assert!(plan.envelope.mcp.can_report_result);
    }

    #[test]
    fn cursor_is_dispatchable_with_mcp_after_user_config_injection() {
        let plan = TaskDispatchService::default()
            .plan(request(Some("cursor")))
            .unwrap();
        assert_eq!(plan.cli_tool, CliTool::Cursor);
        assert!(plan.envelope.mcp.supported);
        assert!(plan.envelope.mcp.can_report_result);
    }

    #[test]
    fn envelope_keeps_parent_and_resume_relationships() {
        let plan = TaskDispatchService::default()
            .plan(TaskDispatchRequest {
                cli_tool: Some("codex".to_string()),
                project_path: "C:/repo".to_string(),
                workspace_name: Some("workspace-a".to_string()),
                profile_id: Some("profile-a".to_string()),
                runtime_kind: Some("wsl".to_string()),
                prompt: None,
                resume_id: Some("resume-a".to_string()),
                parent_binding_id: Some("binding-a".to_string()),
                parent_session_id: Some("session-a".to_string()),
                ..Default::default()
            })
            .unwrap();

        assert_eq!(plan.envelope.mode, TaskDispatchMode::Resume);
        assert_eq!(plan.envelope.resume_id.as_deref(), Some("resume-a"));
        assert_eq!(
            plan.envelope.parent_binding_id.as_deref(),
            Some("binding-a")
        );
        assert_eq!(
            plan.envelope.parent_session_id.as_deref(),
            Some("session-a")
        );
    }

    #[test]
    fn rejects_ambiguous_or_unknown_dispatches() {
        let service = TaskDispatchService::default();
        let mut both = request(Some("codex"));
        both.resume_id = Some("resume-a".to_string());
        assert!(service
            .plan(both)
            .unwrap_err()
            .contains("mutually exclusive"));

        assert!(service
            .plan(request(Some("not-a-cli")))
            .unwrap_err()
            .contains("Unknown cliTool"));
    }

    #[test]
    fn rejects_resume_for_a_cli_without_resume_capability() {
        let error = TaskDispatchService::default()
            .plan(TaskDispatchRequest {
                cli_tool: Some("gemini".to_string()),
                project_path: "C:/repo".to_string(),
                prompt: None,
                resume_id: Some("resume-a".to_string()),
                ..Default::default()
            })
            .unwrap_err();

        assert!(error.contains("does not support resume dispatch"));
    }

    #[test]
    fn rejects_blank_prompt_and_resume_id() {
        let service = TaskDispatchService::default();

        let mut blank_prompt = request(Some("codex"));
        blank_prompt.prompt = Some("  \n\t".to_string());
        assert!(service
            .plan(blank_prompt)
            .unwrap_err()
            .contains("prompt cannot be empty"));

        let mut blank_resume = request(Some("codex"));
        blank_resume.prompt = None;
        blank_resume.resume_id = Some("  ".to_string());
        assert!(service
            .plan(blank_resume)
            .unwrap_err()
            .contains("resumeId cannot be empty"));
    }

    #[test]
    fn normalizes_cli_tool_and_resume_id_for_the_envelope() {
        let plan = TaskDispatchService::default()
            .plan(TaskDispatchRequest {
                cli_tool: Some("  CoDeX ".to_string()),
                project_path: "C:/repo".to_string(),
                prompt: None,
                resume_id: Some("  resume-a  ".to_string()),
                ..Default::default()
            })
            .unwrap();

        assert_eq!(plan.cli_tool, CliTool::Codex);
        assert_eq!(plan.envelope.resolved_cli_tool, "codex");
        assert_eq!(plan.envelope.resume_id.as_deref(), Some("resume-a"));
    }
}
