use super::skill_market_catalog::SkillMarketCatalog;
use super::skill_repo_fetcher::{RepoListing, RepoRef, SkillRepoFetcher};
use crate::utils::{AppError, AppResult};
use cc_panes_core::services::{
    parse_skill_metadata, skill_frontmatter_field, InstalledUserSkill, UserSkillService,
};
use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tracing::{debug, info, warn};

const DEFAULT_SKILL_MARKET_INDEX_URL: &str =
    "https://raw.githubusercontent.com/wuxiran/cc-panes/main/skill-market/index.json";

/// The curated index shipped with this build. Always merged underneath the remote index so a
/// fresh install (or an offline one) still has a populated market; the remote copy can add or
/// override entries without a release.
const EMBEDDED_SKILL_MARKET_INDEX: &str = include_str!("../../../skill-market/index.json");

/// Hard limits for repository installs; a skill is instructions plus a few helpers, not a
/// vendored application. Anything larger is almost certainly the wrong directory.
const MAX_REPO_SKILL_FILES: usize = 300;
const MAX_REPO_SKILL_TOTAL_BYTES: u64 = 30 * 1024 * 1024;
const MAX_REPO_SKILL_FILE_BYTES: u64 = 8 * 1024 * 1024;
const REPO_DOWNLOAD_CONCURRENCY: usize = 6;

pub const SKILL_SOURCE_CURATED: &str = "curated";
pub const SKILL_SOURCE_ANTHROPICS: &str = "anthropics";
pub const SKILL_SOURCE_SKILLS_SH: &str = "skills-sh";

fn default_source() -> String {
    SKILL_SOURCE_CURATED.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillMarketEntry {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage_url: Option<String>,
    /// Single-file skill: direct URL of the SKILL.md (requires `sha256`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default)]
    pub recommended: bool,
    /// Where the entry came from: `curated` (our index), `anthropics`, `skills-sh`.
    #[serde(default = "default_source")]
    pub source: String,
    /// Directory skill: GitHub `owner/repo` hosting the skill folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// Directory skill: folder inside the repository (empty = repository root).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_ref: Option<String>,
    /// Shown in the market's featured strip.
    #[serde(default)]
    pub featured: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installs: Option<u64>,
}

impl Default for SkillMarketEntry {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            description: None,
            category: None,
            tags: Vec::new(),
            version: "latest".to_string(),
            license: None,
            homepage_url: None,
            content_url: None,
            sha256: None,
            recommended: false,
            source: default_source(),
            repo: None,
            path: None,
            git_ref: None,
            featured: false,
            installs: None,
        }
    }
}

impl SkillMarketEntry {
    pub fn is_repo_skill(&self) -> bool {
        self.repo
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
    }

