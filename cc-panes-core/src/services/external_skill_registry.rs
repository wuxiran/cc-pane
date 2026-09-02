use crate::models::{DiscoveredExternalSkill, ExternalSkillSource};
use crate::utils::AppResult;
use cc_cli_adapters::CliToolRegistry;
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const SKILL_FILE_NAME: &str = "SKILL.md";

pub struct ExternalSkillRegistry {
    cli_registry: Arc<CliToolRegistry>,
    plugins_root: PathBuf,
    skill_roots_override: Option<Vec<(String, PathBuf)>>,
}

impl ExternalSkillRegistry {
    pub fn new(cli_registry: Arc<CliToolRegistry>) -> Self {
        Self {
            cli_registry,
            plugins_root: default_plugins_root(),
            skill_roots_override: None,
        }
    }

    pub fn with_plugins_root(cli_registry: Arc<CliToolRegistry>, plugins_root: PathBuf) -> Self {
        Self {
            cli_registry,
            plugins_root,
            skill_roots_override: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_roots_for_test(
        skill_roots: Vec<(String, PathBuf)>,
        plugins_root: PathBuf,
    ) -> Self {
        Self {
            cli_registry: Arc::new(CliToolRegistry::new()),
            plugins_root,
            skill_roots_override: Some(skill_roots),
        }
    }

    pub fn list(&self) -> AppResult<Vec<DiscoveredExternalSkill>> {
        let mut skills = Vec::new();
        for (tool_id, root) in self.skill_roots() {
            match tool_id.as_str() {
                "claude" => {
                    self.scan_cli_skill_dir(&mut skills, &root, ExternalSkillSource::Claude)?
                }
                "codex" => {
                    self.scan_cli_skill_dir(&mut skills, &root, ExternalSkillSource::Codex)?
                }
                _ => {}
            }
        }
        self.scan_plugin_skills(&mut skills)?;
        skills.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(skills)
    }

    pub fn list_by_source(
        &self,
        source: ExternalSkillSource,
    ) -> AppResult<Vec<DiscoveredExternalSkill>> {
        Ok(self
            .list()?
            .into_iter()
            .filter(|skill| skill.source == source)
            .collect())
    }

    pub fn list_by_source_filter(&self, source: &str) -> AppResult<Vec<DiscoveredExternalSkill>> {
        Ok(self
            .list()?
            .into_iter()
            .filter(|skill| skill.source.matches_filter(source))
            .collect())
    }

    pub fn get(&self, id: &str) -> AppResult<Option<DiscoveredExternalSkill>> {
        Ok(self.list()?.into_iter().find(|skill| skill.id == id))
    }

    fn skill_roots(&self) -> Vec<(String, PathBuf)> {
        self.skill_roots_override
            .clone()
            .unwrap_or_else(|| self.cli_registry.global_skills_dirs())
    }

    fn scan_cli_skill_dir(
        &self,
        skills: &mut Vec<DiscoveredExternalSkill>,
        root: &Path,
        source: ExternalSkillSource,
    ) -> AppResult<()> {
        self.scan_skill_dir(skills, root, source)
    }

    fn scan_plugin_skills(&self, skills: &mut Vec<DiscoveredExternalSkill>) -> AppResult<()> {
        if !self.plugins_root.is_dir() {
            return Ok(());
        }

        for entry in fs::read_dir(&self.plugins_root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let Some(plugin_id) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let skills_root = entry.path().join("skills");
            self.scan_skill_dir(
                skills,
                &skills_root,
                ExternalSkillSource::Plugin { plugin_id },
            )?;
        }
        Ok(())
    }

    fn scan_skill_dir(
        &self,
        skills: &mut Vec<DiscoveredExternalSkill>,
        root: &Path,
        source: ExternalSkillSource,
    ) -> AppResult<()> {
        if !root.is_dir() {
            return Ok(());
        }

        for entry in fs::read_dir(root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let Some(dir_name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let skill_path = entry.path().join(SKILL_FILE_NAME);
            if !skill_path.is_file() {
                continue;
            }
            skills.push(Self::read_skill(&skill_path, &dir_name, &source)?);
        }
        Ok(())
    }

    fn read_skill(
        path: &Path,
        dir_name: &str,
        source: &ExternalSkillSource,
    ) -> AppResult<DiscoveredExternalSkill> {
        let content = fs::read_to_string(path)?;
        let (name, description) = parse_skill_metadata(&content, dir_name);
        Ok(DiscoveredExternalSkill {
            id: format!("{}:{}", source.id_prefix(), dir_name),
            name,
            description,
            source: source.clone(),
            path: path.to_path_buf(),
            content_sha256: sha256_hex(&content),
            installed_at: modified_at(path),
        })
    }
}

fn default_plugins_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
        .join("plugins")
}

/// Parse `name` / `description` from a SKILL.md (frontmatter first, body
/// first line as fallback). Shared by external discovery and the skill market's
/// repository installer, so both see the same metadata for the same file.
pub fn parse_skill_metadata(content: &str, fallback_name: &str) -> (String, Option<String>) {
    let normalized = content.trim_start_matches('\u{feff}');
    if let Some((frontmatter, body)) = split_frontmatter(normalized) {
        let name = frontmatter_scalar(frontmatter, "name");
        let description = frontmatter_scalar(frontmatter, "description");
        let description = description.or_else(|| first_content_line(body));
        return (
            name.unwrap_or_else(|| fallback_name.to_string()),
            description,
        );
    }

    (fallback_name.to_string(), first_content_line(normalized))
}

/// Read a single top-level frontmatter field from a full SKILL.md document.
pub fn skill_frontmatter_field(content: &str, key: &str) -> Option<String> {
    let normalized = content.trim_start_matches('\u{feff}');
    let (frontmatter, _) = split_frontmatter(normalized)?;
    frontmatter_scalar(frontmatter, key)
}

/// Read a top-level scalar from YAML-ish frontmatter. Supports inline values
/// and block scalars (`key: >` / `key: |` followed by indented lines), which is
/// how many published skills write multi-sentence descriptions.
fn frontmatter_scalar(frontmatter: &str, key: &str) -> Option<String> {
    let mut lines = frontmatter.lines().peekable();
    while let Some(line) = lines.next() {
        if line.starts_with([' ', '\t']) {
            continue;
        }
        let Some((line_key, raw_value)) = line.split_once(':') else {
            continue;
        };
        if line_key.trim() != key {
            continue;
        }
        let inline = raw_value.trim();
        let is_block = inline.is_empty() || matches!(inline, ">" | "|" | ">-" | "|-" | ">+" | "|+");
        if !is_block {
            let value = clean_frontmatter_value(inline);
            return (!value.is_empty()).then_some(value);
        }
        let mut parts = Vec::new();
        while let Some(next) = lines.peek() {
            if next.trim().is_empty() {
                lines.next();
                continue;
            }
            if !next.starts_with([' ', '\t']) {
                break;
            }
            parts.push(next.trim().to_string());
            lines.next();
        }
        let joined = parts.join(" ");
        let value = clean_frontmatter_value(&joined);
        return (!value.is_empty()).then_some(value);
    }
    None
}

fn split_frontmatter(content: &str) -> Option<(&str, &str)> {
    // 用 split_inclusive('\n') 保留换行符，按真实字节长度累加游标，
    // 避免手动假设行终止符长度（CRLF 是 2 字节，LF 是 1 字节）。旧实现按
    // `line_len + 1` 累加，遇到 CRLF 文件时游标逐行偏移，最终可能落在多字节
    // UTF-8 字符内部导致 slice panic（见 issue #34）。所有边界都取自累加的
    // 字节长度或 '\n'（ASCII）分割点，始终落在合法 char 边界上。
    let mut cursor: usize = 0;
    let mut frontmatter_start: Option<usize> = None;

    for line in content.split_inclusive('\n') {
        let line_start = cursor;
        cursor += line.len();
        let trimmed = line.trim_end_matches(['\n', '\r']).trim();

        match frontmatter_start {
            // 第一行必须是起始分隔符 `---`
            None => {
                if trimmed != "---" {
                    return None;
                }
                frontmatter_start = Some(cursor);
            }
            // 遇到结束分隔符 `---`：frontmatter 为两分隔符之间的内容，body 为其后全部
            Some(start) => {
                if trimmed == "---" {
                    return Some((&content[start..line_start], &content[cursor..]));
                }
            }
        }
    }
    None
}

fn clean_frontmatter_value(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string()
}

fn first_content_line(content: &str) -> Option<String> {
    content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.trim_start_matches('#').trim().to_string())
        .filter(|line| !line.is_empty())
}

fn sha256_hex(content: &str) -> String {
    let digest = Sha256::digest(content.as_bytes());
    digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn modified_at(path: &Path) -> Option<String> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let datetime = DateTime::<Utc>::from(modified);
    Some(datetime.to_rfc3339())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(root: &Path, id: &str, content: &str) -> PathBuf {
        let dir = root.join(id);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(SKILL_FILE_NAME);
        fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn discovers_claude_codex_and_plugin_skills() {
        let temp = tempfile::tempdir().unwrap();
        let claude_root = temp.path().join("claude").join("skills");
        let codex_root = temp.path().join("codex").join("skills");
        let plugins_root = temp.path().join("plugins");
        write_skill(&claude_root, "rust-patterns", "# Rust patterns\nUse Rust.");
        write_skill(&codex_root, "frontend-ui", "# Frontend UI\nUse UI.");
        write_skill(
            &plugins_root.join("ccpanes").join("skills"),
            "check-backend",
            "# Backend check\nCheck backend.",
        );

        let registry = ExternalSkillRegistry::with_roots_for_test(
            vec![
                ("claude".to_string(), claude_root),
                ("codex".to_string(), codex_root),
            ],
            plugins_root,
        );

        let skills = registry.list().unwrap();
        let ids = skills
            .iter()
            .map(|skill| skill.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            ids,
            vec![
                "claude:rust-patterns",
                "codex:frontend-ui",
                "plugin:ccpanes:check-backend"
            ]
        );
    }

    #[test]
    fn parses_frontmatter_name_and_description() {
        let temp = tempfile::tempdir().unwrap();
        let claude_root = temp.path().join("claude").join("skills");
        let plugins_root = temp.path().join("plugins");
        write_skill(
            &claude_root,
            "rust-patterns",
            "---\nname: Idiomatic Rust\ndescription: Prefer type-safe Rust\n---\nBody",
        );
        let registry = ExternalSkillRegistry::with_roots_for_test(
            vec![("claude".to_string(), claude_root)],
            plugins_root,
        );

        let skill = registry.get("claude:rust-patterns").unwrap().unwrap();

        assert_eq!(skill.name, "Idiomatic Rust");
        assert_eq!(skill.description.as_deref(), Some("Prefer type-safe Rust"));
        assert_eq!(skill.source, ExternalSkillSource::Claude);
        assert_eq!(skill.content_sha256.len(), 64);
        assert!(skill.installed_at.is_some());
    }

    #[test]
    fn parses_block_scalar_description_and_ignores_nested_keys() {
        let content = "---\nname: pdf\ndescription: >\n  Extract text from PDFs.\n  Use when the user mentions PDF files.\nmetadata:\n  name: nested-should-not-win\nlicense: Apache-2.0\n---\nBody";
        let (name, description) = parse_skill_metadata(content, "fallback");
        assert_eq!(name, "pdf");
        assert_eq!(
            description.as_deref(),
            Some("Extract text from PDFs. Use when the user mentions PDF files.")
        );
    }

    #[test]
    fn falls_back_to_directory_name_and_first_content_line() {
        let temp = tempfile::tempdir().unwrap();
        let codex_root = temp.path().join("codex").join("skills");
        let plugins_root = temp.path().join("plugins");
        write_skill(&codex_root, "plain-skill", "\n# Plain skill\nBody");
        let registry = ExternalSkillRegistry::with_roots_for_test(
            vec![("codex".to_string(), codex_root)],
            plugins_root,
        );

        let skill = registry.get("codex:plain-skill").unwrap().unwrap();

        assert_eq!(skill.name, "plain-skill");
        assert_eq!(skill.description.as_deref(), Some("Plain skill"));
    }

    #[test]
    fn parses_crlf_frontmatter_with_non_ascii_without_panicking() {
        // 回归 issue #34：CRLF + 长中文 description 会让旧的按 `line_len + 1`
        // 累加的偏移落在多字节 UTF-8 字符内部，slice 时 panic。
        let content = "---\r\nname: guizang-ppt-skill\r\ndescription: 生成横向翻页网页 PPT（单 HTML 文件），含 WebGL 背景、章节幕封、数据大字报、图片网格等模板。当用户提到\"杂志风 PPT\"、\"瑞士风 PPT\"、\"Swiss Style\"时使用。\r\n---\r\n正文内容。";

        let (name, description) = parse_skill_metadata(content, "guizang-ppt-skill");

        assert_eq!(name, "guizang-ppt-skill");
        let description = description.expect("description should be parsed");
        assert!(description.starts_with("生成横向翻页网页 PPT"));
        assert!(description.ends_with("时使用。"));
    }

    #[test]
    fn split_frontmatter_handles_crlf_and_lf_equivalently() {
        let lf = "---\nname: a\ndescription: 你好世界\n---\nbody";
        let crlf = "---\r\nname: a\r\ndescription: 你好世界\r\n---\r\nbody";

        let (fm_lf, body_lf) = split_frontmatter(lf).expect("lf frontmatter");
        let (fm_crlf, body_crlf) = split_frontmatter(crlf).expect("crlf frontmatter");

        assert!(fm_lf.contains("description: 你好世界"));
        assert!(fm_crlf.contains("description: 你好世界"));
        assert_eq!(body_lf, "body");
        assert_eq!(body_crlf, "body");
    }
}
