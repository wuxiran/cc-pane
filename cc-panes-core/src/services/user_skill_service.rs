use crate::models::skill_library::{SkillProvenance, SkillSourceKind};
use crate::utils::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const USER_SKILL_METADATA_FILE: &str = "skill.json";
pub const USER_SKILL_MARKDOWN_FILE: &str = "SKILL.md";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledUserSkill {
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
    pub source_url: Option<String>,
    pub content_sha256: String,
    pub installed_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    /// 来源（docs/109 第 2 批）。旧 `skill.json` 没有这个字段，按 `None` 加载。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<SkillProvenance>,
    /// 上次完整抓取确认上游已删除。
    #[serde(default, skip_serializing_if = "is_false")]
    pub gone: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl InstalledUserSkill {
    /// `folder` 来源链接的本机目录；其余来源返回 `None`（内容就在库目录里）。
    pub fn linked_path(&self) -> Option<&Path> {
        let provenance = self.provenance.as_ref()?;
        if provenance.kind != SkillSourceKind::Folder {
            return None;
        }
        provenance
            .linked_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(Path::new)
    }

    /// 技能文件实际所在目录：`folder` 来源指向链接目录，其余为库目录本身。
    pub fn content_dir(&self, library_dir: &Path) -> PathBuf {
        self.linked_path()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| library_dir.to_path_buf())
    }
}

#[derive(Debug, Clone)]
pub struct UserSkillContent {
    pub skill: InstalledUserSkill,
    pub content: String,
}

pub struct UserSkillService {
    user_skills_dir: PathBuf,
}

impl UserSkillService {
    pub fn new(user_skills_dir: PathBuf) -> Self {
        Self { user_skills_dir }
    }

    pub fn user_skills_dir(&self) -> &Path {
        &self.user_skills_dir
    }

    pub fn validate_skill_id(id: &str) -> AppResult<()> {
        let trimmed = id.trim();
        if trimmed.is_empty() {
            return Err(AppError::from("Skill id cannot be empty"));
        }
        if trimmed.len() > 120 || trimmed.starts_with('.') || trimmed.contains("..") {
            return Err(AppError::from("Skill id is invalid"));
        }
        if !trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        {
            return Err(AppError::from("Skill id contains unsupported characters"));
        }
        Ok(())
    }

    pub fn skill_dir_for(root: &Path, id: &str) -> AppResult<PathBuf> {
        Self::validate_skill_id(id)?;
        Ok(root.join(id))
    }

    pub fn list_from_dir(root: &Path) -> AppResult<Vec<InstalledUserSkill>> {
        if !root.exists() {
            return Ok(Vec::new());
        }

        let mut skills = Vec::new();
        for entry in std::fs::read_dir(root)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let metadata_path = path.join(USER_SKILL_METADATA_FILE);
            if !metadata_path.is_file() {
                continue;
            }
            // 先看本地 SKILL.md 再解析 metadata：半成品目录（只有 skill.json）照旧跳过，
            // 不让一个坏目录拖垮整个列表。folder 来源没有本地 SKILL.md，按链接目录算，
            // 链接目录消失时仍列出（资源库显示「文件夹不存在」）。
            let local_markdown = path.join(USER_SKILL_MARKDOWN_FILE);
            let content = std::fs::read_to_string(&metadata_path)?;
            let parsed = serde_json::from_str::<InstalledUserSkill>(&content);
            let mut skill = if local_markdown.is_file() {
                parsed.map_err(|err| {
                    AppError::from(format!("Invalid user skill metadata: {}", err))
                })?
            } else {
                match parsed {
                    Ok(skill) if skill.linked_path().is_some() => skill,
                    _ => continue,
                }
            };
            let markdown_path = skill.content_dir(&path).join(USER_SKILL_MARKDOWN_FILE);
            skill.file_path = Some(markdown_path.to_string_lossy().to_string());
            skills.push(skill);
        }

