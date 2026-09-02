//! Aggregated skill catalog behind the market page.
//!
//! Three sources feed the same `SkillMarketEntry` shape:
//! - the curated index (`skill-market/index.json`, handled by `SkillMarketService`);
//! - upstream repositories we auto-discover by walking their tree (today: `anthropics/skills`);
//! - live search against skills.sh, the largest community registry.
//!
//! Discovery results are cached on disk for a day; descriptions fetched lazily for search hits
//! are cached indefinitely (they are keyed by the immutable skill id).

use super::skill_market_service::{
    SkillMarketEntry, SKILL_SOURCE_ANTHROPICS, SKILL_SOURCE_SKILLS_SH,
};
use super::skill_repo_fetcher::SkillRepoFetcher;
use crate::utils::{AppError, AppResult};
use cc_panes_core::services::{parse_skill_metadata, skill_frontmatter_field};
use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::{debug, warn};

const DISCOVERY_TTL_SECS: i64 = 24 * 60 * 60;
const DISCOVERY_CONCURRENCY: usize = 6;
const SKILLS_SH_SEARCH_URL: &str = "https://skills.sh/api/search";
const SKILLS_SH_MAX_RESULTS: usize = 60;
const SKILLS_SH_TIMEOUT: Duration = Duration::from_secs(12);

struct DiscoveryRepo {
    repo: &'static str,
    dir: &'static str,
    source: &'static str,
    default_license: Option<&'static str>,
}

const DISCOVERY_REPOS: &[DiscoveryRepo] = &[DiscoveryRepo {
    repo: "anthropics/skills",
    dir: "skills",
    source: SKILL_SOURCE_ANTHROPICS,
    default_license: Some("Apache-2.0"),
}];

/// Category ids surfaced as tabs in the market page. Keep in sync with the frontend i18n keys.
pub const CATEGORY_IDS: &[&str] = &[
    "dev",
    "docs",
    "data",
    "learning",
    "agent",
    "productivity",
    "content",
    "work",
    "search",
    "design",
    "life",
    "other",
];

const CATEGORY_KEYWORDS: &[(&str, &[&str])] = &[
    (
        "docs",
        &[
            "docx",
            "pdf",
            "pptx",
            "xlsx",
            "document",
            "markdown",
            "word",
            "excel",
            "powerpoint",
            "slides",
            "spreadsheet",
            "latex",
            "文档",
            "论文",
            "写作",
            "排版",
            "公文",
        ],
    ),
    (
        "data",
        &[
            "data",
            "analysis",
            "analytics",
            "chart",
            "csv",
            "dataset",
            "statistic",
            "visualization",
            "infographic",
            "dashboard",
            "数据",
            "分析",
            "图表",
            "报表",
        ],
    ),
    (
        "learning",
        &[
            "learn",
            "study",
            "note",
            "obsidian",
            "knowledge",
            "wiki",
            "flashcard",
            "anki",
            "tutorial",
            "academy",
            "学习",
            "笔记",
            "知识",
            "教程",
        ],
    ),
    (
        "agent",
        &[
            "agent",
            "workflow",
            "orchestrat",
            "subagent",
            "skill-creator",
            "skill creator",
            "prompt",
            "planning",
            "mcp-builder",
            "智能体",
            "编排",
            "提示词",
            "工作流",
        ],
    ),
    (
        "search",
        &[
            "search",
            "research",
            "browse",
            "crawl",
            "scrape",
            "web-tasks",
            "arxiv",
            "scholar",
            "搜索",
            "研究",
            "检索",
            "调研",
            "文献",
        ],
    ),
    (
        "content",
        &[
            "blog",
            "copywriting",
            "xiaohongshu",
            "wechat",
            "script",
            "social",
            "seo",
            "marketing",
            "newsletter",
            "tweet",
            "文案",
            "公众号",
            "小红书",
            "内容",
            "创作",
            "营销",
            "短视频",
            "自媒体",
        ],
    ),
    (
        "design",
        &[
            "design",
            "ui",
            "ux",
            "canvas",
            "art",
            "theme",
            "visual",
            "image",
            "poster",
            "comic",
            "illustration",
            "logo",
            "tailwind",
            "frontend-design",
            "设计",
            "视觉",
            "海报",
            "生图",
            "配图",
            "封面",
        ],
    ),
    (
        "work",
        &[
            "brand",
            "comms",
            "internal",
            "enterprise",
            "report",
            "business",
            "resume",
            "meeting",
            "slack",
            "email",
            "工作",
            "汇报",
            "简历",
            "企业",
            "会议",
            "邮件",
            "职场",
        ],
    ),
    (
        "productivity",
        &[
            "todo",
            "task",
            "calendar",
            "schedule",
            "productivity",
            "reminder",
            "habit",
            "gtd",
            "效率",
            "任务",
            "日程",
            "待办",
            "时间管理",
        ],
    ),
    (
        "life",
        &[
            "cooking", "recipe", "travel", "health", "fitness", "game", "music", "movie", "生活",
            "旅行", "健康", "娱乐", "菜谱", "健身",
        ],
    ),
    (
        "dev",
        &[
            "code",
            "debug",
            "test",
            "refactor",
            "git",
            "api",
            "typescript",
            "python",
            "rust",
            "react",
            "frontend",
            "backend",
            "sql",
            "docker",
            "deploy",
            "ci",
            "plugin",
            "cli",
            "webapp",
            "开发",
            "代码",
            "测试",
            "编程",
            "部署",
        ],
    ),
];

