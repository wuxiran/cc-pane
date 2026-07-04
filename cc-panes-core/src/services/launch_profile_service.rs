use crate::models::launch_profile::{
    LaunchProfile, LaunchProfileConfig, LaunchProfileDraft, LaunchProfileMcpMode,
    LaunchProfilePreviewRequest, LaunchProfileResolution, LaunchProfileSkillMode,
    LaunchProviderSelection, ResolvedMcpServer, ResolvedSkill, SharedMcpUrls,
};
use crate::models::provider::Provider;
use crate::models::shared_mcp::SharedMcpConfig;
use crate::models::ExternalSkillSource;
use crate::models::Workspace;
use crate::services::{ExternalSkillRegistry, UserSkillContent, UserSkillService};
use anyhow::{anyhow, Context, Result};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// 启动配置解析诊断：当用户**显式选中**的 profile 存在、却因 CLI/运行环境不匹配被
/// 静默丢弃（回落到默认配置或无）时携带的信息，供启动链路提示"所选配置未生效"。
#[derive(Debug, Clone, PartialEq)]
pub struct ProfileResolutionDiagnostic {
    pub requested_profile_id: String,
    pub requested_profile_name: String,
    /// 请求的 profile 的 target_tools 不包含当前 CLI。
    pub cli_mismatch: bool,
    /// 请求的 profile 的 target_runtime 与当前运行环境不符。
    pub runtime_mismatch: bool,
    /// 实际回落使用的 profile（可能为 None，即无任何默认可用）。
    pub used_profile_id: Option<String>,
    pub used_profile_name: Option<String>,
}

pub struct LaunchProfileService {
    config_path: PathBuf,
    user_skills_dir: PathBuf,
    external_skill_registry: Arc<ExternalSkillRegistry>,
    config: Mutex<LaunchProfileConfig>,
}

impl LaunchProfileService {
    pub fn new(config_path: PathBuf) -> Self {
        Self::new_with_external_skill_registry(config_path, default_external_skill_registry())
    }

    pub fn new_with_external_skill_registry(
        config_path: PathBuf,
        external_skill_registry: Arc<ExternalSkillRegistry>,
    ) -> Self {
        let config = Self::load_from_file(&config_path).unwrap_or_default();
        let user_skills_dir = config_path
            .parent()
            .map(|parent| parent.join("skills").join("user"))
            .unwrap_or_else(|| PathBuf::from("skills").join("user"));
        Self {
            config_path,
            user_skills_dir,
            external_skill_registry,
            config: Mutex::new(config),
        }
    }

    fn load_from_file(path: &Path) -> Result<LaunchProfileConfig> {
        if !path.exists() {
            return Ok(LaunchProfileConfig::default());
        }
        let content = std::fs::read_to_string(path)
            .with_context(|| format!("Failed to read {}", path.display()))?;
        if content.trim().is_empty() {
            return Ok(LaunchProfileConfig::default());
        }
        serde_json::from_str(&content).with_context(|| "Failed to parse launch profiles")
    }