        skills.sort_by(|left, right| {
            left.name
                .to_ascii_lowercase()
                .cmp(&right.name.to_ascii_lowercase())
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(skills)
    }

    pub fn read_from_dir(root: &Path, id: &str) -> AppResult<Option<UserSkillContent>> {
        let skill_dir = Self::skill_dir_for(root, id)?;
        let metadata_path = skill_dir.join(USER_SKILL_METADATA_FILE);
        if !metadata_path.is_file() {
            return Ok(None);
        }

        let metadata = std::fs::read_to_string(&metadata_path)?;
        let mut skill: InstalledUserSkill = serde_json::from_str(&metadata)
            .map_err(|err| AppError::from(format!("Invalid user skill metadata: {}", err)))?;
        let markdown_path = skill.content_dir(&skill_dir).join(USER_SKILL_MARKDOWN_FILE);
        if !markdown_path.is_file() {
            return Ok(None);
        }
        let content = std::fs::read_to_string(&markdown_path)?;
        skill.file_path = Some(markdown_path.to_string_lossy().to_string());
        Ok(Some(UserSkillContent { skill, content }))
    }

    pub fn list_skills(&self) -> AppResult<Vec<InstalledUserSkill>> {
        Self::list_from_dir(&self.user_skills_dir)
    }

    pub fn read_skill(&self, id: &str) -> AppResult<Option<UserSkillContent>> {
        Self::read_from_dir(&self.user_skills_dir, id)
    }

    pub fn write_skill(&self, skill: &InstalledUserSkill, content: &str) -> AppResult<()> {
        let dir = Self::skill_dir_for(&self.user_skills_dir, &skill.id)?;
        std::fs::create_dir_all(&dir)?;
        Self::write_metadata(&dir, skill)?;
        std::fs::write(dir.join(USER_SKILL_MARKDOWN_FILE), content)?;
        Ok(())
    }

    /// 只写 `skill.json`（不带运行时回填的 `filePath`）。folder 来源只有这一个文件。
    pub fn write_metadata(dir: &Path, skill: &InstalledUserSkill) -> AppResult<()> {
        let mut metadata = skill.clone();
        metadata.file_path = None;
        let metadata_json = serde_json::to_string_pretty(&metadata)
            .map_err(|err| AppError::from(format!("Failed to serialize user skill: {}", err)))?;
        crate::utils::atomic_file::write_atomic(
            &dir.join(USER_SKILL_METADATA_FILE),
            metadata_json.as_bytes(),
        )
        .map_err(|err| AppError::from(format!("Failed to write user skill metadata: {}", err)))
    }

    pub fn remove_skill(&self, id: &str) -> AppResult<bool> {
        let dir = Self::skill_dir_for(&self.user_skills_dir, id)?;
        if !dir.exists() {
            return Ok(false);
        }
        std::fs::remove_dir_all(dir)?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_service() -> (UserSkillService, TempDir) {
        let tmp = TempDir::new().expect("tempdir");
        (UserSkillService::new(tmp.path().join("user-skills")), tmp)
    }

    fn sample_skill(id: &str, name: &str) -> InstalledUserSkill {
        InstalledUserSkill {
            id: id.to_string(),
            name: name.to_string(),
            description: Some("desc".to_string()),
            category: None,
            tags: vec!["tag1".to_string()],
            version: "1.0.0".to_string(),
            license: None,
            homepage_url: None,
            source_url: None,
            content_sha256: "abc123".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            file_path: None,
            provenance: None,
            gone: false,
        }
    }

    // ===== validate_skill_id =====

    #[test]
    fn validate_skill_id_accepts_normal_ids() {
        assert!(UserSkillService::validate_skill_id("my-skill_1.2").is_ok());
        assert!(UserSkillService::validate_skill_id("ABC").is_ok());
    }

    #[test]
    fn validate_skill_id_rejects_invalid() {
        assert!(UserSkillService::validate_skill_id("").is_err());
        assert!(UserSkillService::validate_skill_id("   ").is_err());
        assert!(UserSkillService::validate_skill_id(".hidden").is_err());
        assert!(UserSkillService::validate_skill_id("a..b").is_err());
        assert!(UserSkillService::validate_skill_id("a/b").is_err());
        assert!(UserSkillService::validate_skill_id("a\\b").is_err());
        assert!(UserSkillService::validate_skill_id("中文id").is_err());
        assert!(UserSkillService::validate_skill_id(&"x".repeat(121)).is_err());
        assert!(UserSkillService::validate_skill_id(&"x".repeat(120)).is_ok());
    }

    // ===== CRUD roundtrip =====

    #[test]
    fn write_read_list_remove_roundtrip() {
        let (service, _tmp) = make_service();
        let skill = sample_skill("skill-a", "Skill A");
        service.write_skill(&skill, "# Skill A content").unwrap();

        let read = service
            .read_skill("skill-a")
            .unwrap()
            .expect("should exist");
        assert_eq!(read.skill.id, "skill-a");
        assert_eq!(read.skill.name, "Skill A");
        assert_eq!(read.content, "# Skill A content");
        assert!(read.skill.file_path.is_some(), "读取时应回填 file_path");

        let listed = service.list_skills().unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].file_path.is_some());

        assert!(service.remove_skill("skill-a").unwrap());
        assert!(service.read_skill("skill-a").unwrap().is_none());
        assert!(
            !service.remove_skill("skill-a").unwrap(),
            "重复删除应返回 false"
        );
    }

    #[test]
    fn write_skill_does_not_persist_file_path_in_metadata() {
        let (service, _tmp) = make_service();
        let mut skill = sample_skill("skill-b", "B");
        skill.file_path = Some("should-not-persist".to_string());
        service.write_skill(&skill, "content").unwrap();

        let metadata_path = service
            .user_skills_dir()
            .join("skill-b")
            .join(USER_SKILL_METADATA_FILE);
        let raw = std::fs::read_to_string(metadata_path).unwrap();
        assert!(!raw.contains("should-not-persist"));
        assert!(!raw.contains("filePath"));
    }