#[derive(Debug, Serialize, Deserialize)]
struct DiscoveryCache {
    fetched_at: i64,
    entries: Vec<SkillMarketEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct DescribeRecord {
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    license: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SkillsShSearchResponse {
    #[serde(default)]
    skills: Vec<SkillsShHit>,
}

#[derive(Debug, Deserialize)]
struct SkillsShHit {
    #[serde(rename = "skillId")]
    skill_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    installs: Option<u64>,
    #[serde(default)]
    source: String,
}

pub struct SkillMarketCatalog {
    client: reqwest::Client,
    fetcher: Arc<SkillRepoFetcher>,
    discovery_cache_path: PathBuf,
    describe_cache_path: PathBuf,
    describe_cache: Mutex<Option<HashMap<String, DescribeRecord>>>,
}

impl SkillMarketCatalog {
    pub fn new(client: reqwest::Client, fetcher: Arc<SkillRepoFetcher>, skills_dir: &Path) -> Self {
        Self {
            client,
            fetcher,
            discovery_cache_path: skills_dir.join("market-discovered-cache.json"),
            describe_cache_path: skills_dir.join("market-describe-cache.json"),
            describe_cache: Mutex::new(None),
        }
    }

    /// Entries discovered from upstream repositories, served from the day-old disk cache when
    /// fresh enough. Network failures degrade to whatever cache exists rather than erroring: the
    /// curated index must still render when GitHub is unreachable.
    pub async fn discovered_entries(&self, refresh: bool) -> Vec<SkillMarketEntry> {
        if std::env::var("CCPANES_SKILL_MARKET_DISCOVERY")
            .map(|value| value.trim().eq_ignore_ascii_case("off"))
            .unwrap_or(false)
        {
            return Vec::new();
        }
        let cached = self.read_discovery_cache();
        let now = chrono::Utc::now().timestamp();
        if !refresh {
            if let Some(cache) = &cached {
                if now - cache.fetched_at < DISCOVERY_TTL_SECS {
                    return cache.entries.clone();
                }
            }
        }
        let mut entries = Vec::new();
        let mut any_failure = false;
        for repo in DISCOVERY_REPOS {
            match self.discover_repo(repo).await {
                Ok(mut found) => entries.append(&mut found),
                Err(error) => {
                    any_failure = true;
                    warn!(
                        "[skill_market] discovery failed for {}: {}",
                        repo.repo, error
                    );
                }
            }
        }
        if any_failure && entries.is_empty() {
            return cached.map(|cache| cache.entries).unwrap_or_default();
        }
        self.write_discovery_cache(&DiscoveryCache {
            fetched_at: now,
            entries: entries.clone(),
        });
        entries
    }

    async fn discover_repo(&self, spec: &DiscoveryRepo) -> AppResult<Vec<SkillMarketEntry>> {
        let repo = SkillRepoFetcher::parse_repo(spec.repo)?;
        let listing = self.fetcher.list_files(&repo, None).await?;
        let prefix = format!("{}/", spec.dir.trim_matches('/'));
        let skill_dirs: Vec<String> = listing
            .files
            .iter()
            .filter_map(|file| file.path.strip_suffix("/SKILL.md"))
            .filter(|dir| dir.starts_with(&prefix) && dir[prefix.len()..].find('/').is_none())
            .map(str::to_string)
            .collect();
        debug!(
            "[skill_market] discovered {} skill folders in {}",
            skill_dirs.len(),
            repo.slug()
        );

        let fetcher = self.fetcher.clone();
        let repo_ref = &repo;
        let listing_ref = &listing;
        let results: Vec<(String, AppResult<String>)> = stream::iter(skill_dirs)
            .map(|dir| {
                let fetcher = fetcher.clone();
                async move {
                    let path = format!("{}/SKILL.md", dir);
                    let text = fetcher.fetch_text(repo_ref, listing_ref, &path).await;
                    (dir, text)
                }
            })
            .buffer_unordered(DISCOVERY_CONCURRENCY)
            .collect()
            .await;

        let mut entries = Vec::new();
        for (dir, result) in results {
            let text = match result {
                Ok(text) => text,
                Err(error) => {
                    warn!("[skill_market] skipping {}: {}", dir, error);
                    continue;
                }
            };
            let leaf = dir.rsplit('/').next().unwrap_or(&dir).to_string();
            let (name, description) = parse_skill_metadata(&text, &leaf);
            let license = skill_frontmatter_field(&text, "license")
                .or_else(|| spec.default_license.map(str::to_string));
            let id = sanitize_skill_id(&leaf);
            let category = categorize(&name, description.as_deref(), &[]);
            entries.push(SkillMarketEntry {
                id,
                name,
                description,
                category: Some(category.to_string()),
                tags: vec![repo.owner.clone()],
                version: "latest".to_string(),
                license,
                homepage_url: Some(format!(
                    "{}/tree/{}/{}",
                    repo.homepage(),
                    listing.git_ref,
                    dir
                )),
                source: spec.source.to_string(),
                repo: Some(repo.slug()),
                path: Some(dir),
                recommended: true,
                ..SkillMarketEntry::default()
            });
        }
        entries.sort_by_key(|entry| entry.name.to_lowercase());
        Ok(entries)
    }

    /// Query skills.sh. Hits only carry name/source/installs; descriptions arrive later via
    /// `describe` so the result list renders immediately.
    pub async fn search_skills_sh(&self, query: &str) -> AppResult<Vec<SkillMarketEntry>> {
        let url = format!("{}?q={}", SKILLS_SH_SEARCH_URL, percent_encode_query(query));
        let response = self
            .client
            .get(&url)
            .header(reqwest::header::USER_AGENT, "cc-panes-skill-market")
            .timeout(SKILLS_SH_TIMEOUT)
            .send()
            .await
            .map_err(|err| AppError::from(format!("skills.sh request failed: {}", err)))?
            .error_for_status()
            .map_err(|err| AppError::from(format!("skills.sh request failed: {}", err)))?;
        let payload: SkillsShSearchResponse = response
            .json()
            .await
            .map_err(|err| AppError::from(format!("Invalid skills.sh response: {}", err)))?;
        Ok(Self::map_skills_sh_hits(payload.skills))
    }

    fn map_skills_sh_hits(hits: Vec<SkillsShHit>) -> Vec<SkillMarketEntry> {
        let mut entries: Vec<SkillMarketEntry> = hits
            .into_iter()
            .filter_map(|hit| {
                let repo = SkillRepoFetcher::parse_repo(&hit.source).ok()?;
                let leaf = hit.skill_id.trim();
                if leaf.is_empty() {
                    return None;
                }
                let display_name = if hit.name.trim().is_empty() {
                    leaf.to_string()
                } else {
                    hit.name.trim().to_string()
                };
                let id = sanitize_skill_id(&format!("{}-{}-{}", repo.owner, repo.repo, leaf));
                let category = categorize(&display_name, None, &[]);
                Some(SkillMarketEntry {
                    id,
                    name: display_name,
                    category: Some(category.to_string()),
                    tags: vec![repo.owner.clone()],
                    homepage_url: Some(format!("https://skills.sh/{}/{}", repo.slug(), leaf)),
                    source: SKILL_SOURCE_SKILLS_SH.to_string(),
                    repo: Some(repo.slug()),
                    // Path is resolved at describe/install time from the repository tree; keep the
                    // leaf so `repo_skill_leaf()` knows which folder to look for.
                    path: Some(leaf.to_string()),
                    installs: hit.installs,
                    ..SkillMarketEntry::default()
                })
            })
            .collect();
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.installs.unwrap_or(0)));
        entries.truncate(SKILLS_SH_MAX_RESULTS);
        entries
    }

