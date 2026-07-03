use crate::utils::{AppError, AppResult};
use cc_panes_core::services::{InstalledUserSkill, UserSkillService};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::Duration;
use tracing::{debug, warn};

const DEFAULT_SKILL_MARKET_INDEX_URL: &str =
    "https://raw.githubusercontent.com/wuxiran/cc-panes/main/skill-market/index.json";

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default)]
    pub recommended: bool,
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
        Self {
            index_url,
            cache_path: skills_dir.join("market-index-cache.json"),
            user_skill_service: UserSkillService::new(user_skills_dir),
            client,
        }
    }

    pub async fn list_market_entries(&self) -> AppResult<Vec<SkillMarketEntry>> {
        match self.fetch_index().await {
            Ok(index) => {
                self.write_cache(&index)?;
                Ok(Self::sorted_entries(index.entries))
            }
            Err(error) => {
                warn!("[skill_market] Failed to fetch market index: {}", error);
                match self.read_cache() {
                    Ok(Some(index)) => Ok(Self::sorted_entries(index.entries)),
                    Ok(None) => Ok(Vec::new()),
                    Err(cache_error) => Err(cache_error),
                }
            }
        }
    }

    pub fn list_user_skills(&self) -> AppResult<Vec<InstalledUserSkill>> {
        self.user_skill_service.list_skills()
    }

    pub async fn install_market_skill(&self, skill_id: &str) -> AppResult<InstalledUserSkill> {
        UserSkillService::validate_skill_id(skill_id)?;
        let index = self.fetch_index_or_cache().await?;
        let entry = index
            .entries
            .into_iter()
            .find(|entry| entry.id == skill_id)
            .ok_or_else(|| {
                AppError::from(format!("Skill '{}' was not found in the market", skill_id))
            })?;
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

    pub fn remove_user_skill(&self, skill_id: &str) -> AppResult<bool> {
        self.user_skill_service.remove_skill(skill_id)
    }

    async fn fetch_index_or_cache(&self) -> AppResult<SkillMarketIndex> {
        match self.fetch_index().await {
            Ok(index) => {
                self.write_cache(&index)?;
                Ok(index)
            }
            Err(error) => {
                debug!(
                    "[skill_market] Fetch failed during install, using cache: {}",
                    error
                );
                self.read_cache()?.ok_or_else(|| {
                    AppError::from(format!("Skill market index is unavailable: {}", error))
                })
            }
        }
    }

    async fn fetch_index(&self) -> AppResult<SkillMarketIndex> {
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
            description: None,
            category: None,
            tags: Vec::new(),
            version: "1.0.0".to_string(),
            license: Some("MIT".to_string()),
            homepage_url: None,
            content_url: Some("https://example.com/skill.md".to_string()),
            sha256: Some("deadbeef".to_string()),
            recommended: false,
        }
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
        assert_eq!(ids, vec!["rec-skill", "plain-skill"]);
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
        assert!(entries.is_empty());
    }
}