    #[test]
    fn list_skills_sorts_by_name_case_insensitive() {
        let (service, _tmp) = make_service();
        service
            .write_skill(&sample_skill("id-1", "zebra"), "z")
            .unwrap();
        service
            .write_skill(&sample_skill("id-2", "Apple"), "a")
            .unwrap();
        service
            .write_skill(&sample_skill("id-3", "mango"), "m")
            .unwrap();

        let names: Vec<String> = service
            .list_skills()
            .unwrap()
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert_eq!(names, vec!["Apple", "mango", "zebra"]);
    }

    #[test]
    fn list_from_dir_returns_empty_when_root_missing() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("nope");
        assert!(UserSkillService::list_from_dir(&missing)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn list_from_dir_skips_incomplete_skill_dirs() {
        let (service, _tmp) = make_service();
        service
            .write_skill(&sample_skill("good", "Good"), "ok")
            .unwrap();

        // 只有 metadata、缺 SKILL.md
        let half = service.user_skills_dir().join("half");
        std::fs::create_dir_all(&half).unwrap();
        std::fs::write(half.join(USER_SKILL_METADATA_FILE), "{}").unwrap();

        // 游离文件（非目录）
        std::fs::write(service.user_skills_dir().join("stray.txt"), "x").unwrap();

        let listed = service.list_skills().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "good");
    }

    #[test]
    fn list_from_dir_errors_on_invalid_metadata_json() {
        let (service, _tmp) = make_service();
        let dir = service.user_skills_dir().join("broken");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(USER_SKILL_METADATA_FILE), "not json").unwrap();
        std::fs::write(dir.join(USER_SKILL_MARKDOWN_FILE), "content").unwrap();

        let err = service.list_skills().unwrap_err();
        assert!(err.message().contains("Invalid user skill metadata"));
    }

    #[test]
    fn read_skill_returns_none_when_missing() {
        let (service, _tmp) = make_service();
        assert!(service.read_skill("absent").unwrap().is_none());
    }

    #[test]
    fn read_skill_rejects_invalid_id() {
        let (service, _tmp) = make_service();
        assert!(service.read_skill("../escape").is_err());
    }

    #[test]
    fn skill_dir_for_joins_validated_id() {
        let root = Path::new("root");
        let dir = UserSkillService::skill_dir_for(root, "my-skill").unwrap();
        assert_eq!(dir, root.join("my-skill"));
        assert!(UserSkillService::skill_dir_for(root, "../up").is_err());
    }

    #[test]
    fn legacy_metadata_without_provenance_still_loads() {
        let (service, _tmp) = make_service();
        let dir = service.user_skills_dir().join("legacy");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(USER_SKILL_METADATA_FILE),
            r#"{"id":"legacy","name":"Legacy","version":"1","contentSha256":"x","installedAt":"2026-01-01T00:00:00Z","tags":[]}"#,
        )
        .unwrap();
        std::fs::write(dir.join(USER_SKILL_MARKDOWN_FILE), "body").unwrap();

        let skill = service.read_skill("legacy").unwrap().unwrap().skill;
        assert!(skill.provenance.is_none());
        assert!(!skill.gone);
        assert_eq!(service.list_skills().unwrap().len(), 1);
    }

    #[test]
    fn provenance_roundtrips_and_unknown_kind_falls_back() {
        let mut skill = sample_skill("p", "P");
        skill.provenance = Some(SkillProvenance {
            kind: SkillSourceKind::Github,
            repo: Some("o/r".into()),
            path: Some(String::new()),
            ..Default::default()
        });
        skill.gone = true;
        let json = serde_json::to_string(&skill).unwrap();
        assert!(json.contains("\"gone\":true"));
        assert!(json.contains("\"kind\":\"github\""));
        let back: InstalledUserSkill = serde_json::from_str(&json).unwrap();
        assert_eq!(back, skill);

        let future: SkillProvenance = serde_json::from_str(r#"{"kind":"svn"}"#).unwrap();
        assert_eq!(future.kind, SkillSourceKind::Unknown);
        // gone=false 不写盘，旧版本读到的文件不变
        skill.gone = false;
        assert!(!serde_json::to_string(&skill).unwrap().contains("gone"));
    }

    #[test]
    fn folder_skill_reads_from_linked_dir_and_lists_when_missing() {
        let (service, tmp) = make_service();
        let linked = tmp.path().join("linked");
        std::fs::create_dir_all(&linked).unwrap();
        std::fs::write(linked.join(USER_SKILL_MARKDOWN_FILE), "linked body").unwrap();
        let mut skill = sample_skill("f", "F");
        skill.provenance = Some(SkillProvenance {
            kind: SkillSourceKind::Folder,
            linked_path: Some(linked.to_string_lossy().to_string()),
            ..Default::default()
        });
        let dir = service.user_skills_dir().join("f");
        std::fs::create_dir_all(&dir).unwrap();
        UserSkillService::write_metadata(&dir, &skill).unwrap();

        let read = service.read_skill("f").unwrap().unwrap();
        assert_eq!(read.content, "linked body");
        assert!(read
            .skill
            .file_path
            .unwrap()
            .starts_with(&*linked.to_string_lossy()));

        std::fs::remove_dir_all(&linked).unwrap();
        assert!(service.read_skill("f").unwrap().is_none());
        assert_eq!(service.list_skills().unwrap().len(), 1);
    }
}
