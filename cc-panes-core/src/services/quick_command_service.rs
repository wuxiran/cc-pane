use crate::models::{QuickCommand, QuickCommandConfig, QuickCommandDraft, QuickCommandKind};
use anyhow::{anyhow, Context, Result};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const PROJECT_CONFIG_DIR: &str = ".ccpanes";
const CONFIG_FILE_NAME: &str = "quick-commands.json";

pub struct QuickCommandService {
    config_path: PathBuf,
    global_config: Mutex<QuickCommandConfig>,
    project_io_lock: Mutex<()>,
}

impl QuickCommandService {
    pub fn new(config_path: PathBuf) -> Self {
        let global_config = Self::load_from_file(&config_path).unwrap_or_default();
        Self {
            config_path,
            global_config: Mutex::new(global_config),
            project_io_lock: Mutex::new(()),
        }
    }

    pub fn list_global(&self) -> Vec<QuickCommand> {
        self.global_config
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .commands
            .clone()
    }

    pub fn create_global(&self, draft: QuickCommandDraft) -> Result<QuickCommand> {
        let now = chrono::Utc::now().to_rfc3339();
        let command =
            Self::command_from_draft(uuid::Uuid::new_v4().to_string(), draft, &now, &now)?;
        let mut config = self
            .global_config
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut next = config.clone();
        next.commands.push(command.clone());
        self.save_to_file(&self.config_path, &next)?;
        *config = next;
        Ok(command)
    }

    pub fn update_global(&self, id: &str, draft: QuickCommandDraft) -> Result<QuickCommand> {
        let mut config = self
            .global_config
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let existing = config
            .commands
            .iter()
            .find(|command| command.id == id)
            .ok_or_else(|| anyhow!("Quick command '{}' not found", id))?;
        let updated = Self::command_from_draft(
            id.to_string(),
            draft,
            &existing.created_at,
            &chrono::Utc::now().to_rfc3339(),
        )?;
        let mut next = config.clone();
        let position = next
            .commands
            .iter()
            .position(|command| command.id == id)
            .expect("existing quick command position");
        next.commands[position] = updated.clone();
        self.save_to_file(&self.config_path, &next)?;
        *config = next;
        Ok(updated)
    }

    pub fn delete_global(&self, id: &str) -> Result<()> {
        let mut config = self
            .global_config
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !config.commands.iter().any(|command| command.id == id) {
            return Err(anyhow!("Quick command '{}' not found", id));
        }
        let mut next = config.clone();
        next.commands.retain(|command| command.id != id);
        self.save_to_file(&self.config_path, &next)?;
        *config = next;
        Ok(())
    }

    /// Workspace layer (docs/98): `<workspace_dir>/quick-commands.json`, where `workspace_dir`
    /// is `AppPaths::workspace_dir(name)`. Resolution order for a session is
    /// project → workspace → global; this layer is the workspace-first default.
    pub fn list_workspace(&self, workspace_dir: &Path) -> Result<Vec<QuickCommand>> {
        let _guard = self
            .project_io_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        Ok(Self::load_from_file(&workspace_dir.join(CONFIG_FILE_NAME))?.commands)
    }

    pub fn save_workspace(
        &self,
        workspace_dir: &Path,
        commands: Vec<QuickCommand>,
    ) -> Result<Vec<QuickCommand>> {
        let _guard = self
            .project_io_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        Self::validate_commands(&commands)?;
        std::fs::create_dir_all(workspace_dir)
            .with_context(|| format!("Failed to create {}", workspace_dir.display()))?;
        self.save_to_file(
            &workspace_dir.join(CONFIG_FILE_NAME),
            &QuickCommandConfig {
                commands: commands.clone(),
            },
        )?;
        Ok(commands)
    }

    pub fn list_project(&self, project_path: &Path) -> Result<Vec<QuickCommand>> {
        let _guard = self
            .project_io_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let config_path = Self::project_config_path(project_path, false)?;
        Ok(Self::load_from_file(&config_path)?.commands)
    }

    pub fn save_project(
        &self,
        project_path: &Path,
        commands: Vec<QuickCommand>,
    ) -> Result<Vec<QuickCommand>> {
        let _guard = self
            .project_io_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        Self::validate_commands(&commands)?;
        let config_path = Self::project_config_path(project_path, true)?;
        self.save_to_file(
            &config_path,
            &QuickCommandConfig {
                commands: commands.clone(),
            },
        )?;
        Ok(commands)
    }