    /// Resolve a missing description. skills.sh entries are enriched from the skill page's
    /// JSON-LD (cheap, no GitHub rate-limit cost); anything else reads SKILL.md from the repo.
    pub async fn describe(&self, mut entry: SkillMarketEntry) -> AppResult<SkillMarketEntry> {
        if entry
            .description
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        {
            return Ok(entry);
        }
        if let Some(record) = self.describe_cache_get(&entry.id) {
            apply_record(&mut entry, &record);
            return Ok(entry);
        }
        if !entry.is_repo_skill() {
            return Ok(entry);
        }

        let mut record = DescribeRecord::default();
        if entry.source == SKILL_SOURCE_SKILLS_SH {
            if let Some(description) = self.describe_from_skills_sh(&entry).await {
                record.description = Some(description);
            }
        }
        if record.description.is_none() {
            match self.describe_from_repo(&entry).await {
                Ok(found) => record = found,
                Err(error) => {
                    debug!(
                        "[skill_market] describe via repo failed for {}: {}",
                        entry.id, error
                    );
                }
            }
        }
        if record.description.is_some() || record.path.is_some() {
            self.describe_cache_put(entry.id.clone(), record.clone());
        }
        apply_record(&mut entry, &record);
        entry.category =
            Some(categorize(&entry.name, entry.description.as_deref(), &entry.tags).to_string());
        Ok(entry)
    }

