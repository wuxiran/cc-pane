//! Publish profiles and their default-selection changes only after durable persistence.
use super::{LaunchProfile, LaunchProfileConfig, LaunchProfileService};
use crate::models::launch_profile::LaunchProfileDraft;
use anyhow::{anyhow, Context, Result};

impl LaunchProfileService {
    fn mutate_config<T>(
        &self,
        mutate: impl FnOnce(&mut LaunchProfileConfig) -> Result<T>,
    ) -> Result<T> {
        let mut current = self
            .config
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut candidate = current.clone();
        let result = mutate(&mut candidate)?;
        let content = serde_json::to_vec_pretty(&candidate)
            .with_context(|| "Failed to serialize launch profiles")?;
        self.write_config(&content)
            .with_context(|| format!("Failed to write {}", self.config_path.display()))?;
        *current = candidate;
        Ok(result)
    }

    fn write_config(&self, content: &[u8]) -> Result<()> {
        #[cfg(test)]
        if let Some(writer) = self.persistence_writer {
            return writer(&self.config_path, content);
        }
        crate::utils::atomic_file::write_atomic(&self.config_path, content)
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
            model_id: Self::normalize_model_id(draft.provider_id.as_deref(), draft.model_id),
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
        self.mutate_config(|config| {
            if config.profiles.is_empty() {
                profile.is_default = true;
            }
            if profile.is_default {
                Self::clear_overlapping_defaults(
                    config,
                    &profile.id,
                    &profile.target_tools,
                    profile.target_runtime.as_deref(),
                );
            }
            config.profiles.push(profile.clone());
            Ok(profile)
        })
    }

    pub fn update_profile(&self, id: &str, draft: LaunchProfileDraft) -> Result<LaunchProfile> {
        self.mutate_config(|config| {
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
                    config,
                    id,
                    &target_tools,
                    target_runtime.as_deref(),
                );
            }
            let mut profile = config.profiles[pos].clone();
            profile.alias = Self::normalize_alias(draft.alias, &name);
            profile.name = name;
            profile.description = draft.description;
            profile.model_id =
                Self::normalize_model_id(draft.provider_id.as_deref(), draft.model_id);
            profile.provider_id = draft.provider_id;
            profile.adapter_options = draft.adapter_options;
            profile.target_tools = target_tools;
            profile.target_runtime = target_runtime;
            profile.yolo_mode = draft.yolo_mode;
            profile.mcp_policy = draft.mcp_policy;
            profile.skill_policy = draft.skill_policy;
            profile.is_default = draft.is_default;
            profile.updated_at = chrono::Utc::now().to_rfc3339();
            config.profiles[pos] = profile.clone();
            Ok(profile)
        })
    }

    pub fn delete_profile(&self, id: &str) -> Result<()> {
        self.mutate_config(|config| {
            let removed_default_target = config
                .profiles
                .iter()
                .find(|profile| profile.id == id && profile.is_default)
                .map(|profile| (profile.target_tools.clone(), profile.target_runtime.clone()));
            config.profiles.retain(|profile| profile.id != id);
            if let Some((target_tools, target_runtime)) = removed_default_target {
                let overlaps = |profile: &LaunchProfile| {
                    Self::target_tools_overlap(&profile.target_tools, &target_tools)
                        && Self::target_runtime_overlap(
                            profile.target_runtime.as_deref(),
                            target_runtime.as_deref(),
                        )
                };
                if !config
                    .profiles
                    .iter()
                    .any(|profile| profile.is_default && overlaps(profile))
                {
                    if let Some(first) =
                        config.profiles.iter_mut().find(|profile| overlaps(profile))
                    {
                        first.is_default = true;
                    }
                }
            }
            Ok(())
        })
    }

    pub fn set_default_profile(&self, id: &str) -> Result<()> {
        self.mutate_config(|config| {
            let (target_tools, target_runtime) = config
                .profiles
                .iter()
                .find(|profile| profile.id == id)
                .map(|profile| (profile.target_tools.clone(), profile.target_runtime.clone()))
                .ok_or_else(|| anyhow!("Launch profile '{}' not found", id))?;
            Self::clear_overlapping_defaults(config, id, &target_tools, target_runtime.as_deref());
            if let Some(profile) = config.profiles.iter_mut().find(|profile| profile.id == id) {
                profile.is_default = true;
                profile.updated_at = chrono::Utc::now().to_rfc3339();
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests;
