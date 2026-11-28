//! Worktree setup: `<repo>/.ccpanes/worktree.json`（docs/116）。
//!
//! 仓库层可提交的配置（docs/98：描述仓库本身、换台机器依然有意义），三个字段：
//! - `setup`：新 worktree 建好后在其中执行的命令（如 `npm ci`）——**执行前必须经人批准**；
//! - `copyFiles`：从主树拷到新 worktree 的未跟踪文件（如 `.env`）；
//! - `sparseCheckout`：cone 模式的 sparse-checkout 目录。
//!
//! 「始终允许」是这台机器上这个用户的决定，按「项目 + 配置内容 hash」记在数据目录
//! （`worktree-setup-approvals.json`），绝不写进仓库。配置一改 hash 就变，必须重新批准。

mod apply;

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::services::WorktreeService;
use crate::utils::project_dirs;
use crate::utils::{paths_equivalent, project_identity_key};

pub use apply::{apply_copy_files, apply_sparse_checkout};

/// `<repo>/.ccpanes/worktree.json`
pub const WORKTREE_SETUP_FILE: &str = "worktree.json";
const MAX_SETUP_COMMANDS: usize = 20;
const MAX_COMMAND_BYTES: usize = 4 * 1024;
/// 与 open_terminal_tab 的单行命令上限一致：拼好的整行要能原样提交。
const MAX_COMMAND_LINE_BYTES: usize = 8 * 1024;
const MAX_COPY_FILES: usize = 100;
const MAX_SPARSE_PATTERNS: usize = 200;

/// 仓库里的原始配置。未知字段（如 `$schema`）忽略。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSetupConfig {
    #[serde(default)]
    pub setup: Vec<String>,
    #[serde(default)]
    pub copy_files: Vec<String>,
    #[serde(default)]
    pub sparse_checkout: Vec<String>,
}

/// 建好 worktree 之后给调用方（UI / MCP）的执行计划。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSetupPlan {
    /// 主树根目录（批准记录的「项目」维度）
    pub project_path: String,
    /// 新 worktree 根目录（setup 的 cwd）
    pub worktree_path: String,
    pub setup: Vec<String>,
    /// 拼成一行、可直接提交到 shell 的命令；`setup` 为空时为空串
    pub command_line: String,
    pub config_hash: String,
    /// 是否已有「始终允许」记录
    pub always_allowed: bool,
    pub copied_files: Vec<String>,
    pub sparse_applied: bool,
    /// 拷贝/稀疏检出中被跳过的项（只做提示，不影响 setup）
    pub warnings: Vec<String>,
}

/// 解析并校验配置。命令只能是单行文本；路径必须是仓库内的相对路径。
pub fn parse_worktree_setup_config(raw: &str) -> Result<WorktreeSetupConfig, String> {
    let parsed: WorktreeSetupConfig = serde_json::from_str(raw)
        .map_err(|error| format!("Invalid {WORKTREE_SETUP_FILE}: {error}"))?;
    let setup = normalize_list(parsed.setup);
    let copy_files = normalize_list(parsed.copy_files);
    let sparse_checkout = normalize_list(parsed.sparse_checkout);

    if setup.len() > MAX_SETUP_COMMANDS {
        return Err(format!(
            "setup allows at most {MAX_SETUP_COMMANDS} commands"
        ));
    }
    for command in &setup {
        validate_command(command)?;
    }
    if copy_files.len() > MAX_COPY_FILES {
        return Err(format!("copyFiles allows at most {MAX_COPY_FILES} entries"));
    }
    for path in &copy_files {
        validate_relative_path(path).map_err(|error| format!("copyFiles '{path}': {error}"))?;
    }
    if sparse_checkout.len() > MAX_SPARSE_PATTERNS {
        return Err(format!(
            "sparseCheckout allows at most {MAX_SPARSE_PATTERNS} entries"
        ));
    }
    for pattern in &sparse_checkout {
        validate_relative_path(pattern)
            .map_err(|error| format!("sparseCheckout '{pattern}': {error}"))?;
    }
    let config = WorktreeSetupConfig {
        setup,
        copy_files,
        sparse_checkout,
    };
    let line = setup_command_line(&config.setup, cfg!(windows));
    if line.len() > MAX_COMMAND_LINE_BYTES {
        return Err(format!(
            "setup commands exceed {MAX_COMMAND_LINE_BYTES} bytes in total"
        ));
    }
    Ok(config)
}