    async fn describe_from_skills_sh(&self, entry: &SkillMarketEntry) -> Option<String> {
        let url = entry.homepage_url.as_deref()?;
        let html = self
            .client
            .get(url)
            .header(reqwest::header::USER_AGENT, "cc-panes-skill-market")
            .timeout(SKILLS_SH_TIMEOUT)
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?
            .text()
            .await
            .ok()?;
        extract_json_ld_description(&html)
    }

    async fn describe_from_repo(&self, entry: &SkillMarketEntry) -> AppResult<DescribeRecord> {
        let repo = SkillRepoFetcher::parse_repo(entry.repo.as_deref().unwrap_or_default())?;
        let listing = self
            .fetcher
            .list_files(&repo, entry.git_ref.as_deref())
            .await?;
        let leaf = entry.repo_skill_leaf();
        let dir = listing
            .locate_skill_dir(entry.path.as_deref(), &leaf)
            .ok_or_else(|| AppError::from(format!("{} has no {}/SKILL.md", repo.slug(), leaf)))?;
        let path = if dir.is_empty() {
            "SKILL.md".to_string()
        } else {
            format!("{}/SKILL.md", dir)
        };
        let text = self.fetcher.fetch_text(&repo, &listing, &path).await?;
        let (_, description) = parse_skill_metadata(&text, &leaf);
        Ok(DescribeRecord {
            description,
            path: Some(dir),
            license: skill_frontmatter_field(&text, "license"),
        })
    }

