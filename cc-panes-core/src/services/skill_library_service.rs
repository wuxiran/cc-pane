//! 资源库「技能」（docs/109 第 2 批）。资源库就是 `<data>/skills/user/<id>/`
//! （`InstalledUserSkill`），这里补上来源记录、粘贴安装、检查更新、备份和导入。
//!
//! 注入方式不变：启动档选中 `user:<id>` 后由 `LaunchProfileService` 内联进会话提示词。

mod backup;
mod check;
mod fs_ops;
mod probe;
pub mod remote;
mod source;
#[cfg(test)]
mod tests;

use crate::models::skill_library::{
    FoundSkill, FoundSkillOrigin, LibrarySkill, SkillCheck, SkillEditedState, SkillImportResult,
    SkillKeyError, SkillLibraryContent, SkillProvenance, SkillRemoveResult, SkillSourceKind,
};
use crate::services::launch_profile_service::LaunchProfileService;
use crate::services::skill_repo_fetcher::SkillRepoFetcher;
use crate::services::user_skill_service::{
    InstalledUserSkill, UserSkillService, USER_SKILL_MARKDOWN_FILE, USER_SKILL_METADATA_FILE,
};
use crate::services::{parse_skill_metadata, skill_frontmatter_field};
use crate::utils::{AppError, AppPaths, AppResult};
use backup::BackupSession;
use remote::{DefaultSkillRemote, SkillRemote};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tracing::{info, warn};

pub use probe::GithubDirInstall;

/// `read` 返回的文件列表上限，避免误链接到巨大目录时把界面撑爆。
const MAX_LISTED_FILES: usize = 2000;

pub struct SkillLibraryService {
    user_skills_dir: PathBuf,
    backups_dir: PathBuf,
    home_dir: Option<PathBuf>,
    probe_dir: PathBuf,
    remote: Arc<dyn SkillRemote>,
    launch_profiles: Option<Arc<LaunchProfileService>>,
    probes: Mutex<HashMap<String, probe::ProbeEntry>>,
    checks: Mutex<HashMap<String, SkillCheck>>,
}

impl SkillLibraryService {
    pub fn new(paths: &AppPaths, launch_profiles: Option<Arc<LaunchProfileService>>) -> Self {
        let fetcher = Arc::new(SkillRepoFetcher::with_default_client());
        Self::with_remote(
            paths.user_skills_dir(),
            paths.skill_backups_dir(),
            dirs::home_dir(),
            std::env::temp_dir().join("cc-panes-skill-probes"),
            Arc::new(DefaultSkillRemote::new(fetcher)),
            launch_profiles,
        )
    }

    pub fn with_remote(
        user_skills_dir: PathBuf,
        backups_dir: PathBuf,
        home_dir: Option<PathBuf>,
        probe_dir: PathBuf,
        remote: Arc<dyn SkillRemote>,
        launch_profiles: Option<Arc<LaunchProfileService>>,
    ) -> Self {
        Self {
            user_skills_dir,
            backups_dir,
            home_dir,
            probe_dir,
            remote,
            launch_profiles,
            probes: Mutex::new(HashMap::new()),
            checks: Mutex::new(HashMap::new()),
        }
    }

    pub fn user_skills_dir(&self) -> &Path {
        &self.user_skills_dir
    }

    // ---------------------------------------------------------------------
    // list / read
    // ---------------------------------------------------------------------

    pub fn list(&self) -> AppResult<Vec<LibrarySkill>> {
        let skills = UserSkillService::list_from_dir(&self.user_skills_dir)?;
        Ok(skills
            .into_iter()
            .map(|skill| self.to_library_skill(skill))
            .collect())
    }

    fn to_library_skill(&self, skill: InstalledUserSkill) -> LibrarySkill {
        let library_dir = self.user_skills_dir.join(&skill.id);
        let provenance = effective_provenance(&skill);
        let content_dir = skill.content_dir(&library_dir);
        let folder_missing = provenance.kind == SkillSourceKind::Folder
            && !content_dir.join(USER_SKILL_MARKDOWN_FILE).is_file();
        LibrarySkill {
            edited: edited_state(&provenance, &content_dir),
            id: skill.id,
            name: skill.name,
            description: skill.description,
            provenance,
            gone: skill.gone,
            folder_missing,
            dir_path: content_dir.to_string_lossy().to_string(),
            installed_at: skill.installed_at,
        }
    }