fn normalize_list(items: Vec<String>) -> Vec<String> {
    items
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

fn validate_command(command: &str) -> Result<(), String> {
    if command.len() > MAX_COMMAND_BYTES {
        return Err(format!("setup command exceeds {MAX_COMMAND_BYTES} bytes"));
    }
    if command.chars().any(char::is_control) {
        return Err("setup commands must be single-line text without control characters".into());
    }
    Ok(())
}

/// 只接受仓库内相对路径：不能绝对、不能 `..`、不能以 `-` 开头（会被 git 当成选项）。
pub(crate) fn validate_relative_path(raw: &str) -> Result<(), String> {
    if raw.chars().any(char::is_control) {
        return Err("contains control characters".into());
    }
    if raw.starts_with('-') {
        return Err("must not start with '-'".into());
    }
    let normalized = raw.replace('\\', "/");
    let path = Path::new(&normalized);
    if path.is_absolute() || normalized.starts_with('/') || has_drive_prefix(&normalized) {
        return Err("must be a relative path".into());
    }
    let mut depth = 0usize;
    for component in path.components() {
        match component {
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            _ => return Err("must stay inside the repository".into()),
        }
    }
    if depth == 0 {
        return Err("must name a path inside the repository".into());
    }
    Ok(())
}

fn has_drive_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// 配置内容 hash：对规范化后的配置取 SHA-256。空白/顺序以外的任何改动都会换 hash。
pub fn worktree_setup_config_hash(config: &WorktreeSetupConfig) -> String {
    let canonical = serde_json::to_vec(config).unwrap_or_default();
    Sha256::digest(&canonical)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// 多条命令拼成一行：Unix 用 `&&`（前一步失败即停）；Windows PowerShell 5.1 不认
/// `&&`，只能用 `;` 顺序执行。
pub fn setup_command_line(commands: &[String], windows: bool) -> String {
    commands.join(if windows { "; " } else { " && " })
}

/// 读取 `<root>/.ccpanes/worktree.json`；不存在返回 `Ok(None)`。
pub fn load_worktree_setup_config(root: &Path) -> Result<Option<WorktreeSetupConfig>, String> {
    let path = project_dirs::ccpanes_dir(root).join(WORKTREE_SETUP_FILE);
    match std::fs::read_to_string(&path) {
        Ok(raw) => parse_worktree_setup_config(&raw).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to read {}: {error}", path.display())),
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ApprovalRecord {
    config_hash: String,
    approved_at: u64,
}

/// 批准记录：每个项目只留最新一次「始终允许」的 hash。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSetupApprovals {
    #[serde(default)]
    approvals: BTreeMap<String, ApprovalRecord>,
}

impl WorktreeSetupApprovals {
    pub fn is_approved(&self, project_path: &str, config_hash: &str) -> bool {
        !config_hash.is_empty()
            && self
                .approvals
                .get(&project_identity_key(project_path))
                .is_some_and(|record| record.config_hash == config_hash)
    }

    pub fn approve(&mut self, project_path: &str, config_hash: &str, now_ms: u64) {
        self.approvals.insert(
            project_identity_key(project_path),
            ApprovalRecord {
                config_hash: config_hash.to_string(),
                approved_at: now_ms,
            },
        );
    }
}

/// 持有批准记录文件路径；读多写少，写入串行化。
pub struct WorktreeSetupService {
    approvals_path: PathBuf,
    write_lock: Mutex<()>,
}

impl WorktreeSetupService {
    pub fn new(approvals_path: PathBuf) -> Self {
        Self {
            approvals_path,
            write_lock: Mutex::new(()),
        }
    }

    fn load_approvals(&self) -> WorktreeSetupApprovals {
        match std::fs::read_to_string(&self.approvals_path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|error| {
                tracing::warn!(%error, "worktree setup approvals unreadable; treating as empty");
                WorktreeSetupApprovals::default()
            }),
            Err(_) => WorktreeSetupApprovals::default(),
        }
    }

    pub fn is_approved(&self, project_path: &str, config_hash: &str) -> bool {
        self.load_approvals().is_approved(project_path, config_hash)
    }

    /// 记「始终允许」。只接受当前磁盘上配置的 hash，防止批准一份并不存在的配置。
    pub fn approve(&self, project_path: &str, config_hash: &str) -> Result<(), String> {
        let config_hash = config_hash.trim();
        if config_hash.len() != 64 || !config_hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("Invalid worktree setup config hash".into());
        }
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut approvals = self.load_approvals();
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or_default();
        approvals.approve(project_path, config_hash, now_ms);
        let json = serde_json::to_vec_pretty(&approvals).map_err(|error| error.to_string())?;
        crate::utils::atomic_file::write_atomic(&self.approvals_path, json)
            .map_err(|error| format!("Failed to save worktree setup approval: {error}"))
    }

    /// worktree 建好后调用：应用 sparseCheckout + copyFiles（不执行任何命令），
    /// 返回 setup 计划。没有配置文件返回 `Ok(None)`。
    pub fn prepare(&self, worktree_path: &str) -> Result<Option<WorktreeSetupPlan>, String> {
        let (main_root, worktree_root) = resolve_roots(worktree_path)?;
        // 优先新 worktree 里提交过的版本；还没提交时回落主树（方便调试配置）。
        let config = match load_worktree_setup_config(&worktree_root)? {
            Some(config) => config,
            None => match load_worktree_setup_config(&main_root)? {
                Some(config) => config,
                None => return Ok(None),
            },
        };
        let mut warnings = Vec::new();
        let sparse_applied = if config.sparse_checkout.is_empty() {
            false
        } else {
            match apply_sparse_checkout(&worktree_root, &config.sparse_checkout) {
                Ok(()) => true,
                Err(error) => {
                    warnings.push(error);
                    false
                }
            }
        };
        let copy = apply_copy_files(&main_root, &worktree_root, &config.copy_files);
        warnings.extend(copy.warnings);
        Ok(Some(self.build_plan(
            &main_root,
            &worktree_root,
            &config,
            copy.copied,
            sparse_applied,
            warnings,
        )))
    }

    fn build_plan(
        &self,
        main_root: &Path,
        worktree_root: &Path,
        config: &WorktreeSetupConfig,
        copied_files: Vec<String>,
        sparse_applied: bool,
        warnings: Vec<String>,
    ) -> WorktreeSetupPlan {
        let project_path = main_root.to_string_lossy().into_owned();
        let config_hash = worktree_setup_config_hash(config);
        let always_allowed =
            !config.setup.is_empty() && self.is_approved(&project_path, &config_hash);
        WorktreeSetupPlan {
            project_path,
            worktree_path: worktree_root.to_string_lossy().into_owned(),
            setup: config.setup.clone(),
            command_line: setup_command_line(&config.setup, cfg!(windows)),
            config_hash,
            always_allowed,
            copied_files,
            sparse_applied,
            warnings,
        }
    }
}

/// (主树根, 新 worktree 根)。新 worktree 必须是已登记的非主 worktree。
fn resolve_roots(worktree_path: &str) -> Result<(PathBuf, PathBuf), String> {
    let worktree_root = crate::services::GitService::discover_repo_root(Path::new(worktree_path))
        .map_err(|_| "Not a Git repository".to_string())?;
    let listed = WorktreeService::new().list_worktrees(worktree_root.to_string_lossy().as_ref())?;
    let main = listed
        .iter()
        .find(|worktree| worktree.is_main)
        .ok_or("Main worktree not found")?;
    if paths_equivalent(&main.path, &worktree_root) {
        return Err("Path is the main worktree, not a linked one".into());
    }
    if !listed
        .iter()
        .any(|worktree| !worktree.is_main && paths_equivalent(&worktree.path, &worktree_root))
    {
        return Err("Path is not a registered worktree".into());
    }
    Ok((PathBuf::from(&main.path), worktree_root))
}

#[cfg(test)]
mod tests;