    /// Case-insensitive token match over the fields a user would plausibly search by.
    pub fn filter_local(entries: &[SkillMarketEntry], query: &str) -> Vec<SkillMarketEntry> {
        let tokens: Vec<String> = query
            .split_whitespace()
            .map(|token| token.to_lowercase())
            .collect();
        if tokens.is_empty() {
            return entries.to_vec();
        }
        entries
            .iter()
            .filter(|entry| {
                let haystack = format!(
                    "{} {} {} {} {}",
                    entry.name,
                    entry.description.as_deref().unwrap_or_default(),
                    entry.tags.join(" "),
                    entry.category.as_deref().unwrap_or_default(),
                    entry.repo.as_deref().unwrap_or_default()
                )
                .to_lowercase();
                tokens.iter().all(|token| haystack.contains(token))
            })
            .cloned()
            .collect()
    }

    /// Concatenate two lists, dropping secondary entries that duplicate a primary one either by
    /// id or by (repository, folder leaf) — the same upstream skill can surface via curated,
    /// discovery, and skills.sh with different ids.
    pub fn merge(
        primary: Vec<SkillMarketEntry>,
        secondary: Vec<SkillMarketEntry>,
    ) -> Vec<SkillMarketEntry> {
        let mut merged = primary;
        for candidate in secondary {
            let duplicate = merged.iter().any(|existing| {
                if existing.id == candidate.id {
                    return true;
                }
                match (existing.repo.as_deref(), candidate.repo.as_deref()) {
                    (Some(left), Some(right)) => {
                        left.eq_ignore_ascii_case(right)
                            && existing
                                .repo_skill_leaf()
                                .eq_ignore_ascii_case(&candidate.repo_skill_leaf())
                    }
                    _ => false,
                }
            });
            if !duplicate {
                merged.push(candidate);
            }
        }
        merged
    }

    fn read_discovery_cache(&self) -> Option<DiscoveryCache> {
        let content = std::fs::read_to_string(&self.discovery_cache_path).ok()?;
        serde_json::from_str(&content).ok()
    }

    fn write_discovery_cache(&self, cache: &DiscoveryCache) {
        if let Some(parent) = self.discovery_cache_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match serde_json::to_string(cache) {
            Ok(json) => {
                if let Err(error) = std::fs::write(&self.discovery_cache_path, json) {
                    warn!("[skill_market] failed to write discovery cache: {}", error);
                }
            }
            Err(error) => warn!(
                "[skill_market] failed to serialize discovery cache: {}",
                error
            ),
        }
    }

    fn describe_cache_get(&self, id: &str) -> Option<DescribeRecord> {
        let mut guard = self.describe_cache.lock().ok()?;
        if guard.is_none() {
            let loaded = std::fs::read_to_string(&self.describe_cache_path)
                .ok()
                .and_then(|content| serde_json::from_str(&content).ok())
                .unwrap_or_default();
            *guard = Some(loaded);
        }
        guard.as_ref().and_then(|map| map.get(id).cloned())
    }

    fn describe_cache_put(&self, id: String, record: DescribeRecord) {
        let Ok(mut guard) = self.describe_cache.lock() else {
            return;
        };
        let map = guard.get_or_insert_with(HashMap::new);
        map.insert(id, record);
        if let Some(parent) = self.describe_cache_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string(map) {
            let _ = std::fs::write(&self.describe_cache_path, json);
        }
    }
}

fn apply_record(entry: &mut SkillMarketEntry, record: &DescribeRecord) {
    if entry.description.is_none() {
        entry.description = record.description.clone();
    }
    if let Some(path) = &record.path {
        entry.path = Some(path.clone());
    }
    if entry.license.is_none() {
        entry.license = record.license.clone();
    }
}