    /// Name of the skill folder inside its repository, used to locate `SKILL.md`.
    pub fn repo_skill_leaf(&self) -> String {
        self.path
            .as_deref()
            .map(|value| value.trim_matches('/'))
            .filter(|value| !value.is_empty())
            .and_then(|value| value.rsplit('/').next())
            .unwrap_or(self.name.as_str())
            .to_string()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillMarketIndex {
    #[serde(default = "default_schema_version")]
    schema_version: u32,
    #[serde(default, alias = "skills")]
    entries: Vec<SkillMarketEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum SkillMarketIndexPayload {
    Index(SkillMarketIndex),
    Entries(Vec<SkillMarketEntry>),
}

pub struct SkillMarketService {
    index_url: String,
    cache_path: PathBuf,
    user_skill_service: UserSkillService,
    client: reqwest::Client,
    fetcher: Arc<SkillRepoFetcher>,
    catalog: SkillMarketCatalog,
}

impl SkillMarketService {
    pub fn new(skills_dir: PathBuf, user_skills_dir: PathBuf) -> Self {
        let index_url = std::env::var("CCPANES_SKILL_MARKET_INDEX_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_SKILL_MARKET_INDEX_URL.to_string());
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let fetcher = Arc::new(SkillRepoFetcher::new(client.clone()));
        let catalog = SkillMarketCatalog::new(client.clone(), fetcher.clone(), &skills_dir);
        Self {
            index_url,
            cache_path: skills_dir.join("market-index-cache.json"),
            user_skill_service: UserSkillService::new(user_skills_dir),
            client,
            fetcher,
            catalog,
        }
    }

    /// Curated index only (our `skill-market/index.json`), with disk-cache fallback.
    pub async fn list_market_entries(&self) -> AppResult<Vec<SkillMarketEntry>> {
        let remote = match self.fetch_index().await {
            Ok(index) => {
                self.write_cache(&index)?;
                index.entries
            }
            Err(error) => {
                warn!("[skill_market] Failed to fetch market index: {}", error);
                match self.read_cache() {
                    Ok(Some(index)) => index.entries,
                    Ok(None) => Vec::new(),
                    Err(cache_error) => return Err(cache_error),
                }
            }
        };
        Ok(Self::sorted_entries(SkillMarketCatalog::merge(
            remote,
            Self::embedded_entries(),
        )))
    }

    fn embedded_entries() -> Vec<SkillMarketEntry> {
        match Self::parse_index(EMBEDDED_SKILL_MARKET_INDEX) {
            Ok(index) => index.entries,
            Err(error) => {
                warn!("[skill_market] embedded index is invalid: {}", error);
                Vec::new()
            }
        }
    }

    /// Full browsable catalog: curated index merged with auto-discovered upstream
    /// repositories. Curated entries win on id collisions so we can override upstream metadata.
    pub async fn list_catalog(&self, refresh: bool) -> AppResult<Vec<SkillMarketEntry>> {
        let mut curated = self.list_market_entries().await?;
        for entry in &mut curated {
            let category =
                super::skill_market_catalog::normalize_category(entry.category.as_deref(), entry);
            entry.category = Some(category);
        }
        let discovered = self.catalog.discovered_entries(refresh).await;
        Ok(Self::sorted_entries(SkillMarketCatalog::merge(
            curated, discovered,
        )))
    }

    /// Local catalog filter plus a live skills.sh query, deduplicated against the catalog.
    pub async fn search(&self, query: &str) -> AppResult<Vec<SkillMarketEntry>> {
        let query = query.trim();
        let catalog = self.list_catalog(false).await?;
        if query.is_empty() {
            return Ok(catalog);
        }
        let local = SkillMarketCatalog::filter_local(&catalog, query);
        let remote = match self.catalog.search_skills_sh(query).await {
            Ok(entries) => entries,
            Err(error) => {
                warn!("[skill_market] skills.sh search failed: {}", error);
                Vec::new()
            }
        };
        Ok(SkillMarketCatalog::merge(local, remote))
    }

    /// Fill in `description` (and resolve `path`) for entries that arrived without one.
    pub async fn describe(&self, entry: SkillMarketEntry) -> AppResult<SkillMarketEntry> {
        self.catalog.describe(entry).await
    }

    pub fn list_user_skills(&self) -> AppResult<Vec<InstalledUserSkill>> {
        self.user_skill_service.list_skills()
    }

    pub async fn install_market_skill(&self, skill_id: &str) -> AppResult<InstalledUserSkill> {
        UserSkillService::validate_skill_id(skill_id)?;
        let catalog = self.list_catalog(false).await?;
        let entry = catalog
            .into_iter()
            .find(|entry| entry.id == skill_id)
            .ok_or_else(|| {
                AppError::from(format!("Skill '{}' was not found in the market", skill_id))
            })?;
        self.install_entry(entry).await
    }

    /// Install a market entry the UI already holds (search results are not part of the
    /// cached catalog, so the caller passes the whole entry).
    pub async fn install_entry(&self, entry: SkillMarketEntry) -> AppResult<InstalledUserSkill> {
        if entry.is_repo_skill() {
            return self.install_from_repo(entry).await;
        }
        Self::validate_installable_entry(&entry)?;

        let content_url = entry.content_url.as_deref().unwrap_or_default();
        let content = self
            .client
            .get(content_url)
            .send()
            .await
            .map_err(|err| AppError::from(format!("Failed to download skill: {}", err)))?
            .error_for_status()
            .map_err(|err| AppError::from(format!("Failed to download skill: {}", err)))?
            .text()
            .await
            .map_err(|err| AppError::from(format!("Failed to read skill content: {}", err)))?;
        if content.trim().is_empty() {
            return Err(AppError::from("Downloaded skill content is empty"));
        }

        let actual_sha = hex_sha256(&content);
        let expected_sha = entry.sha256.as_deref().unwrap_or_default();
        if !actual_sha.eq_ignore_ascii_case(expected_sha) {
            return Err(AppError::from(format!(
                "Skill checksum mismatch: expected {}, got {}",
                expected_sha, actual_sha
            )));
        }

        let installed = InstalledUserSkill {
            id: entry.id,
            name: entry.name,
            description: entry.description,
            category: entry.category,
            tags: entry.tags,
            version: entry.version,
            license: entry.license,
            homepage_url: entry.homepage_url,
            source_url: entry.content_url,
            content_sha256: actual_sha,
            installed_at: chrono::Utc::now().to_rfc3339(),
            file_path: None,
        };
        self.user_skill_service.write_skill(&installed, &content)?;
        self.user_skill_service
            .read_skill(&installed.id)?
            .map(|content| content.skill)
            .ok_or_else(|| AppError::from("Installed skill could not be read back"))
    }

    /// Download a whole skill folder (`SKILL.md` + scripts/references/assets) into the user
    /// skills directory. Files land in a staging folder first so a failed download never leaves
    /// a half-installed skill behind.
    async fn install_from_repo(&self, entry: SkillMarketEntry) -> AppResult<InstalledUserSkill> {
        UserSkillService::validate_skill_id(&entry.id)?;
        if entry.name.trim().is_empty() {
            return Err(AppError::from("Market skill name cannot be empty"));
        }
        let repo = SkillRepoFetcher::parse_repo(entry.repo.as_deref().unwrap_or_default())?;
        let listing = self
            .fetcher
            .list_files(&repo, entry.git_ref.as_deref())
            .await?;
        let leaf = entry.repo_skill_leaf();
        let skill_dir = listing
            .locate_skill_dir(entry.path.as_deref(), &leaf)
            .or_else(|| listing.locate_skill_dir(None, &entry.id))
            .ok_or_else(|| {
                AppError::from(format!(
                    "Could not find {}/SKILL.md in {}",
                    leaf,
                    repo.slug()
                ))
            })?;
        let files = Self::select_repo_files(&listing, &skill_dir)?;

        let root = self.user_skill_service.user_skills_dir().to_path_buf();
        let staging = root.join(format!(".staging-{}", entry.id));
        let _ = std::fs::remove_dir_all(&staging);
        std::fs::create_dir_all(&staging)?;

        let download = self
            .download_repo_files(&repo, &listing, &skill_dir, &files, &staging)
            .await;
        let skill_md = match download {
            Ok(skill_md) => skill_md,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(error);
            }
        };

        let target = UserSkillService::skill_dir_for(&root, &entry.id)?;
        if target.exists() {
            std::fs::remove_dir_all(&target)?;
        }
        std::fs::rename(&staging, &target)?;

        let (parsed_name, parsed_description) = parse_skill_metadata(&skill_md, &leaf);
        let license = entry
            .license
            .clone()
            .or_else(|| skill_frontmatter_field(&skill_md, "license"));
        let short_ref: String = listing.git_ref.chars().take(12).collect();
        let source_url = if skill_dir.is_empty() {
            format!("{}/tree/{}", repo.homepage(), listing.git_ref)
        } else {
            format!("{}/tree/{}/{}", repo.homepage(), listing.git_ref, skill_dir)
        };
        let installed = InstalledUserSkill {
            id: entry.id.clone(),
            name: if entry.name.trim().is_empty() {
                parsed_name
            } else {
                entry.name.clone()
            },
            description: entry.description.clone().or(parsed_description),
            category: entry.category.clone(),
            tags: entry.tags.clone(),
            version: if entry.version.trim().is_empty() || entry.version == "latest" {
                short_ref
            } else {
                entry.version.clone()
            },
            license,
            homepage_url: entry.homepage_url.clone().or_else(|| Some(repo.homepage())),
            source_url: Some(source_url),
            content_sha256: hex_sha256(&skill_md),
            installed_at: chrono::Utc::now().to_rfc3339(),
            file_path: None,
        };
        self.user_skill_service.write_skill(&installed, &skill_md)?;
        info!(
            "[skill_market] installed repo skill id={} repo={} dir={} files={}",
            entry.id,
            repo.slug(),
            skill_dir,
            files.len()
        );
        self.user_skill_service
            .read_skill(&installed.id)?
            .map(|content| content.skill)
            .ok_or_else(|| AppError::from("Installed skill could not be read back"))
    }

    /// Pick the files to download for a skill folder, enforcing size/count limits. Oversized
    /// helper files are skipped with a warning; an oversized or missing SKILL.md is fatal.
    fn select_repo_files(listing: &RepoListing, skill_dir: &str) -> AppResult<Vec<String>> {
        let candidates: Vec<(&str, Option<u64>)> = if skill_dir.is_empty() {
            listing
                .files
                .iter()
                .map(|file| (file.path.as_str(), file.size))
                .collect()
        } else {
            listing
                .files_under(skill_dir)
                .into_iter()
                .map(|file| (file.path.as_str(), file.size))
                .collect()
        };
        let skill_md_path = if skill_dir.is_empty() {
            "SKILL.md".to_string()
        } else {
            format!("{}/SKILL.md", skill_dir)
        };
        if !candidates.iter().any(|(path, _)| *path == skill_md_path) {
            return Err(AppError::from(format!("{} does not exist", skill_md_path)));
        }

        let mut selected = Vec::new();
        let mut total: u64 = 0;
        for (path, size) in candidates {
            if path.split('/').any(|segment| segment == ".git") {
                continue;
            }
            let size = size.unwrap_or(0);
            if size > MAX_REPO_SKILL_FILE_BYTES {
                if path == skill_md_path {
                    return Err(AppError::from("SKILL.md is unreasonably large"));
                }
                warn!(
                    "[skill_market] skipping oversized skill file {} ({} bytes)",
                    path, size
                );
                continue;
            }
            if selected.len() >= MAX_REPO_SKILL_FILES {
                return Err(AppError::from(format!(
                    "Skill folder has more than {} files; refusing to install",
                    MAX_REPO_SKILL_FILES
                )));
            }
            total += size;
            if total > MAX_REPO_SKILL_TOTAL_BYTES {
                return Err(AppError::from(format!(
                    "Skill folder exceeds {} MB; refusing to install",
                    MAX_REPO_SKILL_TOTAL_BYTES / (1024 * 1024)
                )));
            }
            selected.push(path.to_string());
        }
        Ok(selected)
    }

    /// Download `files` into `staging`, preserving the layout relative to `skill_dir`.
    /// Returns the SKILL.md text.
    async fn download_repo_files(
        &self,
        repo: &RepoRef,
        listing: &RepoListing,
        skill_dir: &str,
        files: &[String],
        staging: &Path,
    ) -> AppResult<String> {
        let prefix = if skill_dir.is_empty() {
            String::new()
        } else {
            format!("{}/", skill_dir)
        };
        let results: Vec<AppResult<(String, Vec<u8>)>> = stream::iter(files.iter().cloned())
            .map(|path| async move {
                let bytes = self.fetcher.fetch_bytes(repo, listing, &path).await?;
                Ok((path, bytes))
            })
            .buffer_unordered(REPO_DOWNLOAD_CONCURRENCY)
            .collect()
            .await;

        let mut skill_md = None;
        for result in results {
            let (path, bytes) = result?;
            let relative = path.strip_prefix(&prefix).unwrap_or(&path);
            if !SkillRepoFetcher::is_safe_relative_path(relative) {
                return Err(AppError::from(format!(
                    "Refusing unsafe skill path '{}'",
                    relative
                )));
            }
            let destination = staging.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent)?;
            }
            if relative == "SKILL.md" {
                let text = String::from_utf8(bytes.clone())
                    .map_err(|_| AppError::from("SKILL.md is not valid UTF-8"))?;
                if text.trim().is_empty() {
                    return Err(AppError::from("Downloaded SKILL.md is empty"));
                }
                skill_md = Some(text);
            }
            std::fs::write(&destination, bytes)?;
        }
        skill_md.ok_or_else(|| AppError::from("SKILL.md was not downloaded"))
    }

    pub fn remove_user_skill(&self, skill_id: &str) -> AppResult<bool> {
        self.user_skill_service.remove_skill(skill_id)
    }

    async fn fetch_index(&self) -> AppResult<SkillMarketIndex> {
        debug!(
            "[skill_market] fetching curated index from {}",
            self.index_url
        );
        let text = self
            .client
            .get(&self.index_url)
            .send()
            .await
            .map_err(|err| AppError::from(format!("Failed to fetch skill market index: {}", err)))?
            .error_for_status()
            .map_err(|err| AppError::from(format!("Failed to fetch skill market index: {}", err)))?
            .text()
            .await
            .map_err(|err| AppError::from(format!("Failed to read skill market index: {}", err)))?;
        Self::parse_index(&text)
    }

    fn parse_index(content: &str) -> AppResult<SkillMarketIndex> {
        let payload: SkillMarketIndexPayload = serde_json::from_str(content)
            .map_err(|err| AppError::from(format!("Invalid skill market index: {}", err)))?;
        let index = match payload {
            SkillMarketIndexPayload::Index(index) => index,
            SkillMarketIndexPayload::Entries(entries) => SkillMarketIndex {
                schema_version: default_schema_version(),
                entries,
            },
        };
        Ok(index)
    }

    fn read_cache(&self) -> AppResult<Option<SkillMarketIndex>> {
        if !self.cache_path.is_file() {
            return Ok(None);
        }
        let content = std::fs::read_to_string(&self.cache_path)?;
        Self::parse_index(&content).map(Some)
    }

    fn write_cache(&self, index: &SkillMarketIndex) -> AppResult<()> {
        if let Some(parent) = self.cache_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = serde_json::to_string_pretty(index).map_err(|err| {
            AppError::from(format!("Failed to serialize skill market cache: {}", err))
        })?;
        std::fs::write(&self.cache_path, content)?;
        Ok(())
    }

    fn validate_installable_entry(entry: &SkillMarketEntry) -> AppResult<()> {
        UserSkillService::validate_skill_id(&entry.id)?;
        if entry.name.trim().is_empty() {
            return Err(AppError::from("Market skill name cannot be empty"));
        }
        if entry.version.trim().is_empty() {
            return Err(AppError::from("Market skill version cannot be empty"));
        }
        for (label, value) in [
            ("license", entry.license.as_deref()),
            ("contentUrl", entry.content_url.as_deref()),
            ("sha256", entry.sha256.as_deref()),
        ] {
            if value
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_none()
            {
                return Err(AppError::from(format!(
                    "Market skill '{}' is missing {}",
                    entry.id, label
                )));
            }
        }
        Ok(())
    }

    fn sorted_entries(mut entries: Vec<SkillMarketEntry>) -> Vec<SkillMarketEntry> {
        entries.sort_by(|left, right| {
            right
                .recommended
                .cmp(&left.recommended)
                .then_with(|| {
                    left.category
                        .as_deref()
                        .unwrap_or_default()
                        .cmp(right.category.as_deref().unwrap_or_default())
                })
                .then_with(|| {
                    left.name
                        .to_ascii_lowercase()
                        .cmp(&right.name.to_ascii_lowercase())
                })
        });
        entries
    }
}

fn default_schema_version() -> u32 {
    1
}

fn hex_sha256(content: &str) -> String {
    let digest = Sha256::digest(content.as_bytes());
    digest.iter().map(|byte| format!("{:02x}", byte)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// 串行化对 CCPANES_SKILL_MARKET_INDEX_URL 环境变量的读写，避免并行测试互踩
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    const ENV_URL: &str = "CCPANES_SKILL_MARKET_INDEX_URL";

    fn entry(id: &str, name: &str) -> SkillMarketEntry {
        SkillMarketEntry {
            id: id.to_string(),
            name: name.to_string(),
            version: "1.0.0".to_string(),
            license: Some("MIT".to_string()),
            content_url: Some("https://example.com/skill.md".to_string()),
            sha256: Some("deadbeef".to_string()),
            ..SkillMarketEntry::default()
        }
    }

    fn repo_listing(paths: &[(&str, u64)]) -> RepoListing {
        RepoListing {
            git_ref: "0123456789abcdef".to_string(),
            via_mirror: false,
            files: paths
                .iter()
                .map(|(path, size)| super::super::skill_repo_fetcher::RepoFile {
                    path: path.to_string(),
                    size: Some(*size),
                })
                .collect(),
        }
    }

    // ── repo skill helpers ──

    #[test]
    fn repo_skill_leaf_prefers_path_then_name() {
        let mut entry = SkillMarketEntry {
            name: "pdf".to_string(),
            repo: Some("anthropics/skills".to_string()),
            path: Some("skills/pdf-tools/".to_string()),
            ..SkillMarketEntry::default()
        };
        assert!(entry.is_repo_skill());
        assert_eq!(entry.repo_skill_leaf(), "pdf-tools");
        entry.path = None;
        assert_eq!(entry.repo_skill_leaf(), "pdf");
        entry.repo = Some("  ".to_string());
        assert!(!entry.is_repo_skill());
    }

    #[test]
    fn select_repo_files_requires_skill_md_and_skips_oversized_helpers() {
        let listing = repo_listing(&[
            ("skills/pdf/SKILL.md", 10),
            ("skills/pdf/scripts/a.py", 20),
            ("skills/pdf/assets/huge.bin", MAX_REPO_SKILL_FILE_BYTES + 1),
            ("skills/pdf/.git/config", 5),
            ("skills/other/SKILL.md", 10),
        ]);
        let files = SkillMarketService::select_repo_files(&listing, "skills/pdf").unwrap();
        assert_eq!(
            files,
            vec!["skills/pdf/SKILL.md", "skills/pdf/scripts/a.py"]
        );

        assert!(SkillMarketService::select_repo_files(&listing, "skills/missing").is_err());

        let root = repo_listing(&[("SKILL.md", 10), ("README.md", 5)]);
        let files = SkillMarketService::select_repo_files(&root, "").unwrap();
        assert_eq!(files, vec!["SKILL.md", "README.md"]);
    }

    #[test]
    fn select_repo_files_rejects_folders_over_total_budget() {
        let big = MAX_REPO_SKILL_FILE_BYTES;
        let listing = repo_listing(&[
            ("s/SKILL.md", 10),
            ("s/a.bin", big),
            ("s/b.bin", big),
            ("s/c.bin", big),
            ("s/d.bin", big),
        ]);
        let err = SkillMarketService::select_repo_files(&listing, "s").unwrap_err();
        assert!(err.to_string().contains("exceeds"), "unexpected: {}", err);
    }

    #[test]
    fn entry_deserializes_legacy_index_rows_with_defaults() {
        let json = r#"{"id": "x", "name": "X", "version": "1"}"#;
        let entry: SkillMarketEntry = serde_json::from_str(json).unwrap();
        assert_eq!(entry.source, SKILL_SOURCE_CURATED);
        assert!(!entry.featured);
        assert!(entry.repo.is_none());
        assert!(!entry.is_repo_skill());
    }

    fn service_with_dirs() -> (tempfile::TempDir, SkillMarketService) {
        let temp = tempfile::tempdir().expect("tempdir");
        let skills_dir = temp.path().join("skills");
        let user_skills_dir = temp.path().join("user-skills");
        let service = SkillMarketService::new(skills_dir, user_skills_dir);
        (temp, service)
    }

    // ── parse_index ──

    #[test]
    fn parse_index_accepts_object_form_with_entries() {
        let json = r#"{"schemaVersion": 2, "entries": [
            {"id": "skill-a", "name": "Skill A", "version": "1.0.0"}
        ]}"#;
        let index = SkillMarketService::parse_index(json).expect("parse");
        assert_eq!(index.schema_version, 2);
        assert_eq!(index.entries.len(), 1);
        assert_eq!(index.entries[0].id, "skill-a");
    }