    pub fn read(&self, id: &str) -> AppResult<SkillLibraryContent> {
        let skill = self.load_metadata(id)?;
        let content_dir = skill.content_dir(&self.user_skills_dir.join(id));
        let markdown = content_dir.join(USER_SKILL_MARKDOWN_FILE);
        if !markdown.is_file() {
            return Err(AppError::from(format!(
                "SKILL.md for '{}' was not found at {}",
                id,
                content_dir.display()
            )));
        }
        let content = std::fs::read_to_string(&markdown)?;
        let mut files = fs_ops::list_files(&content_dir).unwrap_or_default();
        files.truncate(MAX_LISTED_FILES);
        Ok(SkillLibraryContent {
            content,
            dir_path: content_dir.to_string_lossy().to_string(),
            files,
        })
    }

    fn load_metadata(&self, id: &str) -> AppResult<InstalledUserSkill> {
        let dir = UserSkillService::skill_dir_for(&self.user_skills_dir, id)?;
        let path = dir.join(USER_SKILL_METADATA_FILE);
        if !path.is_file() {
            return Err(AppError::from(format!(
                "Skill '{}' is not in the library",
                id
            )));
        }
        let raw = std::fs::read_to_string(&path)?;
        serde_json::from_str(&raw)
            .map_err(|err| AppError::from(format!("Invalid user skill metadata: {}", err)))
    }

    /// 读改写 `skill.json`（只动元数据，不碰技能文件）。
    fn update_metadata(
        &self,
        id: &str,
        edit: impl FnOnce(&mut InstalledUserSkill),
    ) -> AppResult<()> {
        let mut skill = self.load_metadata(id)?;
        edit(&mut skill);
        UserSkillService::write_metadata(&self.user_skills_dir.join(id), &skill)
    }