    fn command_from_draft(
        id: String,
        draft: QuickCommandDraft,
        created_at: &str,
        updated_at: &str,
    ) -> Result<QuickCommand> {
        let name = draft.name.trim();
        if name.is_empty() {
            return Err(anyhow!("Quick command name cannot be empty"));
        }
        if draft.text.trim().is_empty() {
            return Err(anyhow!("Quick command text cannot be empty"));
        }
        let cli_tool = Self::normalize_cli_tool(draft.kind, draft.cli_tool)?;
        Ok(QuickCommand {
            id,
            name: name.to_string(),
            kind: draft.kind,
            text: draft.text,
            append_enter: draft.append_enter,
            target: draft.target,
            cli_tool,
            created_at: created_at.to_string(),
            updated_at: updated_at.to_string(),
        })
    }

    fn normalize_cli_tool(
        kind: QuickCommandKind,
        cli_tool: Option<String>,
    ) -> Result<Option<String>> {
        if kind == QuickCommandKind::Terminal {
            return Ok(None);
        }
        let cli_tool = cli_tool
            .as_deref()
            .map(str::trim)
            .filter(|tool| !tool.is_empty() && *tool != "none")
            .ok_or_else(|| anyhow!("Agent prompt quick commands require a CLI tool"))?;
        Ok(Some(cli_tool.to_string()))
    }

    fn validate_commands(commands: &[QuickCommand]) -> Result<()> {
        let mut ids = HashSet::new();
        for command in commands {
            if command.id.trim().is_empty() || !ids.insert(command.id.as_str()) {
                return Err(anyhow!("Quick command ids must be non-empty and unique"));
            }
            Self::command_from_draft(
                command.id.clone(),
                QuickCommandDraft {
                    name: command.name.clone(),
                    kind: command.kind,
                    text: command.text.clone(),
                    append_enter: command.append_enter,
                    target: command.target,
                    cli_tool: command.cli_tool.clone(),
                },
                &command.created_at,
                &command.updated_at,
            )?;
        }
        Ok(())
    }

    fn load_from_file(path: &Path) -> Result<QuickCommandConfig> {
        if !path.exists() {
            return Ok(QuickCommandConfig::default());
        }
        Self::reject_symlink(path)?;
        let content = std::fs::read_to_string(path)
            .with_context(|| format!("Failed to read {}", path.display()))?;
        if content.trim().is_empty() {
            return Ok(QuickCommandConfig::default());
        }
        serde_json::from_str(&content).with_context(|| "Failed to parse quick commands")
    }

    fn save_to_file(&self, path: &Path, config: &QuickCommandConfig) -> Result<()> {
        if path.exists() {
            Self::reject_symlink(path)?;
        }
        let content = serde_json::to_string_pretty(config)
            .with_context(|| "Failed to serialize quick commands")?;
        crate::utils::atomic_file::write_atomic(path, content)
    }

    fn project_config_path(project_path: &Path, create: bool) -> Result<PathBuf> {
        let project_path = project_path.canonicalize().with_context(|| {
            format!("Failed to resolve project path {}", project_path.display())
        })?;
        if !project_path.is_dir() {
            return Err(anyhow!("Project path is not a directory"));
        }
        let config_dir = project_path.join(PROJECT_CONFIG_DIR);
        if config_dir.exists() {
            Self::reject_symlink(&config_dir)?;
            if !config_dir.is_dir() {
                return Err(anyhow!("Project .ccpanes path is not a directory"));
            }
        } else if create {
            // 经 project_dirs 创建，顺带写 .ccpanes/.gitignore 守卫（docs/98）
            crate::utils::project_dirs::ensure_ccpanes_dir(&project_path)
                .with_context(|| format!("Failed to create {}", config_dir.display()))?;
        }
        let config_path = config_dir.join(CONFIG_FILE_NAME);
        if config_path.exists() {
            Self::reject_symlink(&config_path)?;
        }
        Ok(config_path)
    }

    fn reject_symlink(path: &Path) -> Result<()> {
        if std::fs::symlink_metadata(path)
            .with_context(|| format!("Failed to inspect {}", path.display()))?
            .file_type()
            .is_symlink()
        {
            return Err(anyhow!(
                "Quick command path cannot be a symbolic link: {}",
                path.display()
            ));
        }
        Ok(())
    }
}
