use crate::models::launch_profile::{
    LaunchProfile, LaunchProfileConfig, LaunchProfileDraft, LaunchProfileMcpMode,
    LaunchProfilePreviewRequest, LaunchProfileResolution, LaunchProfileSkillMode,
    LaunchProviderSelection, ResolvedMcpServer, ResolvedSkill, SharedMcpUrls,
};
use crate::models::provider::Provider;
use crate::models::shared_mcp::SharedMcpConfig;
use crate::models::Workspace;
use anyhow::{anyhow, Context, Result};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct LaunchProfileService {
    config_path: PathBuf,
    config: Mutex<LaunchProfileConfig>,
}

impl LaunchProfileService {
    pub fn new(config_path: PathBuf) -> Self {
        let config = Self::load_from_file(&config_path).unwrap_or_default();
        Self {
            config_path,
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
            target_tools: Self::normalize_target_tools(draft.target_tools),
            target_runtime: Self::normalize_runtime(draft.target_runtime),
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
        next.target_tools = target_tools;
        next.target_runtime = target_runtime;
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

        candidate_id
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
            })
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

    pub fn session_skill_prompt_for_profile(profile: Option<&LaunchProfile>) -> Option<String> {
        let profile = profile?;
        if profile.skill_policy.mode == LaunchProfileSkillMode::Disabled
            || profile.skill_policy.target != "session"
        {
            return None;
        }

        let skills = Self::selected_profile_skills(profile);
        if skills.is_empty() {
            return None;
        }

        let mut prompt = String::from(
            "<ccpanes-launch-profile-skills>\n\
             The current CC-Panes launch profile selected these session skills. \
             Follow them when they are relevant to the user's request.\n",
        );
        for skill in skills {
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
        prompt.push_str("</ccpanes-launch-profile-skills>");
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
            (Some(profile), Some(workspace)) => Self::resolve_skills(profile, workspace),
            (Some(profile), None) => Self::resolve_base_skills(profile),
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

    fn resolve_base_skills(profile: &LaunchProfile) -> Vec<ResolvedSkill> {
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

    fn default_skills(workspace: &Workspace) -> Vec<ResolvedSkill> {
        let _ = workspace;
        core_skill_ids()
    }

    fn resolve_skills(profile: &LaunchProfile, workspace: &Workspace) -> Vec<ResolvedSkill> {
        let mut skills = Self::resolve_base_skills(profile);
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

fn core_skill_ids() -> Vec<ResolvedSkill> {
    [
        "ccpanes-launch-task",
        "ccpanes-fork-session",
        "ccpanes-parallel-run",
        "ccpanes-workspace",
        "ccpanes-workspace-migrate",
        "ccpanes-browse-sessions",
        "ccpanes-dispatch-todos",
        "ccpanes-spec",
        "ccpanes-plantocodex",
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
        let path = std::env::temp_dir().join(format!(
            "cc-panes-launch-profile-test-{}.json",
            uuid::Uuid::new_v4()
        ));
        LaunchProfileService::new(path)
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
                target_tools: Vec::new(),
                target_runtime: None,
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

    #[test]
    fn resolve_profile_none_selection_skips_all_provider_fallbacks() {
        let service = test_service();
        let profile = service
            .create_profile(LaunchProfileDraft {
                name: Some("Profile".into()),
                alias: None,
                description: None,
                provider_id: Some("profile-provider".into()),
                target_tools: Vec::new(),
                target_runtime: None,
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
                target_tools: Vec::new(),
                target_runtime: None,
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
                target_tools: vec!["claude".into()],
                target_runtime: None,
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
                target_tools: vec!["codex".into()],
                target_runtime: None,
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
                target_tools: vec!["codex".into()],
                target_runtime: Some("local".into()),
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
                target_tools: vec!["codex".into()],
                target_runtime: Some("wsl".into()),
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
                target_tools: vec!["claude".into()],
                target_runtime: None,
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
                target_tools: vec!["codex".into()],
                target_runtime: None,
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
                target_tools: vec!["codex".into()],
                target_runtime: None,
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
                target_tools: vec!["codex".into()],
                target_runtime: None,
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
        assert!(resolution
            .skills
            .iter()
            .any(|skill| skill.id == "builtin:ccpanes-workspace"));
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
                target_tools: vec!["codex".into()],
                target_runtime: None,
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
        let prompt = LaunchProfileService::session_skill_prompt_for_profile(Some(&profile))
            .expect("profile skill prompt");

        assert!(resolution.skills.iter().any(|skill| {
            skill.id == "profile:review-guard" && skill.source == "profile" && skill.enabled
        }));
        assert!(prompt.contains("<ccpanes-launch-profile-skills>"));
        assert!(prompt.contains("Review Guard"));
        assert!(prompt.contains("Prioritize regressions and missing tests."));
    }
}