/// Map arbitrary text to a valid user-skill id (folder name): lowercase ASCII alphanumerics,
/// `-`, `_`, `.`; never starting with a dot; at most 120 chars.
pub fn sanitize_skill_id(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_dash = false;
    for ch in raw.trim().chars() {
        let mapped = if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.') {
            last_dash = false;
            ch.to_ascii_lowercase()
        } else if last_dash {
            continue;
        } else {
            last_dash = true;
            '-'
        };
        out.push(mapped);
        if out.len() >= 120 {
            break;
        }
    }
    let trimmed = out.trim_matches(['-', '.']).to_string();
    if trimmed.is_empty() {
        "skill".to_string()
    } else {
        trimmed
    }
}

/// Keyword-vote classifier for entries whose source gave no category. Ties resolve toward the
/// earlier (more specific) category in `CATEGORY_KEYWORDS`; `dev` is last because almost every
/// skill mentions code somewhere.
pub fn categorize(name: &str, description: Option<&str>, tags: &[String]) -> &'static str {
    let haystack = format!(
        "{} {} {}",
        name,
        description.unwrap_or_default(),
        tags.join(" ")
    )
    .to_lowercase();
    let mut best: Option<(&'static str, usize)> = None;
    for (category, keywords) in CATEGORY_KEYWORDS {
        let score = keywords
            .iter()
            .filter(|keyword| haystack.contains(&keyword.to_lowercase()))
            .count();
        if score == 0 {
            continue;
        }
        match best {
            Some((_, current)) if current >= score => {}
            _ => best = Some((category, score)),
        }
    }
    best.map(|(category, _)| category).unwrap_or("other")
}

/// Normalize a curated/legacy category value onto the current id set.
pub fn normalize_category(raw: Option<&str>, entry: &SkillMarketEntry) -> String {
    match raw.map(str::trim) {
        Some(value) if CATEGORY_IDS.contains(&value) => value.to_string(),
        Some("design-visual") => "design".to_string(),
        _ => categorize(&entry.name, entry.description.as_deref(), &entry.tags).to_string(),
    }
}