    fn save_to_file(&self, config: &LaunchProfileConfig) -> Result<()> {
        if let Some(parent) = self.config_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("Failed to create {}", parent.display()))?;
        }
        let content = serde_json::to_string_pretty(config)
            .with_context(|| "Failed to serialize launch profiles")?;
        std::fs::write(&self.config_path, content)
            .with_context(|| format!("Failed to write {}", self.config_path.display()))
    }

    fn normalize_target_tools(target_tools: Vec<String>) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut normalized = Vec::new();
        for tool in target_tools {
            let tool = tool.trim().to_ascii_lowercase();
            if tool.is_empty() || tool == "none" || !seen.insert(tool.clone()) {
                continue;
            }
            normalized.push(tool);
            break;
        }
        normalized
    }

    fn normalize_runtime(runtime: Option<String>) -> Option<String> {
        runtime
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty() && *value != "all")
            .map(str::to_ascii_lowercase)
            .filter(|value| matches!(value.as_str(), "local" | "wsl" | "ssh"))
    }

    fn normalize_runtime_ref(runtime: Option<&str>) -> Option<String> {
        runtime
            .map(str::trim)
            .filter(|value| !value.is_empty() && *value != "all")
            .map(str::to_ascii_lowercase)
            .filter(|value| matches!(value.as_str(), "local" | "wsl" | "ssh"))
    }

    fn target_tools_overlap(left: &[String], right: &[String]) -> bool {
        if left.is_empty() || right.is_empty() {
            return true;
        }
        left.iter()
            .any(|tool| right.iter().any(|other| other == tool))
    }

    fn target_runtime_overlap(left: Option<&str>, right: Option<&str>) -> bool {
        left.is_none() || right.is_none() || left == right
    }

    fn profile_matches_cli(profile: &LaunchProfile, cli_tool: Option<&str>) -> bool {
        let Some(cli_tool) = cli_tool
            .map(str::trim)
            .filter(|tool| !tool.is_empty() && *tool != "none")
        else {
            return true;
        };
        profile.target_tools.is_empty()
            || profile
                .target_tools
                .iter()
                .any(|tool| tool.as_str() == cli_tool)
    }

    fn profile_matches_runtime(profile: &LaunchProfile, runtime_kind: Option<&str>) -> bool {
        let Some(runtime_kind) = runtime_kind
            .map(str::trim)
            .filter(|runtime| !runtime.is_empty() && *runtime != "all")
        else {
            return true;
        };
        profile.target_runtime.as_deref().is_none()
            || profile.target_runtime.as_deref() == Some(runtime_kind)
    }

    fn runtime_match_score(profile: &LaunchProfile, runtime_kind: Option<&str>) -> Option<u8> {
        let runtime_kind = runtime_kind
            .map(str::trim)
            .filter(|runtime| !runtime.is_empty() && *runtime != "all");
        match (profile.target_runtime.as_deref(), runtime_kind) {
            (Some(profile_runtime), Some(runtime)) if profile_runtime == runtime => Some(2),
            (None, Some(_)) => Some(1),
            (_, None) => Some(1),
            _ => None,
        }
    }

    fn normalize_alias(alias: Option<String>, fallback_name: &str) -> Option<String> {
        alias
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| Some(fallback_name.to_string()))
    }

    fn clear_overlapping_defaults(
        config: &mut LaunchProfileConfig,
        keep_id: &str,
        target_tools: &[String],
        target_runtime: Option<&str>,
    ) {
        for existing in &mut config.profiles {
            if existing.id != keep_id
                && Self::target_tools_overlap(&existing.target_tools, target_tools)
                && Self::target_runtime_overlap(existing.target_runtime.as_deref(), target_runtime)
            {
                existing.is_default = false;
            }
        }
    }

    pub fn list_profiles(&self) -> Vec<LaunchProfile> {
        self.config
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .profiles
            .clone()
    }

    pub fn get_profile(&self, id: &str) -> Option<LaunchProfile> {
        self.config
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .profiles
            .iter()
            .find(|profile| profile.id == id)
            .cloned()
    }

    pub fn create_profile(&self, draft: LaunchProfileDraft) -> Result<LaunchProfile> {
        let now = chrono::Utc::now().to_rfc3339();
        let name = draft
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("Launch profile name cannot be empty"))?
            .to_string();
        let mut profile = LaunchProfile {
            id: uuid::Uuid::new_v4().to_string(),
            alias: Self::normalize_alias(draft.alias, &name),
            name,
            description: draft.description,
            provider_id: draft.provider_id,
            adapter_options: draft.adapter_options,
            target_tools: Self::normalize_target_tools(draft.target_tools),
            target_runtime: Self::normalize_runtime(draft.target_runtime),
            yolo_mode: draft.yolo_mode,
            mcp_policy: draft.mcp_policy,
            skill_policy: draft.skill_policy,
            is_default: draft.is_default,
            created_at: now.clone(),
            updated_at: now,
        };

        let mut config = self
            .config
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if config.profiles.is_empty() {
            profile.is_default = true;
        }
        if profile.is_default {
            Self::clear_overlapping_defaults(
                &mut config,
                &profile.id,
                &profile.target_tools,
                profile.target_runtime.as_deref(),
            );
        }
        config.profiles.push(profile.clone());
        self.save_to_file(&config)?;
        Ok(profile)
    }

    pub fn update_profile(&self, id: &str, draft: LaunchProfileDraft) -> Result<LaunchProfile> {
        let mut config = self
            .config
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let pos = config
            .profiles
            .iter()
            .position(|profile| profile.id == id)
            .ok_or_else(|| anyhow!("Launch profile '{}' not found", id))?;
        let name = draft
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("Launch profile name cannot be empty"))?
            .to_string();
        let target_tools = Self::normalize_target_tools(draft.target_tools);
        let target_runtime = Self::normalize_runtime(draft.target_runtime);

        if draft.is_default {
            Self::clear_overlapping_defaults(
                &mut config,
                id,
                &target_tools,
                target_runtime.as_deref(),
            );
        }

        let mut next = config.profiles[pos].clone();
        next.alias = Self::normalize_alias(draft.alias, &name);
        next.name = name;
        next.description = draft.description;
        next.provider_id = draft.provider_id;
        next.adapter_options = draft.adapter_options;
        next.target_tools = target_tools;
        next.target_runtime = target_runtime;
        next.yolo_mode = draft.yolo_mode;
        next.mcp_policy = draft.mcp_policy;
        next.skill_policy = draft.skill_policy;
        next.is_default = draft.is_default;
        next.updated_at = chrono::Utc::now().to_rfc3339();
        config.profiles[pos] = next.clone();
        self.save_to_file(&config)?;
        Ok(next)
    }

    pub fn delete_profile(&self, id: &str) -> Result<()> {
        let mut config = self
            .config
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let removed_default_target = config
            .profiles
            .iter()
            .find(|profile| profile.id == id && profile.is_default)
            .map(|profile| (profile.target_tools.clone(), profile.target_runtime.clone()));
        config.profiles.retain(|profile| profile.id != id);
        if let Some((target_tools, target_runtime)) = removed_default_target {
            let has_replacement_default = config.profiles.iter().any(|profile| {
                profile.is_default
                    && Self::target_tools_overlap(&profile.target_tools, &target_tools)
                    && Self::target_runtime_overlap(
                        profile.target_runtime.as_deref(),
                        target_runtime.as_deref(),
                    )
            });
            if !has_replacement_default {
                if let Some(first) = config.profiles.iter_mut().find(|profile| {
                    Self::target_tools_overlap(&profile.target_tools, &target_tools)
                        && Self::target_runtime_overlap(
                            profile.target_runtime.as_deref(),
                            target_runtime.as_deref(),
                        )
                }) {
                    first.is_default = true;
                }
            }
        }
        self.save_to_file(&config)
    }

    pub fn set_default_profile(&self, id: &str) -> Result<()> {
        let mut config = self
            .config
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let (target_tools, target_runtime) = config
            .profiles
            .iter()
            .find(|profile| profile.id == id)
            .map(|profile| (profile.target_tools.clone(), profile.target_runtime.clone()))
            .ok_or_else(|| anyhow!("Launch profile '{}' not found", id))?;
        Self::clear_overlapping_defaults(&mut config, id, &target_tools, target_runtime.as_deref());
        if let Some(profile) = config.profiles.iter_mut().find(|profile| profile.id == id) {
            profile.is_default = true;
            profile.updated_at = chrono::Utc::now().to_rfc3339();
        }
        self.save_to_file(&config)
    }

    pub fn resolve_launch_profile(
        &self,
        profile_id: Option<&str>,
        workspace: Option<&Workspace>,
        project_id: Option<&str>,
        cli_tool: Option<&str>,
        runtime_kind: Option<&str>,
    ) -> Option<LaunchProfile> {
        self.resolve_launch_profile_with_diagnostic(
            profile_id,
            workspace,
            project_id,
            cli_tool,
            runtime_kind,
        )
        .0
    }

    /// 与 [`resolve_launch_profile`](Self::resolve_launch_profile) 相同的解析，但额外返回诊断：
    /// 当**显式传入**的 `profile_id` 对应的 profile 存在、却因 CLI/运行环境不匹配未能被选中
    /// （被静默丢弃、回落到默认或无）时，返回 `Some(ProfileResolutionDiagnostic)`。
    /// 启动链路据此提示用户"所选配置未生效"，避免 YOLO 等 profile 级设置无声失效。
    pub fn resolve_launch_profile_with_diagnostic(
        &self,
        profile_id: Option<&str>,
        workspace: Option<&Workspace>,
        project_id: Option<&str>,
        cli_tool: Option<&str>,
        runtime_kind: Option<&str>,
    ) -> (Option<LaunchProfile>, Option<ProfileResolutionDiagnostic>) {
        let profiles = self.list_profiles();
        let runtime_kind = Self::normalize_runtime_ref(runtime_kind);
        let runtime_kind = runtime_kind.as_deref();
        let project_profile_id = project_id.and_then(|project_id| {
            workspace.and_then(|ws| {
                ws.projects
                    .iter()
                    .find(|project| project.id == project_id)
                    .and_then(|project| project.launch_profile_id.as_deref())
            })
        });
        let candidate_id = profile_id
            .or(project_profile_id)
            .or_else(|| workspace.and_then(|ws| ws.launch_profile_id.as_deref()));

        let resolved = candidate_id
            .and_then(|id| {
                profiles
                    .iter()
                    .find(|profile| {
                        profile.id == id
                            && Self::profile_matches_cli(profile, cli_tool)
                            && Self::profile_matches_runtime(profile, runtime_kind)
                    })
                    .cloned()
            })
            .or_else(|| {
                profiles
                    .iter()
                    .filter(|profile| {
                        profile.is_default
                            && Self::profile_matches_cli(profile, cli_tool)
                            && Self::profile_matches_runtime(profile, runtime_kind)
                    })
                    .max_by_key(|profile| {
                        Self::runtime_match_score(profile, runtime_kind).unwrap_or(0)
                    })
                    .cloned()
            });

        // 诊断：仅当用户「显式选中」了一个存在的 profile，但它因 CLI/runtime 不匹配
        // 未能成为 resolved（被静默丢弃）时给出信号。默认/工作区回落不触发提示。
        let diagnostic = profile_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .and_then(|id| profiles.iter().find(|profile| profile.id == id))
            .and_then(|requested| {
                let cli_ok = Self::profile_matches_cli(requested, cli_tool);
                let runtime_ok = Self::profile_matches_runtime(requested, runtime_kind);
                if cli_ok && runtime_ok {
                    return None;
                }
                Some(ProfileResolutionDiagnostic {
                    requested_profile_id: requested.id.clone(),
                    requested_profile_name: requested.name.clone(),
                    cli_mismatch: !cli_ok,
                    runtime_mismatch: !runtime_ok,
                    used_profile_id: resolved.as_ref().map(|profile| profile.id.clone()),
                    used_profile_name: resolved.as_ref().map(|profile| profile.name.clone()),
                })
            });

        (resolved, diagnostic)
    }

    pub fn selected_profile_compatibility(
        &self,
        profile_id: &str,
        cli_tool: Option<&str>,
        runtime_kind: Option<&str>,
    ) -> Option<bool> {
        let runtime_kind = Self::normalize_runtime_ref(runtime_kind);
        self.config
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .map(|profile| {
                Self::profile_matches_cli(profile, cli_tool)
                    && Self::profile_matches_runtime(profile, runtime_kind.as_deref())
            })
    }

    pub fn should_skip_mcp_for_profile(
        profile: Option<&LaunchProfile>,
        requested_skip_mcp: bool,
    ) -> bool {
        requested_skip_mcp
            || profile
                .map(|profile| {
                    profile.mcp_policy.mode == LaunchProfileMcpMode::Disabled
                        || !profile.mcp_policy.include_ccpanes_mcp
                })
                .unwrap_or(false)
    }

    pub fn should_sync_project_hooks_for_profile(profile: Option<&LaunchProfile>) -> bool {
        profile
            .map(|profile| {
                profile.skill_policy.mode != LaunchProfileSkillMode::Disabled
                    && (profile.skill_policy.include_project_skills
                        || !Self::selected_profile_skills(profile).is_empty())
            })
            .unwrap_or(true)
    }

    pub fn session_skill_prompt_for_profile(
        &self,
        profile: Option<&LaunchProfile>,
    ) -> Option<String> {
        let profile = profile?;
        if profile.skill_policy.mode == LaunchProfileSkillMode::Disabled
            || profile.skill_policy.target != "session"
        {
            return None;
        }

        let profile_skills = Self::selected_profile_skills(profile);
        let user_skills = self.selected_user_skill_contents(profile);
        let allowed_skills = self.allowed_skill_entries(profile);
        if profile_skills.is_empty() && user_skills.is_empty() && allowed_skills.is_empty() {
            return None;
        }

        let mut prompt = String::new();
        if !profile_skills.is_empty() || !user_skills.is_empty() {
            prompt.push_str(
                "<ccpanes-launch-profile-skills>\n\
                 The current CC-Panes launch profile selected these session skills. \
                 Follow them when they are relevant to the user's request.\n",
            );
            for skill in profile_skills {
                prompt.push_str("\n## ");
                prompt.push_str(&skill.name);
                prompt.push('\n');
                if let Some(description) = skill
                    .description
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    prompt.push_str(description);
                    prompt.push_str("\n\n");
                }
                prompt.push_str(skill.content.trim());
                prompt.push('\n');
            }
            for user_skill in user_skills {
                prompt.push_str("\n## ");
                prompt.push_str(&user_skill.skill.name);
                prompt.push('\n');
                if let Some(description) = user_skill
                    .skill
                    .description
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    prompt.push_str(description);
                    prompt.push_str("\n\n");
                }
                prompt.push_str(user_skill.content.trim());
                prompt.push('\n');
            }
            prompt.push_str("</ccpanes-launch-profile-skills>");
        }
        if !allowed_skills.is_empty() {
            if !prompt.is_empty() {
                prompt.push_str("\n\n");
            }
            prompt.push_str("<allowed-skills>\n");
            prompt.push_str(
                "This session is limited to the following skills. Ignore any other skills that may be auto-loaded by the CLI.\n",
            );
            for skill in allowed_skills {
                prompt.push_str("- ");
                prompt.push_str(&skill.name);
                if let Some(description) = skill.description {
                    prompt.push_str(" (");
                    prompt.push_str(&description);
                    prompt.push(')');
                }
                prompt.push('\n');
            }
            prompt.push_str("</allowed-skills>");
        }
        Some(prompt)
    }

    pub fn resolve_profile(
        &self,
        request: &LaunchProfilePreviewRequest,
        workspaces: &[Workspace],
        providers: &[Provider],
        shared_mcp: &SharedMcpConfig,
        running_mcp_urls: &SharedMcpUrls,
    ) -> LaunchProfileResolution {
        let workspace = request
            .workspace_name
            .as_deref()
            .and_then(|name| workspaces.iter().find(|ws| ws.name == name));
        let profile_id = if request.use_system_default {
            None
        } else {
            request
                .profile_id
                .as_deref()
                .or_else(|| {
                    request.project_id.as_deref().and_then(|project_id| {
                        workspace.and_then(|ws| {
                            ws.projects
                                .iter()
                                .find(|project| project.id == project_id)
                                .and_then(|project| project.launch_profile_id.as_deref())
                        })
                    })
                })
                .or_else(|| workspace.and_then(|ws| ws.launch_profile_id.as_deref()))
        };
        let cli_tool = request.cli_tool.as_deref();
        let runtime_kind = request.runtime_kind.as_deref();
        let profile = if request.use_system_default {
            None
        } else {
            self.resolve_launch_profile(
                request.profile_id.as_deref(),
                workspace,
                request.project_id.as_deref(),
                cli_tool,
                runtime_kind,
            )
        };

        let mut warnings = Vec::new();
        if let Some(id) = profile_id {
            match self.selected_profile_compatibility(id, cli_tool, runtime_kind) {
                Some(true) if profile.as_ref().map(|p| p.id.as_str()) != Some(id) => {
                    warnings.push(format!("Launch profile '{}' was not selected", id));
                }
                Some(false) => warnings.push(format!(
                    "Launch profile '{}' is not compatible with {} in {}",
                    id,
                    cli_tool.unwrap_or("current CLI"),
                    runtime_kind.unwrap_or("current runtime")
                )),
                None => warnings.push(format!("Launch profile '{}' was not found", id)),
                _ => {}
            }
        }

        let requested_provider_id = request
            .provider_id
            .as_deref()
            .filter(|id| !id.trim().is_empty());
        let provider_id = match request.provider_selection {
            LaunchProviderSelection::None => None,
            LaunchProviderSelection::Explicit => requested_provider_id,
            LaunchProviderSelection::Inherit => {
                if request.use_system_default {
                    requested_provider_id
                } else {
                    requested_provider_id.or_else(|| {
                        profile
                            .as_ref()
                            .and_then(|profile| profile.provider_id.as_deref())
                    })
                }
            }
        }
        .map(str::to_string);
        let provider = provider_id
            .as_deref()
            .and_then(|id| providers.iter().find(|provider| provider.id == id));
        if provider_id.is_some() && provider.is_none() {
            warnings.push(format!(
                "Provider '{}' was not found",
                provider_id.as_deref().unwrap_or_default()
            ));
        }

        let mcp_servers = match profile.as_ref() {
            Some(profile) => Self::resolve_mcp(profile, shared_mcp, running_mcp_urls),
            None => Self::default_mcp(shared_mcp, running_mcp_urls),
        };
        let skills = match (profile.as_ref(), workspace) {
            (Some(profile), Some(workspace)) => {
                self.resolve_skills(profile, workspace, &mut warnings)
            }
            (Some(profile), None) => self.resolve_base_skills(profile, &mut warnings),
            (None, Some(workspace)) => Self::default_skills(workspace),
            (None, None) => core_skill_ids(),
        };

        LaunchProfileResolution {
            profile_id: profile.as_ref().map(|profile| profile.id.clone()),
            profile_name: if request.use_system_default {
                Some("System Default".to_string())
            } else {
                profile.as_ref().map(|profile| profile.name.clone())
            },
            profile_alias: if request.use_system_default {
                Some("系统默认配置".to_string())
            } else {
                profile.as_ref().map(|profile| {
                    profile
                        .alias
                        .clone()
                        .unwrap_or_else(|| profile.name.clone())
                })
            },
            provider_id: provider.map(|provider| provider.id.clone()).or(provider_id),
            provider_name: provider.map(|provider| provider.name.clone()),
            mcp_servers,
            skills,
            degraded: !warnings.is_empty(),
            warnings,
        }
    }

    pub fn resolve_shared_mcp_urls_for_profile(
        &self,
        profile_id: Option<&str>,
        workspace: Option<&Workspace>,
        cli_tool: Option<&str>,
        runtime_kind: Option<&str>,
        shared_urls: SharedMcpUrls,
    ) -> SharedMcpUrls {
        let Some(profile) =
            self.resolve_launch_profile(profile_id, workspace, None, cli_tool, runtime_kind)
        else {
            return shared_urls;
        };
        match profile.mcp_policy.mode {
            LaunchProfileMcpMode::Disabled => HashMap::new(),
            LaunchProfileMcpMode::Custom => {
                let allowed: HashSet<&str> = profile
                    .mcp_policy
                    .enabled_server_ids
                    .iter()
                    .map(String::as_str)
                    .collect();
                shared_urls
                    .into_iter()
                    .filter(|(name, _)| allowed.contains(name.as_str()))
                    .collect()
            }
            _ if !profile.mcp_policy.include_shared_mcp => HashMap::new(),
            _ => {
                let disabled: HashSet<&str> = profile
                    .mcp_policy
                    .disabled_server_ids
                    .iter()
                    .map(String::as_str)
                    .collect();
                shared_urls
                    .into_iter()
                    .filter(|(name, _)| !disabled.contains(name.as_str()))
                    .collect()
            }
        }
    }

    fn default_mcp(
        shared_mcp: &SharedMcpConfig,
        running: &SharedMcpUrls,
    ) -> Vec<ResolvedMcpServer> {
        let mut servers = vec![ResolvedMcpServer {
            id: "ccpanes".to_string(),
            name: "CC-Panes MCP".to_string(),
            source: "ccpanes".to_string(),
            enabled: true,
            url: None,
        }];
        for name in shared_mcp.servers.keys() {
            servers.push(ResolvedMcpServer {
                id: name.clone(),
                name: name.clone(),
                source: "shared".to_string(),
                enabled: running.contains_key(name),
                url: running.get(name).cloned(),
            });
        }
        servers
    }

    fn resolve_mcp(
        profile: &LaunchProfile,
        shared_mcp: &SharedMcpConfig,
        running: &SharedMcpUrls,
    ) -> Vec<ResolvedMcpServer> {
        if profile.mcp_policy.mode == LaunchProfileMcpMode::Disabled {
            return Vec::new();
        }

        let mut servers = Vec::new();
        if profile.mcp_policy.include_ccpanes_mcp {
            servers.push(ResolvedMcpServer {
                id: "ccpanes".to_string(),
                name: "CC-Panes MCP".to_string(),
                source: "ccpanes".to_string(),
                enabled: true,
                url: None,
            });
        }
        if !profile.mcp_policy.include_shared_mcp {
            return servers;
        }
        let enabled: HashSet<&str> = profile
            .mcp_policy
            .enabled_server_ids
            .iter()
            .map(String::as_str)
            .collect();
        let disabled: HashSet<&str> = profile
            .mcp_policy
            .disabled_server_ids
            .iter()
            .map(String::as_str)
            .collect();
        for name in shared_mcp.servers.keys() {
            let is_enabled = match profile.mcp_policy.mode {
                LaunchProfileMcpMode::Disabled => false,
                LaunchProfileMcpMode::Custom => enabled.contains(name.as_str()),
                LaunchProfileMcpMode::Default => !disabled.contains(name.as_str()),
            };
            servers.push(ResolvedMcpServer {
                id: name.clone(),
                name: name.clone(),
                source: "shared".to_string(),
                enabled: is_enabled && running.contains_key(name),
                url: running.get(name).cloned(),
            });
        }
        servers
    }

    fn resolve_base_skills(
        &self,
        profile: &LaunchProfile,
        warnings: &mut Vec<String>,
    ) -> Vec<ResolvedSkill> {
        match profile.skill_policy.mode {
            LaunchProfileSkillMode::Disabled => Vec::new(),
            LaunchProfileSkillMode::Core => {
                let disabled: HashSet<&str> = profile
                    .skill_policy
                    .disabled_skill_ids
                    .iter()
                    .map(String::as_str)
                    .collect();
                let mut skills = core_skill_ids()
                    .into_iter()
                    .filter(|skill| !disabled.contains(skill.id.as_str()))
                    .collect::<Vec<_>>();
                skills.extend(
                    Self::selected_profile_skills(profile)
                        .into_iter()
                        .map(|skill| ResolvedSkill {
                            id: format!("profile:{}", skill.id),
                            name: skill.name.clone(),
                            source: "profile".to_string(),
                            enabled: true,
                            project_id: None,
                            project_path: None,
                        }),
                );
                skills.extend(self.resolve_selected_user_skills(profile, warnings));
                skills.extend(self.resolve_external_skills(profile, warnings));
                skills
            }
            LaunchProfileSkillMode::Custom => {
                let selected: HashSet<&str> = profile
                    .skill_policy
                    .enabled_skill_ids
                    .iter()
                    .map(String::as_str)
                    .collect();
                let mut skills = profile
                    .skill_policy
                    .enabled_skill_ids
                    .iter()
                    .filter(|id| id.starts_with("builtin:"))
                    .map(|id| ResolvedSkill {
                        id: id.clone(),
                        name: id.trim_start_matches("builtin:").to_string(),
                        source: "builtin".to_string(),
                        enabled: true,
                        project_id: None,
                        project_path: None,
                    })
                    .collect::<Vec<_>>();
                skills.extend(
                    profile
                        .skill_policy
                        .profile_skills
                        .iter()
                        .filter_map(|skill| {
                            let id = format!("profile:{}", skill.id);
                            selected.contains(id.as_str()).then(|| ResolvedSkill {
                                id,
                                name: skill.name.clone(),
                                source: "profile".to_string(),
                                enabled: true,
                                project_id: None,
                                project_path: None,
                            })
                        }),
                );
                skills.extend(self.resolve_selected_user_skills(profile, warnings));
                skills.extend(self.resolve_external_skills(profile, warnings));
                skills
            }
        }
    }

    fn selected_profile_skills(
        profile: &LaunchProfile,
    ) -> Vec<&crate::models::launch_profile::LaunchProfileSkill> {
        match profile.skill_policy.mode {
            LaunchProfileSkillMode::Disabled => Vec::new(),
            LaunchProfileSkillMode::Core => {
                let disabled: HashSet<&str> = profile
                    .skill_policy
                    .disabled_skill_ids
                    .iter()
                    .map(String::as_str)
                    .collect();
                profile
                    .skill_policy
                    .profile_skills
                    .iter()
                    .filter(|skill| {
                        let id = format!("profile:{}", skill.id);
                        !disabled.contains(id.as_str())
                    })
                    .collect()
            }
            LaunchProfileSkillMode::Custom => {
                let selected: HashSet<&str> = profile
                    .skill_policy
                    .enabled_skill_ids
                    .iter()
                    .map(String::as_str)
                    .collect();
                profile
                    .skill_policy
                    .profile_skills
                    .iter()
                    .filter(|skill| {
                        let id = format!("profile:{}", skill.id);
                        selected.contains(id.as_str())
                    })
                    .collect()
            }
        }
    }

    fn selected_user_skill_ids(profile: &LaunchProfile) -> Vec<String> {
        if profile.skill_policy.mode == LaunchProfileSkillMode::Disabled {
            return Vec::new();
        }
        profile
            .skill_policy
            .enabled_skill_ids
            .iter()
            .filter_map(|id| id.strip_prefix("user:"))
            .filter(|id| !id.trim().is_empty())
            .map(str::to_string)
            .collect()
    }

    fn selected_user_skill_contents(&self, profile: &LaunchProfile) -> Vec<UserSkillContent> {
        Self::selected_user_skill_ids(profile)
            .into_iter()
            .filter_map(|id| {
                UserSkillService::read_from_dir(&self.user_skills_dir, &id)
                    .ok()
                    .flatten()
            })
            .collect()
    }

    fn resolve_selected_user_skills(
        &self,
        profile: &LaunchProfile,
        warnings: &mut Vec<String>,
    ) -> Vec<ResolvedSkill> {
        let mut skills = Vec::new();
        for id in Self::selected_user_skill_ids(profile) {
            match UserSkillService::read_from_dir(&self.user_skills_dir, &id) {
                Ok(Some(user_skill)) => skills.push(ResolvedSkill {
                    id: format!("user:{}", user_skill.skill.id),
                    name: user_skill.skill.name,
                    source: "user".to_string(),
                    enabled: true,
                    project_id: None,
                    project_path: None,
                }),
                Ok(None) => warnings.push(format!("User skill '{}' is not installed", id)),
                Err(error) => {
                    warnings.push(format!("User skill '{}' could not be read: {}", id, error))
                }
            }
        }
        skills
    }

    fn resolve_external_skills(
        &self,
        profile: &LaunchProfile,
        warnings: &mut Vec<String>,
    ) -> Vec<ResolvedSkill> {
        if profile.skill_policy.mode == LaunchProfileSkillMode::Disabled {
            return Vec::new();
        }

        let selected: HashSet<&str> = profile
            .skill_policy
            .enabled_skill_ids
            .iter()
            .map(String::as_str)
            .collect();
        let disabled: HashSet<&str> = profile
            .skill_policy
            .disabled_skill_ids
            .iter()
            .map(String::as_str)
            .collect();
        let discovered = match self.external_skill_registry.list() {
            Ok(skills) => skills,
            Err(error) => {
                warnings.push(format!("External skills could not be scanned: {}", error));
                return Vec::new();
            }
        };
        let discovered_ids = discovered
            .iter()
            .map(|skill| skill.id.clone())
            .collect::<HashSet<_>>();

        let mut skills = Vec::new();
        for skill in discovered {
            if !Self::external_source_enabled(profile, &skill.source) {
                continue;
            }
            let enabled = match profile.skill_policy.mode {
                LaunchProfileSkillMode::Disabled => false,
                LaunchProfileSkillMode::Core => !disabled.contains(skill.id.as_str()),
                LaunchProfileSkillMode::Custom => selected.contains(skill.id.as_str()),
            };
            if enabled {
                skills.push(ResolvedSkill {
                    id: skill.id,
                    name: skill.name,
                    source: skill.source.resolved_source().to_string(),
                    enabled: true,
                    project_id: None,
                    project_path: None,
                });
            }
        }

        if profile.skill_policy.mode == LaunchProfileSkillMode::Custom {
            for id in selected {
                if Self::is_external_skill_id(id)
                    && Self::external_id_source_enabled(profile, id)
                    && !discovered_ids.contains(id)
                {
                    warnings.push(format!("External skill '{}' is not installed", id));
                }
            }
        }

        skills
    }

    fn allowed_skill_entries(&self, profile: &LaunchProfile) -> Vec<AllowedSkillEntry> {
        if profile.skill_policy.mode != LaunchProfileSkillMode::Custom
            || profile.skill_policy.enabled_skill_ids.is_empty()
        {
            return Vec::new();
        }

        profile
            .skill_policy
            .enabled_skill_ids
            .iter()
            .filter_map(|id| self.allowed_skill_entry(profile, id))
            .collect()
    }

    fn allowed_skill_entry(&self, profile: &LaunchProfile, id: &str) -> Option<AllowedSkillEntry> {
        if let Some(name) = id.strip_prefix("builtin:") {
            return Some(AllowedSkillEntry::new(
                name,
                Some("CC-Panes built-in skill"),
            ));
        }
        if let Some(profile_id) = id.strip_prefix("profile:") {
            let skill = profile
                .skill_policy
                .profile_skills
                .iter()
                .find(|skill| skill.id == profile_id)?;
            return Some(AllowedSkillEntry::new(
                &skill.name,
                skill.description.as_deref(),
            ));
        }
        if let Some(user_id) = id.strip_prefix("user:") {
            let user_skill = UserSkillService::read_from_dir(&self.user_skills_dir, user_id)
                .ok()
                .flatten()?;
            return Some(AllowedSkillEntry::new(
                &user_skill.skill.name,
                user_skill.skill.description.as_deref(),
            ));
        }
        if id.starts_with("project:") {
            let name = id.rsplit(':').next().unwrap_or(id);
            return Some(AllowedSkillEntry::new(name, Some("Project command skill")));
        }
        if Self::is_external_skill_id(id) && Self::external_id_source_enabled(profile, id) {
            let skill = self.external_skill_registry.get(id).ok().flatten()?;
            return Some(AllowedSkillEntry::new(
                &skill.name,
                skill.description.as_deref(),
            ));
        }
        None
    }

    fn external_source_enabled(profile: &LaunchProfile, source: &ExternalSkillSource) -> bool {
        match source {
            ExternalSkillSource::Claude => profile.skill_policy.include_external_claude_skills,
            ExternalSkillSource::Codex => profile.skill_policy.include_external_codex_skills,
            ExternalSkillSource::Plugin { .. } => {
                profile.skill_policy.include_external_plugin_skills
            }
        }
    }

    fn external_id_source_enabled(profile: &LaunchProfile, id: &str) -> bool {
        if id.starts_with("claude:") {
            profile.skill_policy.include_external_claude_skills
        } else if id.starts_with("codex:") {
            profile.skill_policy.include_external_codex_skills
        } else if id.starts_with("plugin:") {
            profile.skill_policy.include_external_plugin_skills
        } else {
            false
        }
    }

    fn is_external_skill_id(id: &str) -> bool {
        id.starts_with("claude:") || id.starts_with("codex:") || id.starts_with("plugin:")
    }

    fn default_skills(workspace: &Workspace) -> Vec<ResolvedSkill> {
        let _ = workspace;
        core_skill_ids()
    }

    fn resolve_skills(
        &self,
        profile: &LaunchProfile,
        workspace: &Workspace,
        warnings: &mut Vec<String>,
    ) -> Vec<ResolvedSkill> {
        let mut skills = self.resolve_base_skills(profile, warnings);
        if profile.skill_policy.mode == LaunchProfileSkillMode::Disabled {
            return skills;
        }
        if !profile.skill_policy.include_project_skills {
            return skills;
        }
        let selected: HashSet<&str> = profile
            .skill_policy
            .enabled_skill_ids
            .iter()
            .map(String::as_str)
            .collect();
        for project in &workspace.projects {
            let commands_dir = Path::new(&project.path).join(".claude").join("commands");
            let Ok(entries) = std::fs::read_dir(commands_dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
                    continue;
                }
                let Some(name) = path.file_stem().and_then(|stem| stem.to_str()) else {
                    continue;
                };
                let id = format!("project:{}:{}", project.id, name);
                if profile.skill_policy.mode == LaunchProfileSkillMode::Custom
                    && !selected.contains(id.as_str())
                {
                    continue;
                }
                skills.push(ResolvedSkill {
                    id,
                    name: name.to_string(),
                    source: "project".to_string(),
                    enabled: true,
                    project_id: Some(project.id.clone()),
                    project_path: Some(project.path.clone()),
                });
            }
        }
        skills
    }
}