    /// 库目录里已占用的 id（含没有完整元数据的目录，免得安装时撞上）。
    fn taken_ids(&self) -> HashSet<String> {
        std::fs::read_dir(&self.user_skills_dir)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|entry| entry.path().is_dir())
                    .map(|entry| entry.file_name().to_string_lossy().to_string())
                    .filter(|name| !name.starts_with('.'))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 来源标识 → 库内 id，用于「同来源已存在」判断。
    fn identity_index(&self) -> HashMap<String, String> {
        UserSkillService::list_from_dir(&self.user_skills_dir)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|skill| {
                source_identity(&effective_provenance(&skill)).map(|identity| (identity, skill.id))
            })
            .collect()
    }

    fn staging_dir(&self, id: &str) -> PathBuf {
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        self.user_skills_dir
            .join(format!(".staging-{}-{}", id, &nonce[..8]))
    }

    // ---------------------------------------------------------------------
    // remove
    // ---------------------------------------------------------------------

    pub fn remove(&self, ids: &[String]) -> AppResult<SkillRemoveResult> {
        let mut session = BackupSession::new(&self.backups_dir);
        let mut removed = Vec::new();
        let mut first_error = None;
        for id in ids {
            let dir = match UserSkillService::skill_dir_for(&self.user_skills_dir, id) {
                Ok(dir) => dir,
                Err(error) => {
                    first_error.get_or_insert(error);
                    continue;
                }
            };
            if !dir.exists() {
                continue;
            }
            // folder 来源的库目录里只有 skill.json，链接的原目录不受影响。
            match session.stash(id, &dir) {
                Ok(_) => removed.push(id.clone()),
                Err(error) => {
                    warn!("[skill_library] failed to remove {}: {}", id, error);
                    first_error.get_or_insert(error);
                }
            }
        }
        if !removed.is_empty() {
            self.forget_checks(&removed);
            self.strip_from_profiles(&removed);
        }
        let backup_dir = session.finish();
        if removed.is_empty() {
            if let Some(error) = first_error {
                return Err(error);
            }
        }
        info!(count = removed.len(), "[skill_library] removed skills");
        Ok(SkillRemoveResult {
            removed,
            backup_dir,
        })
    }

    fn strip_from_profiles(&self, ids: &[String]) {
        let Some(profiles) = &self.launch_profiles else {
            return;
        };
        let profile_ids: Vec<String> = ids.iter().map(|id| format!("user:{}", id)).collect();
        if let Err(error) = profiles.remove_skill_ids_from_profiles(&profile_ids) {
            warn!(
                "[skill_library] failed to strip removed skills from launch profiles: {}",
                error
            );
        }
    }

    fn forget_checks(&self, ids: &[String]) {
        let mut checks = self
            .checks
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for id in ids {
            checks.remove(id);
        }
    }

    fn remember_checks(&self, results: &[SkillCheck]) {
        let mut checks = self
            .checks
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for result in results {
            checks.insert(result.id.clone(), result.clone());
        }
    }

    // ---------------------------------------------------------------------
    // found / import
    // ---------------------------------------------------------------------

    fn found_roots(&self) -> Vec<(FoundSkillOrigin, PathBuf)> {
        let Some(home) = &self.home_dir else {
            return Vec::new();
        };
        vec![
            (
                FoundSkillOrigin::Claude,
                home.join(".claude").join("skills"),
            ),
            (FoundSkillOrigin::Codex, home.join(".codex").join("skills")),
            (
                FoundSkillOrigin::Agents,
                home.join(".agents").join("skills"),
            ),
        ]
    }

    /// 扫 `~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills` 下含 SKILL.md 的一级目录。只读。
    pub fn found(&self) -> AppResult<Vec<FoundSkill>> {
        let library = UserSkillService::list_from_dir(&self.user_skills_dir).unwrap_or_default();
        let mut by_name: HashMap<String, String> = HashMap::new();
        for skill in &library {
            by_name
                .entry(skill.name.to_ascii_lowercase())
                .or_insert_with(|| skill.id.clone());
            by_name
                .entry(skill.id.to_ascii_lowercase())
                .or_insert_with(|| skill.id.clone());
        }
        let mut found = Vec::new();
        for (origin, root) in self.found_roots() {
            let Ok(entries) = std::fs::read_dir(&root) else {
                continue;
            };
            let mut rows: Vec<FoundSkill> = entries
                .flatten()
                .filter_map(|entry| found_skill(origin, &entry.path(), &by_name))
                .collect();
            rows.sort_by_key(|row| row.name.to_ascii_lowercase());
            found.extend(rows);
        }
        Ok(found)
    }

    /// 复制进资源库，`kind: "imported"`，原目录不动。只接受 `found` 列出的路径。
    pub fn import(&self, keys: &[String]) -> AppResult<SkillImportResult> {
        let found: HashMap<String, FoundSkill> = self
            .found()?
            .into_iter()
            .map(|skill| (skill.key.clone(), skill))
            .collect();
        let identities = self.identity_index();
        let mut taken = self.taken_ids();
        let mut result = SkillImportResult::default();
        for key in keys {
            let Some(skill) = found.get(key) else {
                result.failed.push(SkillKeyError {
                    key: key.clone(),
                    error: "Not found in agent skill folders".to_string(),
                });
                continue;
            };
            let identity = source_identity(&SkillProvenance {
                kind: SkillSourceKind::Imported,
                imported_from: Some(key.clone()),
                ..Default::default()
            });
            if let Some(existing) = identity.and_then(|identity| identities.get(&identity)) {
                result.failed.push(SkillKeyError {
                    key: key.clone(),
                    error: format!("Already in library as '{}'", existing),
                });
                continue;
            }
            let id = unique_id(&skill.name, origin_label(skill.origin), &taken);
            match self.import_one(skill, &id) {
                Ok(()) => {
                    taken.insert(id.clone());
                    result.imported.push(id);
                }
                Err(error) => result.failed.push(SkillKeyError {
                    key: key.clone(),
                    error: error.to_string(),
                }),
            }
        }
        Ok(result)
    }

    fn import_one(&self, skill: &FoundSkill, id: &str) -> AppResult<()> {
        let source = Path::new(&skill.dir_path);
        let staging = self.staging_dir(id);
        let outcome = (|| -> AppResult<()> {
            fs_ops::copy_dir_filtered(source, &staging)?;
            let provenance = SkillProvenance {
                kind: SkillSourceKind::Imported,
                tree_hash: Some(fs_ops::tree_hash(&staging)?),
                imported_from: Some(skill.key.clone()),
                ..Default::default()
            };
            let metadata = metadata_from_dir(&staging, id, &skill.name, provenance, "local")?;
            UserSkillService::write_metadata(&staging, &metadata)?;
            place_new(&staging, &self.user_skills_dir.join(id))
        })();
        if outcome.is_err() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        outcome
    }
}