fn percent_encode_query(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.trim().bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

/// Pull `description` out of the first `application/ld+json` block that has one.
fn extract_json_ld_description(html: &str) -> Option<String> {
    let mut rest = html;
    while let Some(start) = rest.find("application/ld+json") {
        let after = &rest[start..];
        let body_start = after.find('>')? + 1;
        let body = &after[body_start..];
        let end = body.find("</script>")?;
        let json = &body[..end];
        rest = &body[end..];
        let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
            continue;
        };
        if let Some(description) = value
            .get("description")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(description.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, repo: Option<&str>, path: Option<&str>) -> SkillMarketEntry {
        SkillMarketEntry {
            id: id.to_string(),
            name: id.to_string(),
            repo: repo.map(str::to_string),
            path: path.map(str::to_string),
            ..SkillMarketEntry::default()
        }
    }

    #[test]
    fn sanitize_skill_id_produces_folder_safe_ids() {
        assert_eq!(
            sanitize_skill_id("kepano/obsidian-skills/obsidian markdown"),
            "kepano-obsidian-skills-obsidian-markdown"
        );
        assert_eq!(sanitize_skill_id("..Hidden"), "hidden");
        assert_eq!(sanitize_skill_id("   "), "skill");
        assert_eq!(sanitize_skill_id("A__B..c"), "a__b..c");
        assert!(sanitize_skill_id(&"x".repeat(500)).len() <= 120);
    }

    #[test]
    fn categorize_votes_by_keywords_with_specific_categories_first() {
        assert_eq!(
            categorize("pdf", Some("Extract text from PDF documents"), &[]),
            "docs"
        );
        assert_eq!(
            categorize("obsidian-markdown", Some("Notes with wikilinks"), &[]),
            "learning"
        );
        assert_eq!(
            categorize("小红书文案助手", Some("生成爆款文案"), &[]),
            "content"
        );
        assert_eq!(
            categorize(
                "webapp-testing",
                Some("Test web apps with Playwright code"),
                &[]
            ),
            "dev"
        );
        assert_eq!(categorize("mystery", None, &[]), "other");
    }

    #[test]
    fn normalize_category_maps_legacy_and_falls_back_to_heuristic() {
        let e = entry("canvas-design", None, None);
        assert_eq!(normalize_category(Some("design-visual"), &e), "design");
        assert_eq!(normalize_category(Some("docs"), &e), "docs");
        assert_eq!(normalize_category(Some("weird"), &e), "design");
        assert_eq!(normalize_category(None, &entry("zzz", None, None)), "other");
    }

    #[test]
    fn merge_drops_duplicates_by_id_or_repo_leaf() {
        let primary = vec![
            entry("pdf", Some("anthropics/skills"), Some("skills/pdf")),
            entry("custom", None, None),
        ];
        let secondary = vec![
            entry(
                "anthropics-skills-pdf",
                Some("Anthropics/Skills"),
                Some("pdf"),
            ),
            entry("custom", None, None),
            entry("xlsx", Some("anthropics/skills"), Some("skills/xlsx")),
        ];
        let merged = SkillMarketCatalog::merge(primary, secondary);
        let ids: Vec<_> = merged.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["pdf", "custom", "xlsx"]);
    }

    #[test]
    fn filter_local_requires_all_tokens_case_insensitively() {
        let mut a = entry("pdf", None, None);
        a.description = Some("Extract text from PDF files".to_string());
        let mut b = entry("xlsx", None, None);
        b.tags = vec!["excel".to_string()];
        let entries = vec![a, b];
        let hits = SkillMarketCatalog::filter_local(&entries, "PDF text");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "pdf");
        assert_eq!(SkillMarketCatalog::filter_local(&entries, "excel").len(), 1);
        assert_eq!(SkillMarketCatalog::filter_local(&entries, "  ").len(), 2);
        assert!(SkillMarketCatalog::filter_local(&entries, "pdf excel").is_empty());
    }

    #[test]
    fn map_skills_sh_hits_builds_repo_entries_and_skips_non_github_sources() {
        let hits = vec![
            SkillsShHit {
                skill_id: "obsidian-markdown".to_string(),
                name: "obsidian markdown".to_string(),
                installs: Some(10),
                source: "kepano/obsidian-skills".to_string(),
            },
            SkillsShHit {
                skill_id: "obsidian-cli".to_string(),
                name: String::new(),
                installs: Some(99),
                source: "skills.volces.com".to_string(),
            },
            SkillsShHit {
                skill_id: "top".to_string(),
                name: "top".to_string(),
                installs: Some(500),
                source: "a/b".to_string(),
            },
        ];
        let entries = SkillMarketCatalog::map_skills_sh_hits(hits);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, "a-b-top");
        assert_eq!(entries[1].id, "kepano-obsidian-skills-obsidian-markdown");
        assert_eq!(entries[1].repo.as_deref(), Some("kepano/obsidian-skills"));
        assert_eq!(entries[1].repo_skill_leaf(), "obsidian-markdown");
        assert_eq!(entries[1].source, SKILL_SOURCE_SKILLS_SH);
        assert_eq!(
            entries[1].homepage_url.as_deref(),
            Some("https://skills.sh/kepano/obsidian-skills/obsidian-markdown")
        );
    }

    #[test]
    fn percent_encode_query_handles_spaces_and_unicode() {
        assert_eq!(
            percent_encode_query("obsidian markdown"),
            "obsidian+markdown"
        );
        assert_eq!(
            percent_encode_query("小红书"),
            "%E5%B0%8F%E7%BA%A2%E4%B9%A6"
        );
        assert_eq!(percent_encode_query(" a&b "), "a%26b");
    }

    #[test]
    fn extract_json_ld_description_reads_first_block_with_description() {
        let html = r#"<html><script type="application/ld+json">{"@type":"WebSite","name":"x"}</script>
        <script type="application/ld+json">{"@type":"SoftwareApplication","name":"pdf","description":"  Read PDFs.  "}</script></html>"#;
        assert_eq!(
            extract_json_ld_description(html).as_deref(),
            Some("Read PDFs.")
        );
        assert_eq!(extract_json_ld_description("<html></html>"), None);
        assert_eq!(
            extract_json_ld_description(r#"<script type="application/ld+json">{bad json</script>"#),
            None
        );
    }
}