    #[test]
    fn parse_index_accepts_skills_alias_and_defaults_schema_version() {
        let json = r#"{"skills": [{"id": "skill-b", "name": "Skill B", "version": "0.1.0"}]}"#;
        let index = SkillMarketService::parse_index(json).expect("parse");
        assert_eq!(index.schema_version, 1);
        assert_eq!(index.entries.len(), 1);
        assert_eq!(index.entries[0].name, "Skill B");
    }

    #[test]
    fn parse_index_accepts_bare_entry_array() {
        let json =
            r#"[{"id": "skill-c", "name": "Skill C", "version": "2.0.0", "recommended": true}]"#;
        let index = SkillMarketService::parse_index(json).expect("parse");
        assert_eq!(index.schema_version, 1);
        assert_eq!(index.entries.len(), 1);
        assert!(index.entries[0].recommended);
    }

    #[test]
    fn parse_index_rejects_invalid_json_and_missing_required_fields() {
        assert!(SkillMarketService::parse_index("not json").is_err());
        // 缺少必填 name 字段：两个 untagged 变体都不匹配
        assert!(SkillMarketService::parse_index(r#"[{"id": "x"}]"#).is_err());
    }

    // ── sorted_entries ──

    #[test]
    fn sorted_entries_orders_by_recommended_category_then_name() {
        let mut zeta = entry("zeta", "Zeta");
        zeta.category = Some("tools".to_string());
        let mut alpha = entry("alpha", "alpha");
        alpha.category = Some("tools".to_string());
        let mut promoted = entry("promoted", "Promoted");
        promoted.recommended = true;
        promoted.category = Some("zz-last".to_string());
        let mut early_cat = entry("early", "Early");
        early_cat.category = Some("aaa".to_string());

        let sorted = SkillMarketService::sorted_entries(vec![
            zeta.clone(),
            alpha.clone(),
            early_cat.clone(),
            promoted.clone(),
        ]);
        let ids: Vec<_> = sorted.iter().map(|e| e.id.as_str()).collect();
        // recommended 优先；其余按 category 升序，同 category 按名称（忽略大小写）
        assert_eq!(ids, vec!["promoted", "early", "alpha", "zeta"]);
    }

    // ── validate_installable_entry ──

    #[test]
    fn validate_installable_entry_accepts_complete_entry() {
        assert!(SkillMarketService::validate_installable_entry(&entry("ok-skill", "OK")).is_ok());
    }

    #[test]
    fn validate_installable_entry_rejects_blank_name_and_version() {
        let mut blank_name = entry("skill-x", "   ");
        blank_name.name = "   ".to_string();
        let err = SkillMarketService::validate_installable_entry(&blank_name).unwrap_err();
        assert!(err.to_string().contains("name"), "unexpected: {}", err);

        let mut blank_version = entry("skill-x", "Skill X");
        blank_version.version = String::new();
        let err = SkillMarketService::validate_installable_entry(&blank_version).unwrap_err();
        assert!(err.to_string().contains("version"), "unexpected: {}", err);
    }

    #[test]
    fn validate_installable_entry_requires_license_content_url_and_sha256() {
        for (label, mutate) in [
            (
                "license",
                Box::new(|e: &mut SkillMarketEntry| e.license = None)
                    as Box<dyn Fn(&mut SkillMarketEntry)>,
            ),
            (
                "contentUrl",
                Box::new(|e: &mut SkillMarketEntry| e.content_url = Some("   ".to_string())),
            ),
            (
                "sha256",
                Box::new(|e: &mut SkillMarketEntry| e.sha256 = None),
            ),
        ] {
            let mut candidate = entry("skill-y", "Skill Y");
            mutate(&mut candidate);
            let err = SkillMarketService::validate_installable_entry(&candidate).unwrap_err();
            assert!(
                err.to_string().contains(label),
                "expected '{}' in: {}",
                label,
                err
            );
        }
    }

    #[test]
    fn validate_installable_entry_rejects_invalid_skill_id() {
        assert!(SkillMarketService::validate_installable_entry(&entry("../evil", "Evil")).is_err());
        assert!(SkillMarketService::validate_installable_entry(&entry("bad id!", "Bad")).is_err());
    }

    // ── hex_sha256 / default_schema_version ──

    #[test]
    fn hex_sha256_matches_known_vectors() {
        assert_eq!(
            hex_sha256("hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert_eq!(
            hex_sha256(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn default_schema_version_is_one() {
        assert_eq!(default_schema_version(), 1);
    }

    // ── 缓存读写 ──

    #[test]
    fn read_cache_returns_none_when_file_missing() {
        let (_temp, service) = service_with_dirs();
        assert!(service.read_cache().expect("read").is_none());
    }

    #[test]
    fn write_cache_then_read_cache_roundtrips_entries() {
        let (_temp, service) = service_with_dirs();
        let index = SkillMarketIndex {
            schema_version: 3,
            entries: vec![entry("cached-skill", "Cached")],
        };
        service.write_cache(&index).expect("write");

        let loaded = service.read_cache().expect("read").expect("cache present");
        assert_eq!(loaded.schema_version, 3);
        assert_eq!(loaded.entries, vec![entry("cached-skill", "Cached")]);
    }

    #[test]
    fn read_cache_errors_on_corrupted_file() {
        let (_temp, service) = service_with_dirs();
        std::fs::create_dir_all(service.cache_path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&service.cache_path, "{{{ not json").expect("write");
        assert!(service.read_cache().is_err());
    }

    // ── new() 环境变量覆盖 ──

    #[test]
    fn new_uses_default_url_and_honors_env_override() {
        let _guard = ENV_LOCK.lock().unwrap();
        let original = std::env::var(ENV_URL).ok();

        std::env::remove_var(ENV_URL);
        let (_t1, service) = service_with_dirs();
        assert_eq!(service.index_url, DEFAULT_SKILL_MARKET_INDEX_URL);

        std::env::set_var(ENV_URL, "https://example.com/custom-index.json");
        let (_t2, service) = service_with_dirs();
        assert_eq!(service.index_url, "https://example.com/custom-index.json");

        // 空白值视为未设置
        std::env::set_var(ENV_URL, "   ");
        let (_t3, service) = service_with_dirs();
        assert_eq!(service.index_url, DEFAULT_SKILL_MARKET_INDEX_URL);

        match original {
            Some(value) => std::env::set_var(ENV_URL, value),
            None => std::env::remove_var(ENV_URL),
        }
    }

    // ── list_market_entries 网络失败回退 ──

    #[tokio::test(flavor = "multi_thread")]
    async fn list_market_entries_falls_back_to_cache_when_fetch_fails() {
        let (_temp, service) = {
            let _guard = ENV_LOCK.lock().unwrap();
            let original = std::env::var(ENV_URL).ok();
            // 127.0.0.1:9（discard 端口）本地无监听，连接立即被拒绝
            std::env::set_var(ENV_URL, "http://127.0.0.1:9/index.json");
            let pair = service_with_dirs();
            match original {
                Some(value) => std::env::set_var(ENV_URL, value),
                None => std::env::remove_var(ENV_URL),
            }
            pair
        };

        let mut recommended = entry("rec-skill", "Rec");
        recommended.recommended = true;
        let index = SkillMarketIndex {
            schema_version: 1,
            entries: vec![entry("plain-skill", "Plain"), recommended],
        };
        service.write_cache(&index).expect("write cache");

        let entries = service.list_market_entries().await.expect("list");
        let ids: Vec<_> = entries.iter().map(|e| e.id.as_str()).collect();
        // 缓存条目优先于内置基线；recommended 的排在前面
        assert_eq!(ids[0], "rec-skill");
        let plain = ids
            .iter()
            .position(|id| *id == "plain-skill")
            .expect("plain present");
        let embedded = ids
            .iter()
            .position(|id| *id == "tdd")
            .expect("embedded present");
        assert!(
            embedded < plain,
            "embedded recommended entries sort before plain cached ones"
        );
    }

    /// Live network smoke test: `cargo test -p cc-panes --lib -- --ignored live_install`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "hits GitHub / jsDelivr"]
    async fn live_install_anthropics_pdf_skill_end_to_end() {
        let (_temp, service) = service_with_dirs();
        let entry = SkillMarketEntry {
            id: "pdf".to_string(),
            name: "pdf".to_string(),
            repo: Some("anthropics/skills".to_string()),
            path: Some("skills/pdf".to_string()),
            source: SKILL_SOURCE_ANTHROPICS.to_string(),
            ..SkillMarketEntry::default()
        };
        let installed = service.install_entry(entry).await.expect("install");
        assert_eq!(installed.id, "pdf");
        assert!(installed.description.is_some());
        let dir = service.user_skill_service.user_skills_dir().join("pdf");
        assert!(dir.join("SKILL.md").is_file());
        assert!(dir.join("skill.json").is_file());
        // pdf 技能带 scripts/ 与 reference 文件，目录型安装必须把它们一起落盘
        assert!(dir.join("scripts").is_dir(), "scripts folder missing");
        assert!(
            std::fs::read_dir(&dir).unwrap().count() > 2,
            "expected more than SKILL.md + skill.json"
        );
        let catalog = service.list_catalog(false).await.expect("catalog");
        assert!(catalog
            .iter()
            .any(|entry| entry.source == SKILL_SOURCE_ANTHROPICS));
        let hits = service.search("obsidian").await.expect("search");
        assert!(hits
            .iter()
            .any(|entry| entry.source == SKILL_SOURCE_SKILLS_SH));
        let described = service
            .describe(
                hits.into_iter()
                    .find(|e| e.source == SKILL_SOURCE_SKILLS_SH)
                    .unwrap(),
            )
            .await
            .expect("describe");
        assert!(described.description.is_some());
    }

    #[test]
    fn embedded_index_is_valid_and_fully_installable() {
        let entries = SkillMarketService::embedded_entries();
        assert!(entries.len() >= 30, "expected a populated curated index");
        let mut seen = std::collections::HashSet::new();
        for entry in &entries {
            assert!(seen.insert(entry.id.clone()), "duplicate id {}", entry.id);
            UserSkillService::validate_skill_id(&entry.id).expect("valid id");
            assert!(
                entry.is_repo_skill(),
                "{} must point at a repository",
                entry.id
            );
            assert!(
                SkillRepoFetcher::parse_repo(entry.repo.as_deref().unwrap()).is_ok(),
                "{} has an invalid repo",
                entry.id
            );
            assert!(
                entry
                    .description
                    .as_deref()
                    .is_some_and(|d| !d.trim().is_empty()),
                "{} needs a description",
                entry.id
            );
            let category = entry.category.as_deref().expect("category");
            assert!(
                super::super::skill_market_catalog::CATEGORY_IDS.contains(&category),
                "{} has unknown category {}",
                entry.id,
                category
            );
        }
        assert!(
            entries.iter().any(|entry| entry.featured),
            "some entries should be featured"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn list_market_entries_returns_empty_when_fetch_fails_and_no_cache() {
        let (_temp, service) = {
            let _guard = ENV_LOCK.lock().unwrap();
            let original = std::env::var(ENV_URL).ok();
            std::env::set_var(ENV_URL, "http://127.0.0.1:9/index.json");
            let pair = service_with_dirs();
            match original {
                Some(value) => std::env::set_var(ENV_URL, value),
                None => std::env::remove_var(ENV_URL),
            }
            pair
        };

        let entries = service.list_market_entries().await.expect("list");
        // 无网络也无缓存时仍有内置基线可用
        assert_eq!(entries.len(), SkillMarketService::embedded_entries().len());
        assert!(entries
            .iter()
            .all(|entry| entry.source == SKILL_SOURCE_CURATED));
    }
}