struct AllowedSkillEntry {
    name: String,
    description: Option<String>,
}

impl AllowedSkillEntry {
    fn new(name: &str, description: Option<&str>) -> Self {
        Self {
            name: compact_prompt_line(name),
            description: description.map(compact_prompt_line),
        }
    }
}

fn compact_prompt_line(value: &str) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.chars().take(160).collect()
}

fn default_external_skill_registry() -> Arc<ExternalSkillRegistry> {
    let mut registry = cc_cli_adapters::CliToolRegistry::new();
    registry.register(Arc::new(cc_cli_adapters::ClaudeAdapter::new()));
    registry.register(Arc::new(cc_cli_adapters::CodexAdapter::new()));
    Arc::new(ExternalSkillRegistry::new(Arc::new(registry)))
}

fn core_skill_ids() -> Vec<ResolvedSkill> {
    // 默认 core 仅保留高频 4 个；其他 skill 仍会发布到磁盘，
    // 用户可在 UI 切到 `mode=custom` 手动启用。
    [
        "ccpanes-launch-task",
        "ccpanes-dispatch-todos",
        "ccpanes-browse-sessions",
        "ccpanes-memory-dual-write",
    ]
    .into_iter()
    .map(|name| ResolvedSkill {
        id: format!("builtin:{}", name),
        name: name.to_string(),
        source: "builtin".to_string(),
        enabled: true,
        project_id: None,
        project_path: None,
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::launch_profile::LaunchProviderSelection;
    use crate::models::provider::ProviderType;
    use crate::models::shared_mcp::SharedMcpConfig;

    fn provider(id: &str) -> Provider {
        Provider {
            id: id.to_string(),
            name: id.to_string(),
            provider_type: ProviderType::Anthropic,
            api_key: None,
            base_url: None,
            region: None,
            project_id: None,
            aws_profile: None,
            config_dir: None,
            is_default: false,
        }
    }

    fn test_service() -> LaunchProfileService {
        test_service_with_external_roots(Vec::new(), None)
    }

    fn test_service_with_external_roots(
        skill_roots: Vec<(String, PathBuf)>,
        plugins_root: Option<PathBuf>,
    ) -> LaunchProfileService {
        let dir = std::env::temp_dir().join(format!(
            "cc-panes-launch-profile-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("launch-profiles.json");
        let plugins_root = plugins_root.unwrap_or_else(|| dir.join("plugins"));
        let external_skill_registry = Arc::new(ExternalSkillRegistry::with_roots_for_test(
            skill_roots,
            plugins_root,
        ));
        LaunchProfileService::new_with_external_skill_registry(path, external_skill_registry)
    }

    fn write_external_skill(root: &Path, id: &str, content: &str) {
        let dir = root.join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), content).unwrap();
    }

    fn workspace(profile_id: &str) -> Workspace {
        let mut workspace = Workspace::new("workspace".to_string(), Some("/tmp/workspace".into()));
        workspace.provider_id = Some("workspace-provider".into());
        workspace.launch_profile_id = Some(profile_id.into());
        workspace
    }

    fn shared_mcp_config() -> SharedMcpConfig {
        let mut config = SharedMcpConfig::default();
        config.servers.insert(
            "context7".into(),
            crate::models::shared_mcp::SharedMcpServerConfig {
                command: "npx".into(),
                args: vec!["-y".into(), "@upstash/context7-mcp".into()],
                env: HashMap::new(),
                shared: true,
                port: 3100,
                bridge_mode: Default::default(),
            },
        );
        config
    }

    #[test]
    fn resolve_profile_prefers_explicit_provider_over_profile_provider() {
        let service = test_service();
        let profile = service
            .create_profile(LaunchProfileDraft {
                name: Some("Profile".into()),
                alias: None,
                description: None,
                provider_id: Some("profile-provider".into()),
                adapter_options: Default::default(),
                target_tools: Vec::new(),
                target_runtime: None,
                yolo_mode: false,
                mcp_policy: Default::default(),
                skill_policy: Default::default(),
                is_default: false,
            })
            .unwrap();
        let workspace = workspace(&profile.id);
        let providers = vec![
            provider("explicit-provider"),
            provider("profile-provider"),
            provider("workspace-provider"),
        ];
        let request = LaunchProfilePreviewRequest {
            profile_id: Some(profile.id),
            use_system_default: false,
            workspace_name: Some(workspace.name.clone()),
            project_id: None,
            provider_id: Some("explicit-provider".into()),
            provider_selection: LaunchProviderSelection::Inherit,
            cli_tool: None,
            runtime_kind: None,
        };

        let resolution = service.resolve_profile(
            &request,
            &[workspace],
            &providers,
            &SharedMcpConfig::default(),
            &HashMap::new(),
        );

        assert_eq!(resolution.provider_id.as_deref(), Some("explicit-provider"));
        assert!(!resolution.degraded);
    }

    fn mk_profile(
        service: &LaunchProfileService,
        name: &str,
        tools: &[&str],
        runtime: Option<&str>,
        yolo: bool,
        is_default: bool,
    ) -> LaunchProfile {
        service
            .create_profile(LaunchProfileDraft {
                name: Some(name.into()),
                alias: None,
                description: None,
                provider_id: None,
                adapter_options: Default::default(),
                target_tools: tools.iter().map(|tool| tool.to_string()).collect(),
                target_runtime: runtime.map(str::to_string),
                yolo_mode: yolo,
                mcp_policy: Default::default(),
                skill_policy: Default::default(),
                is_default,
            })
            .unwrap()
    }

    #[test]
    fn diagnostic_none_when_explicit_profile_matches_cli() {
        let service = test_service();
        let codex = mk_profile(&service, "Codex YOLO", &["codex"], None, true, false);
        let (resolved, diag) = service.resolve_launch_profile_with_diagnostic(
            Some(&codex.id),
            None,
            None,
            Some("codex"),
            Some("local"),
        );
        assert_eq!(
            resolved.as_ref().map(|profile| profile.yolo_mode),
            Some(true)
        );
        assert!(diag.is_none());
    }

    #[test]
    fn diagnostic_flags_cli_mismatch_and_yolo_not_applied() {
        let service = test_service();
        // 用户在 codex-only 的 profile 上开了 YOLO
        let codex_yolo = mk_profile(&service, "Codex YOLO", &["codex"], None, true, false);
        // 存在一个 claude 默认（无 YOLO）供回落
        mk_profile(&service, "Claude Default", &["claude"], None, false, true);
        // 显式选中 codex-yolo，但本次启动的是 claude
        let (resolved, diag) = service.resolve_launch_profile_with_diagnostic(
            Some(&codex_yolo.id),
            None,
            None,
            Some("claude"),
            Some("local"),
        );
        // 关键：静默回落到 claude 默认 → YOLO 未生效
        assert_eq!(
            resolved.as_ref().map(|profile| profile.yolo_mode),
            Some(false)
        );
        let diag = diag.expect("显式 profile 因 CLI 不匹配被丢弃时应给出诊断");
        assert!(diag.cli_mismatch);
        assert!(!diag.runtime_mismatch);
        assert_eq!(diag.requested_profile_id, codex_yolo.id);
        assert_eq!(diag.used_profile_name.as_deref(), Some("Claude Default"));
    }

    #[test]
    fn diagnostic_flags_runtime_mismatch() {
        let service = test_service();
        let local_only = mk_profile(
            &service,
            "Codex Local",
            &["codex"],
            Some("local"),
            true,
            false,
        );
        let (_resolved, diag) = service.resolve_launch_profile_with_diagnostic(
            Some(&local_only.id),
            None,
            None,
            Some("codex"),
            Some("wsl"),
        );
        let diag = diag.expect("显式 profile 因 runtime 不匹配被丢弃时应给出诊断");
        assert!(diag.runtime_mismatch);
        assert!(!diag.cli_mismatch);
    }

    #[test]
    fn diagnostic_none_without_explicit_selection() {
        let service = test_service();
        // 只有默认、无显式选择：即便走默认回落也不应打扰用户
        mk_profile(&service, "Claude Default", &["claude"], None, false, true);
        let (_resolved, diag) = service.resolve_launch_profile_with_diagnostic(
            None,
            None,
            None,
            Some("claude"),
            Some("local"),
        );
        assert!(diag.is_none());
    }

    #[test]
    fn per_cli_defaults_apply_yolo_independently() {
        // 印证用户想要的用法：codex 默认开 YOLO、claude 默认关，各自独立生效、互不干扰。
        let service = test_service();
        mk_profile(&service, "Codex Default", &["codex"], None, true, true);
        mk_profile(&service, "Claude Default", &["claude"], None, false, true);
        let (codex_res, codex_diag) = service.resolve_launch_profile_with_diagnostic(
            None,
            None,
            None,
            Some("codex"),
            Some("local"),
        );
        let (claude_res, claude_diag) = service.resolve_launch_profile_with_diagnostic(
            None,
            None,
            None,
            Some("claude"),
            Some("local"),
        );
        assert_eq!(codex_res.map(|profile| profile.yolo_mode), Some(true));
        assert_eq!(claude_res.map(|profile| profile.yolo_mode), Some(false));
        assert!(codex_diag.is_none() && claude_diag.is_none());
    }

    #[test]
    fn resolve_profile_none_selection_skips_all_provider_fallbacks() {
        let service = test_service();
        let profile = service
            .create_profile(LaunchProfileDraft {
                name: Some("Profile".into()),
                alias: None,
                description: None,
                provider_id: Some("profile-provider".into()),
                adapter_options: Default::default(),
                target_tools: Vec::new(),
                target_runtime: None,
                yolo_mode: false,
                mcp_policy: Default::default(),
                skill_policy: Default::default(),
                is_default: false,
            })
            .unwrap();
        let workspace = workspace(&profile.id);
        let request = LaunchProfilePreviewRequest {
            profile_id: Some(profile.id),
            use_system_default: false,
            workspace_name: Some(workspace.name.clone()),
            project_id: None,
            provider_id: Some("explicit-provider".into()),
            provider_selection: LaunchProviderSelection::None,
            cli_tool: None,
            runtime_kind: None,
        };

        let resolution = service.resolve_profile(
            &request,
            &[workspace],
            &[provider("explicit-provider"), provider("profile-provider")],
            &SharedMcpConfig::default(),
            &HashMap::new(),
        );

        assert_eq!(resolution.provider_id, None);
        assert_eq!(resolution.provider_name, None);
        assert!(!resolution.degraded);
    }

    #[test]
    fn resolve_profile_system_default_ignores_custom_default_profile() {
        let service = test_service();
        service
            .create_profile(LaunchProfileDraft {
                name: Some("Custom Default".into()),
                alias: None,
                description: None,
                provider_id: Some("profile-provider".into()),
                adapter_options: Default::default(),
                target_tools: Vec::new(),
                target_runtime: None,
                yolo_mode: false,
                mcp_policy: Default::default(),
                skill_policy: Default::default(),
                is_default: true,
            })
            .unwrap();
        let mut workspace = Workspace::new("workspace".to_string(), Some("/tmp/workspace".into()));
        workspace.provider_id = Some("workspace-provider".into());
        let request = LaunchProfilePreviewRequest {
            profile_id: None,
            use_system_default: true,
            workspace_name: Some(workspace.name.clone()),
            project_id: None,
            provider_id: None,
            provider_selection: LaunchProviderSelection::Inherit,
            cli_tool: None,
            runtime_kind: None,
        };

        let resolution = service.resolve_profile(
            &request,
            &[workspace],
            &[provider("profile-provider"), provider("workspace-provider")],
            &SharedMcpConfig::default(),
            &HashMap::new(),
        );

        assert_eq!(resolution.profile_id, None);
        assert_eq!(resolution.profile_name.as_deref(), Some("System Default"));
        assert_eq!(resolution.provider_id, None);
        assert!(!resolution.degraded);
    }

    #[test]
    fn resolve_profile_without_matching_profile_does_not_inherit_workspace_provider() {
        let service = test_service();
        let mut workspace = Workspace::new("workspace".to_string(), Some("/tmp/workspace".into()));
        workspace.provider_id = Some("workspace-provider".into());
        let request = LaunchProfilePreviewRequest {
            profile_id: None,
            use_system_default: false,
            workspace_name: Some(workspace.name.clone()),
            project_id: None,
            provider_id: None,
            provider_selection: LaunchProviderSelection::Inherit,
            cli_tool: Some("codex".into()),
            runtime_kind: Some("local".into()),
        };

        let resolution = service.resolve_profile(
            &request,
            &[workspace],
            &[provider("workspace-provider")],
            &SharedMcpConfig::default(),
            &HashMap::new(),
        );

        assert_eq!(resolution.profile_id, None);
        assert_eq!(resolution.provider_id, None);
        assert_eq!(resolution.provider_name, None);
        assert!(!resolution.degraded);
    }

    #[test]
    fn resolve_profile_system_default_without_workspace_includes_core_skills() {
        let service = test_service();
        let request = LaunchProfilePreviewRequest {
            profile_id: None,
            use_system_default: true,
            workspace_name: None,
            project_id: None,
            provider_id: None,
            provider_selection: LaunchProviderSelection::Inherit,
            cli_tool: Some("codex".into()),
            runtime_kind: None,
        };

        let resolution = service.resolve_profile(
            &request,
            &[],
            &[],
            &SharedMcpConfig::default(),
            &HashMap::new(),
        );

        assert!(resolution
            .skills
            .iter()
            .any(|skill| skill.id == "builtin:ccpanes-launch-task"));
        assert!(resolution
            .skills
            .iter()
            .any(|skill| skill.id == "builtin:ccpanes-memory-dual-write"));
        // 默认 core 已瘦身，不再包含 workspace
        assert!(!resolution
            .skills
            .iter()
            .any(|skill| skill.id == "builtin:ccpanes-workspace"));
        assert!(!resolution.skills.is_empty());
    }

    #[test]
    fn resolve_profile_picks_default_for_requested_cli_tool() {
        let service = test_service();
        service
            .create_profile(LaunchProfileDraft {
                name: Some("Claude Default".into()),
                alias: None,
                description: None,
                provider_id: Some("claude-provider".into()),
                adapter_options: Default::default(),
                target_tools: vec!["claude".into()],
                target_runtime: None,
                yolo_mode: false,
                mcp_policy: Default::default(),
                skill_policy: Default::default(),
                is_default: true,
            })
            .unwrap();
        service
            .create_profile(LaunchProfileDraft {
                name: Some("Codex Default".into()),
                alias: None,
                description: None,
                provider_id: Some("codex-provider".into()),
                adapter_options: Default::default(),
                target_tools: vec!["codex".into()],
                target_runtime: None,
                yolo_mode: false,
                mcp_policy: Default::default(),
                skill_policy: Default::default(),
                is_default: true,
            })
            .unwrap();
        let providers = vec![provider("claude-provider"), provider("codex-provider")];

        let codex_resolution = service.resolve_profile(
            &LaunchProfilePreviewRequest {
                profile_id: None,
                use_system_default: false,
                workspace_name: None,
                project_id: None,
                provider_id: None,
                provider_selection: LaunchProviderSelection::Inherit,
                cli_tool: Some("codex".into()),
                runtime_kind: None,
            },
            &[],
            &providers,
            &SharedMcpConfig::default(),
            &HashMap::new(),
        );
        let claude_resolution = service.resolve_profile(
            &LaunchProfilePreviewRequest {
                profile_id: None,
                use_system_default: false,
                workspace_name: None,
                project_id: None,
                provider_id: None,
                provider_selection: LaunchProviderSelection::Inherit,
                cli_tool: Some("claude".into()),
                runtime_kind: None,
            },
            &[],
            &providers,
            &SharedMcpConfig::default(),
            &HashMap::new(),
        );

        assert_eq!(
            codex_resolution.provider_id.as_deref(),
            Some("codex-provider")
        );
        assert_eq!(
            claude_resolution.provider_id.as_deref(),
            Some("claude-provider")
        );
        assert_eq!(
            service
                .list_profiles()
                .iter()
                .filter(|profile| profile.is_default)
                .count(),
            2
        );
    }

    #[test]
    fn resolve_profile_picks_default_for_requested_runtime() {
        let service = test_service();
        service
            .create_profile(LaunchProfileDraft {
                name: Some("Codex Local Default".into()),
                alias: None,
                description: None,
                provider_id: Some("codex-local-provider".into()),
                adapter_options: Default::default(),
                target_tools: vec!["codex".into()],
                target_runtime: Some("local".into()),
                yolo_mode: true,
                mcp_policy: Default::default(),
                skill_policy: Default::default(),
                is_default: true,
            })
            .unwrap();
        service
            .create_profile(LaunchProfileDraft {
                name: Some("Codex WSL Default".into()),
                alias: None,
                description: None,
                provider_id: Some("codex-wsl-provider".into()),
                adapter_options: Default::default(),
                target_tools: vec!["codex".into()],
                target_runtime: Some("wsl".into()),
                yolo_mode: false,
                mcp_policy: Default::default(),
                skill_policy: Default::default(),
                is_default: true,
            })
            .unwrap();
        let providers = vec![
            provider("codex-local-provider"),
            provider("codex-wsl-provider"),
        ];

        let local_resolution = service.resolve_profile(
            &LaunchProfilePreviewRequest {
                profile_id: None,
                use_system_default: false,
                workspace_name: None,
                project_id: None,
                provider_id: None,
                provider_selection: LaunchProviderSelection::Inherit,
                cli_tool: Some("codex".into()),
                runtime_kind: Some("local".into()),
            },
            &[],
            &providers,
            &SharedMcpConfig::default(),
            &HashMap::new(),
        );
        let wsl_resolution = service.resolve_profile(
            &LaunchProfilePreviewRequest {
                profile_id: None,
                use_system_default: false,
                workspace_name: None,
                project_id: None,
                provider_id: None,
                provider_selection: LaunchProviderSelection::Inherit,
                cli_tool: Some("codex".into()),
                runtime_kind: Some("wsl".into()),
            },
            &[],
            &providers,
            &SharedMcpConfig::default(),
            &HashMap::new(),
        );

        assert_eq!(
            local_resolution.provider_id.as_deref(),
            Some("codex-local-provider")
        );
        assert!(service
            .list_profiles()
            .iter()
            .any(|profile| profile.name == "Codex Local Default" && profile.yolo_mode));
        assert_eq!(
            wsl_resolution.provider_id.as_deref(),
            Some("codex-wsl-provider")
        );
        assert_eq!(
            service
                .list_profiles()
                .iter()
                .filter(|profile| profile.is_default)
                .count(),
            2
        );
    }

    #[test]
    fn resolve_profile_ignores_workspace_profile_when_cli_tool_does_not_match() {
        let service = test_service();
        let claude_profile = service
            .create_profile(LaunchProfileDraft {
                name: Some("Claude Workspace".into()),
                alias: None,
                description: None,
                provider_id: Some("claude-provider".into()),
                adapter_options: Default::default(),
                target_tools: vec!["claude".into()],
                target_runtime: None,
                yolo_mode: false,
                mcp_policy: Default::default(),
                skill_policy: Default::default(),
                is_default: false,
            })
            .unwrap();
        service
            .create_profile(LaunchProfileDraft {
                name: Some("Codex Default".into()),
                alias: None,
                description: None,
                provider_id: Some("codex-provider".into()),
                adapter_options: Default::default(),
                target_tools: vec!["codex".into()],
                target_runtime: None,
                yolo_mode: false,
                mcp_policy: Default::default(),
                skill_policy: Default::default(),
                is_default: true,
            })
            .unwrap();
        let workspace = workspace(&claude_profile.id);

        let resolution = service.resolve_profile(
            &LaunchProfilePreviewRequest {
                profile_id: None,
                use_system_default: false,
                workspace_name: Some(workspace.name.clone()),
                project_id: None,
                provider_id: None,
                provider_selection: LaunchProviderSelection::Inherit,
                cli_tool: Some("codex".into()),
                runtime_kind: None,
            },
            &[workspace],
            &[provider("claude-provider"), provider("codex-provider")],
            &SharedMcpConfig::default(),
            &HashMap::new(),
        );

        assert_eq!(resolution.provider_id.as_deref(), Some("codex-provider"));
        assert!(resolution.degraded);
        assert!(resolution
            .warnings
            .iter()
            .any(|warning| warning.contains("not compatible with codex")));
    }

    #[test]
    fn disabled_mcp_policy_does_not_resolve_or_inject_shared_mcp() {
        let service = test_service();
        let profile = service
            .create_profile(LaunchProfileDraft {
                name: Some("No MCP".into()),
                alias: None,
                description: None,
                provider_id: None,
                adapter_options: Default::default(),
                target_tools: vec!["codex".into()],
                target_runtime: None,
                yolo_mode: false,
                mcp_policy: crate::models::launch_profile::LaunchProfileMcpPolicy {
                    mode: LaunchProfileMcpMode::Disabled,
                    ..Default::default()
                },
                skill_policy: Default::default(),
                is_default: false,
            })
            .unwrap();
        let shared_config = shared_mcp_config();
        let running = HashMap::from([(
            "context7".to_string(),
            "http://127.0.0.1:3100/mcp".to_string(),
        )]);

        let resolution = service.resolve_profile(
            &LaunchProfilePreviewRequest {
                profile_id: Some(profile.id.clone()),
                use_system_default: false,
                workspace_name: None,
                project_id: None,
                provider_id: None,
                provider_selection: LaunchProviderSelection::Inherit,
                cli_tool: Some("codex".into()),
                runtime_kind: None,
            },
            &[],
            &[],
            &shared_config,
            &running,
        );
        let injected = service.resolve_shared_mcp_urls_for_profile(
            Some(&profile.id),
            None,
            Some("codex"),
            None,
            running,
        );

        assert!(resolution.mcp_servers.is_empty());
        assert!(injected.is_empty());
    }

    #[test]
    fn core_skill_policy_respects_disabled_builtin_ids() {
        let service = test_service();
        let profile = service
            .create_profile(LaunchProfileDraft {
                name: Some("Core minus one".into()),
                alias: None,
                description: None,
                provider_id: None,
                adapter_options: Default::default(),
                target_tools: vec!["codex".into()],
                target_runtime: None,
                yolo_mode: false,
                mcp_policy: Default::default(),
                skill_policy: crate::models::launch_profile::LaunchProfileSkillPolicy {
                    mode: LaunchProfileSkillMode::Core,
                    disabled_skill_ids: vec!["builtin:ccpanes-launch-task".into()],
                    ..Default::default()
                },
                is_default: false,
            })
            .unwrap();

        let resolution = service.resolve_profile(
            &LaunchProfilePreviewRequest {
                profile_id: Some(profile.id),
                use_system_default: false,
                workspace_name: None,
                project_id: None,
                provider_id: None,
                provider_selection: LaunchProviderSelection::Inherit,
                cli_tool: Some("codex".into()),
                runtime_kind: None,
            },
            &[],
            &[],
            &SharedMcpConfig::default(),
            &HashMap::new(),
        );

        assert!(!resolution
            .skills
            .iter()
            .any(|skill| skill.id == "builtin:ccpanes-launch-task"));
        // workspace 已移出默认 core，断言为不存在
        assert!(!resolution
            .skills
            .iter()
            .any(|skill| skill.id == "builtin:ccpanes-workspace"));
        // 其他默认 core skill 仍然存在
        assert!(resolution
            .skills
            .iter()
            .any(|skill| skill.id == "builtin:ccpanes-memory-dual-write"));
    }

    #[test]
    fn profile_skill_policy_resolves_and_builds_session_prompt() {
        let service = test_service();
        let profile = service
            .create_profile(LaunchProfileDraft {
                name: Some("Profile Skill".into()),
                alias: None,
                description: None,
                provider_id: None,
                adapter_options: Default::default(),
                target_tools: vec!["codex".into()],
                target_runtime: None,
                yolo_mode: false,
                mcp_policy: Default::default(),
                skill_policy: crate::models::launch_profile::LaunchProfileSkillPolicy {
                    mode: LaunchProfileSkillMode::Custom,
                    enabled_skill_ids: vec!["profile:review-guard".into()],
                    profile_skills: vec![crate::models::launch_profile::LaunchProfileSkill {
                        id: "review-guard".into(),
                        name: "Review Guard".into(),
                        description: Some("Check risky changes first".into()),
                        content: "Prioritize regressions and missing tests.".into(),
                    }],
                    ..Default::default()
                },
                is_default: false,
            })
            .unwrap();

        let resolution = service.resolve_profile(
            &LaunchProfilePreviewRequest {
                profile_id: Some(profile.id.clone()),
                use_system_default: false,
                workspace_name: None,
                project_id: None,
                provider_id: None,
                provider_selection: LaunchProviderSelection::Inherit,
                cli_tool: Some("codex".into()),
                runtime_kind: None,
            },
            &[],
            &[],
            &SharedMcpConfig::default(),
            &HashMap::new(),
        );
        let prompt = service
            .session_skill_prompt_for_profile(Some(&profile))
            .expect("profile skill prompt");

        assert!(resolution.skills.iter().any(|skill| {
            skill.id == "profile:review-guard" && skill.source == "profile" && skill.enabled
        }));
        assert!(prompt.contains("<ccpanes-launch-profile-skills>"));
        assert!(prompt.contains("Review Guard"));
        assert!(prompt.contains("Prioritize regressions and missing tests."));
    }

    #[test]
    fn selected_user_skill_resolves_and_injects_session_prompt() {
        let service = test_service();
        let user_skill_service = UserSkillService::new(service.user_skills_dir.clone());
        user_skill_service
            .write_skill(
                &crate::services::InstalledUserSkill {
                    id: "frontend-design".into(),
                    name: "frontend-design".into(),
                    description: Some("Improve frontend hierarchy".into()),
                    category: Some("design-visual".into()),
                    tags: vec!["design".into()],
                    version: "1.0.0".into(),
                    license: Some("MIT".into()),
                    homepage_url: None,
                    source_url: Some("https://example.com/frontend-design.md".into()),
                    content_sha256: "sha".into(),
                    installed_at: "2026-05-12T00:00:00Z".into(),
                    file_path: None,
                },
                "Use layout, spacing, and typography deliberately.",
            )
            .unwrap();

        let profile = service
            .create_profile(LaunchProfileDraft {
                name: Some("Design Skills".into()),
                alias: None,
                description: None,
                provider_id: None,
                adapter_options: Default::default(),
                target_tools: vec!["codex".into()],
                target_runtime: None,
                yolo_mode: false,
                mcp_policy: Default::default(),
                skill_policy: crate::models::launch_profile::LaunchProfileSkillPolicy {
                    mode: LaunchProfileSkillMode::Custom,
                    enabled_skill_ids: vec!["user:frontend-design".into()],
                    ..Default::default()
                },
                is_default: false,
            })
            .unwrap();

        let resolution = service.resolve_profile(
            &LaunchProfilePreviewRequest {
                profile_id: Some(profile.id.clone()),
                use_system_default: false,
                workspace_name: None,
                project_id: None,
                provider_id: None,
                provider_selection: LaunchProviderSelection::Inherit,
                cli_tool: Some("codex".into()),
                runtime_kind: None,
            },
            &[],
            &[],
            &SharedMcpConfig::default(),
            &HashMap::new(),
        );
        let prompt = service
            .session_skill_prompt_for_profile(Some(&profile))
            .expect("user skill prompt");

        assert!(resolution.skills.iter().any(|skill| {
            skill.id == "user:frontend-design" && skill.source == "user" && skill.enabled
        }));
        assert!(prompt.contains("frontend-design"));
        assert!(prompt.contains("Use layout, spacing, and typography deliberately."));
    }

    #[test]
    fn include_external_claude_skills_false_excludes_claude_skills() {
        let temp = tempfile::tempdir().unwrap();
        let claude_root = temp.path().join("claude").join("skills");
        write_external_skill(
            &claude_root,
            "rust-patterns",
            "---\nname: Rust Patterns\n---\nUse Rust.",
        );
        let service = test_service_with_external_roots(
            vec![("claude".to_string(), claude_root)],
            Some(temp.path().join("plugins")),
        );
        let profile = service
            .create_profile(LaunchProfileDraft {
                name: Some("No Claude Skills".into()),
                alias: None,
                description: None,
                provider_id: None,
                adapter_options: Default::default(),
                target_tools: vec!["claude".into()],
                target_runtime: None,
                yolo_mode: false,
                mcp_policy: Default::default(),
                skill_policy: crate::models::launch_profile::LaunchProfileSkillPolicy {
                    include_external_claude_skills: false,
                    ..Default::default()
                },
                is_default: false,
            })
            .unwrap();

        let resolution = service.resolve_profile(
            &LaunchProfilePreviewRequest {
                profile_id: Some(profile.id),
                use_system_default: false,
                workspace_name: None,
                project_id: None,
                provider_id: None,
                provider_selection: LaunchProviderSelection::Inherit,
                cli_tool: Some("claude".into()),
                runtime_kind: None,
            },
            &[],
            &[],
            &SharedMcpConfig::default(),
            &HashMap::new(),
        );

        assert!(!resolution
            .skills
            .iter()
            .any(|skill| skill.id == "claude:rust-patterns"));
    }

    #[test]
    fn custom_policy_only_resolves_selected_external_skill() {
        let temp = tempfile::tempdir().unwrap();
        let claude_root = temp.path().join("claude").join("skills");
        write_external_skill(&claude_root, "rust-patterns", "# Rust Patterns");
        write_external_skill(&claude_root, "frontend-ui", "# Frontend UI");
        let service = test_service_with_external_roots(
            vec![("claude".to_string(), claude_root)],
            Some(temp.path().join("plugins")),
        );
        let profile = service
            .create_profile(LaunchProfileDraft {
                name: Some("Selected External".into()),
                alias: None,
                description: None,
                provider_id: None,
                adapter_options: Default::default(),
                target_tools: vec!["claude".into()],
                target_runtime: None,
                yolo_mode: false,
                mcp_policy: Default::default(),
                skill_policy: crate::models::launch_profile::LaunchProfileSkillPolicy {
                    mode: LaunchProfileSkillMode::Custom,
                    enabled_skill_ids: vec!["claude:rust-patterns".into()],
                    ..Default::default()
                },
                is_default: false,
            })
            .unwrap();

        let resolution = service.resolve_profile(
            &LaunchProfilePreviewRequest {
                profile_id: Some(profile.id),
                use_system_default: false,
                workspace_name: None,
                project_id: None,
                provider_id: None,
                provider_selection: LaunchProviderSelection::Inherit,
                cli_tool: Some("claude".into()),
                runtime_kind: None,
            },
            &[],
            &[],
            &SharedMcpConfig::default(),
            &HashMap::new(),
        );

        assert!(resolution
            .skills
            .iter()
            .any(|skill| skill.id == "claude:rust-patterns"));
        assert!(!resolution
            .skills
            .iter()
            .any(|skill| skill.id == "claude:frontend-ui"));
    }

    #[test]
    fn disabled_external_skill_id_is_excluded_in_core_mode() {
        let temp = tempfile::tempdir().unwrap();
        let claude_root = temp.path().join("claude").join("skills");
        write_external_skill(&claude_root, "rust-patterns", "# Rust Patterns");
        write_external_skill(&claude_root, "frontend-ui", "# Frontend UI");
        let service = test_service_with_external_roots(
            vec![("claude".to_string(), claude_root)],
            Some(temp.path().join("plugins")),
        );
        let profile = service
            .create_profile(LaunchProfileDraft {
                name: Some("Disable One External".into()),
                alias: None,
                description: None,
                provider_id: None,
                adapter_options: Default::default(),
                target_tools: vec!["claude".into()],
                target_runtime: None,
                yolo_mode: false,
                mcp_policy: Default::default(),
                skill_policy: crate::models::launch_profile::LaunchProfileSkillPolicy {
                    disabled_skill_ids: vec!["claude:frontend-ui".into()],
                    ..Default::default()
                },
                is_default: false,
            })
            .unwrap();

        let resolution = service.resolve_profile(
            &LaunchProfilePreviewRequest {
                profile_id: Some(profile.id),
                use_system_default: false,
                workspace_name: None,
                project_id: None,
                provider_id: None,
                provider_selection: LaunchProviderSelection::Inherit,
                cli_tool: Some("claude".into()),
                runtime_kind: None,
            },
            &[],
            &[],
            &SharedMcpConfig::default(),
            &HashMap::new(),
        );

        assert!(resolution
            .skills
            .iter()
            .any(|skill| skill.id == "claude:rust-patterns"));
        assert!(!resolution
            .skills
            .iter()
            .any(|skill| skill.id == "claude:frontend-ui"));
    }

    #[test]
    fn custom_external_skill_prompt_appends_allowed_skills() {
        let temp = tempfile::tempdir().unwrap();
        let claude_root = temp.path().join("claude").join("skills");
        write_external_skill(
            &claude_root,
            "rust-patterns",
            "---\nname: Idiomatic Rust\ndescription: Prefer type-safe Rust\n---\nFull content is not embedded.",
        );
        let service = test_service_with_external_roots(
            vec![("claude".to_string(), claude_root)],
            Some(temp.path().join("plugins")),
        );
        let profile = service
            .create_profile(LaunchProfileDraft {
                name: Some("Allowed External".into()),
                alias: None,
                description: None,
                provider_id: None,
                adapter_options: Default::default(),
                target_tools: vec!["claude".into()],
                target_runtime: None,
                yolo_mode: false,
                mcp_policy: Default::default(),
                skill_policy: crate::models::launch_profile::LaunchProfileSkillPolicy {
                    mode: LaunchProfileSkillMode::Custom,
                    enabled_skill_ids: vec!["claude:rust-patterns".into()],
                    ..Default::default()
                },
                is_default: false,
            })
            .unwrap();

        let prompt = service
            .session_skill_prompt_for_profile(Some(&profile))
            .expect("allowed skills prompt");

        assert!(prompt.contains("<allowed-skills>"));
        assert!(prompt.contains("- Idiomatic Rust (Prefer type-safe Rust)"));
        assert!(!prompt.contains("Full content is not embedded."));
    }
}