fn origin_label(origin: FoundSkillOrigin) -> &'static str {
    match origin {
        FoundSkillOrigin::Claude => "claude",
        FoundSkillOrigin::Codex => "codex",
        FoundSkillOrigin::Agents => "agents",
    }
}

fn found_skill(
    origin: FoundSkillOrigin,
    path: &Path,
    by_name: &HashMap<String, String>,
) -> Option<FoundSkill> {
    let dir_name = path.file_name()?.to_string_lossy().to_string();
    if dir_name.starts_with('.') || !path.is_dir() {
        return None;
    }
    let markdown = path.join(USER_SKILL_MARKDOWN_FILE);
    let content = std::fs::read_to_string(&markdown).ok()?;
    let (name, description) = parse_skill_metadata(&content, &dir_name);
    let link_meta = std::fs::symlink_metadata(path).ok()?;
    let is_link = link_meta.file_type().is_symlink();
    let link_target = is_link
        .then(|| std::fs::read_link(path).ok())
        .flatten()
        .map(|target| target.to_string_lossy().to_string());
    let in_library_as = by_name
        .get(&name.to_ascii_lowercase())
        .or_else(|| by_name.get(&dir_name.to_ascii_lowercase()))
        .cloned();
    let key = path.to_string_lossy().to_string();
    Some(FoundSkill {
        key: key.clone(),
        name,
        description,
        dir_path: key,
        origin,
        is_link,
        link_target,
        in_library_as,
    })
}

/// 落盘的最后一步：暂存目录改名成正式目录。目标已存在时不覆盖。
fn place_new(staging: &Path, target: &Path) -> AppResult<()> {
    if target.exists() {
        return Err(AppError::from(format!(
            "{} already exists",
            target.display()
        )));
    }
    std::fs::rename(staging, target)?;
    Ok(())
}

/// 从暂存目录的 SKILL.md 生成 `skill.json`。
fn metadata_from_dir(
    dir: &Path,
    id: &str,
    fallback_name: &str,
    provenance: SkillProvenance,
    version: &str,
) -> AppResult<InstalledUserSkill> {
    let markdown = std::fs::read_to_string(dir.join(USER_SKILL_MARKDOWN_FILE))
        .map_err(|_| AppError::from("SKILL.md is missing or not UTF-8"))?;
    Ok(metadata_from_markdown(
        &markdown,
        id,
        fallback_name,
        provenance,
        version,
    ))
}

fn metadata_from_markdown(
    markdown: &str,
    id: &str,
    fallback_name: &str,
    provenance: SkillProvenance,
    version: &str,
) -> InstalledUserSkill {
    let (name, description) = parse_skill_metadata(markdown, fallback_name);
    InstalledUserSkill {
        id: id.to_string(),
        name,
        description,
        category: None,
        tags: Vec::new(),
        version: version.to_string(),
        license: skill_frontmatter_field(markdown, "license"),
        homepage_url: None,
        source_url: provenance_source_url(&provenance),
        content_sha256: fs_ops::sha256_hex(markdown.as_bytes()),
        installed_at: chrono::Utc::now().to_rfc3339(),
        file_path: None,
        provenance: Some(provenance),
        gone: false,
    }
}

fn provenance_source_url(provenance: &SkillProvenance) -> Option<String> {
    match provenance.kind {
        SkillSourceKind::Github => {
            let repo = provenance.repo.as_deref()?;
            let path = provenance.path.as_deref().unwrap_or_default();
            let git_ref = provenance
                .commit
                .as_deref()
                .or(provenance.git_ref.as_deref())
                .unwrap_or("HEAD");
            Some(
                format!("https://github.com/{}/tree/{}/{}", repo, git_ref, path)
                    .trim_end_matches('/')
                    .to_string(),
            )
        }
        SkillSourceKind::Git => provenance.repo.clone(),
        _ => None,
    }
}

