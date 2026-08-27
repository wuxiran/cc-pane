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
            "claude", "codex", "gemini", "kimi", "glm", "opencode", "cursor", "grok", "pi",
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