/// 旧的市场安装没有 provenance，但 `sourceUrl` 是 `https://github.com/o/r/tree/<ref>/<path>`，
/// 足够推断出 github 来源以便检查更新（不落盘，下次更新时写入）。
pub(crate) fn effective_provenance(skill: &InstalledUserSkill) -> SkillProvenance {
    if let Some(provenance) = &skill.provenance {
        return provenance.clone();
    }
    skill
        .source_url
        .as_deref()
        .and_then(infer_github_provenance)
        .unwrap_or_default()
}

fn infer_github_provenance(url: &str) -> Option<SkillProvenance> {
    let rest = url.strip_prefix("https://github.com/")?;
    let segments: Vec<&str> = rest.trim_end_matches('/').split('/').collect();
    if segments.len() < 4 || segments[2] != "tree" {
        return None;
    }
    let repo = SkillRepoFetcher::parse_repo(&format!("{}/{}", segments[0], segments[1])).ok()?;
    Some(SkillProvenance {
        kind: SkillSourceKind::Github,
        repo: Some(repo.slug()),
        path: Some(segments[4..].join("/")),
        ..Default::default()
    })
}

pub(crate) fn edited_state(provenance: &SkillProvenance, content_dir: &Path) -> SkillEditedState {
    if provenance.kind == SkillSourceKind::Folder {
        return SkillEditedState::No;
    }
    let Some(expected) = provenance.tree_hash.as_deref() else {
        return SkillEditedState::Unknown;
    };
    match fs_ops::tree_hash(content_dir) {
        Ok(actual) if actual == expected => SkillEditedState::No,
        Ok(_) => SkillEditedState::Yes,
        Err(_) => SkillEditedState::Unknown,
    }
}

fn normalize_git_url(url: &str) -> String {
    url.trim()
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .to_ascii_lowercase()
}

/// 「同来源」的判据：来源种类 + 仓库 + 仓库内目录（不含 ref）。
pub(crate) fn source_identity(provenance: &SkillProvenance) -> Option<String> {
    let path = provenance
        .path
        .as_deref()
        .unwrap_or_default()
        .trim_matches('/');
    match provenance.kind {
        SkillSourceKind::Github => Some(format!(
            "github:{}:{}",
            provenance.repo.as_deref()?.to_ascii_lowercase(),
            path
        )),
        SkillSourceKind::Git => Some(format!(
            "git:{}:{}",
            normalize_git_url(provenance.repo.as_deref()?),
            path
        )),
        SkillSourceKind::Folder => Some(format!(
            "folder:{}",
            provenance
                .linked_path
                .as_deref()?
                .trim_end_matches(['/', '\\'])
        )),
        SkillSourceKind::Imported => {
            Some(format!("imported:{}", provenance.imported_from.as_deref()?))
        }
        SkillSourceKind::Unknown => None,
    }
}

/// 技能名 → id：小写字母数字，其余字符折成 `-`。
pub(crate) fn slugify(name: &str) -> String {
    let mut slug = String::new();
    for ch in name.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' {
            slug.push(ch.to_ascii_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug
        .trim_matches(|ch| ch == '-' || ch == '.')
        .chars()
        .take(80)
        .collect();
    let slug = slug.replace("..", ".");
    if slug.is_empty() || UserSkillService::validate_skill_id(&slug).is_err() {
        "skill".to_string()
    } else {
        slug
    }
}

/// 不重名就用名字；与其他来源重名时为 `<name>-<owner>`，仍重名再追加序号。
pub(crate) fn unique_id(name: &str, owner: &str, taken: &HashSet<String>) -> String {
    let base = slugify(name);
    if !taken.contains(&base) {
        return base;
    }
    let owned = slugify(&format!("{}-{}", base, owner));
    if !taken.contains(&owned) {
        return owned;
    }
    (2..)
        .map(|index| format!("{}-{}", owned, index))
        .find(|candidate| !taken.contains(candidate))
        .unwrap_or(owned)
}
