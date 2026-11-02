//! 资料空间（docs/108）：把内置模板铺到用户选的目录。
//!
//! 资料空间就是一个普通目录 + 一个工作空间。约定写在模板的 CLAUDE.md / AGENTS.md，
//! 工作流写在 `.claude/skills/`，由素材助手会话执行；这里只负责落模板，
//! 并且**绝不覆盖**用户已有或改过的文件——目录随用户进 Git / 同步盘，模板只是起点。

use crate::utils::error::AppResult;
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

pub const DEFAULT_DIR_NAME: &str = "CC-Panes-Library";

macro_rules! template {
    ($rel:literal, $src:literal) => {
        (
            $rel,
            include_str!(concat!("../../assets/library-template/", $src)),
        )
    };
}

/// (相对路径, 内容)。skills 放在 `.claude/skills/` 让 Claude Code 原生发现，目录自包含、
/// 离开 CC-Panes 也能用；Codex 由 AGENTS.md 指过去。
const TEMPLATE: &[(&str, &str)] = &[
    template!("CLAUDE.md", "CLAUDE.md"),
    template!("AGENTS.md", "AGENTS.md"),
    template!(".gitignore", "gitignore"),
    template!(".claude/skills/ingest/SKILL.md", "skills/ingest/SKILL.md"),
    template!(
        ".claude/skills/organize/SKILL.md",
        "skills/organize/SKILL.md"
    ),
    template!(
        ".claude/skills/video-transcribe/SKILL.md",
        "skills/video-transcribe/SKILL.md"
    ),
    template!(
        ".claude/skills/video-transcribe/scripts/transcribe.py",
        "skills/video-transcribe/scripts/transcribe.py"
    ),
];

const DIRS: &[&str] = &["inbox", "uploads", "works", ".trash"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryScaffold {
    pub root: String,
    /// 本次新写入的模板文件。
    pub written: Vec<String>,
    /// 已存在而保留原样的模板文件（用户的 CLAUDE.md 等）。
    pub kept: Vec<String>,
}

pub fn default_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(DEFAULT_DIR_NAME))
}

/// 铺模板。可重复调用：缺什么补什么，已有文件一律不动。
pub fn scaffold(root: &Path) -> AppResult<LibraryScaffold> {
    for dir in DIRS {
        fs::create_dir_all(root.join(dir))?;
    }
    let mut written = Vec::new();
    let mut kept = Vec::new();
    for (rel, content) in TEMPLATE {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        // create_new：检查与创建是同一个原子操作，不会和用户 / 同步盘的并发写入抢着覆盖。
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(content.as_bytes())?;
                mark_executable(&path)?;
                written.push((*rel).to_string());
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => kept.push((*rel).to_string()),
            Err(error) => return Err(error.into()),
        }
    }
    Ok(LibraryScaffold {
        root: root.to_string_lossy().into_owned(),
        written,
        kept,
    })
}

#[cfg(unix)]
fn mark_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    if path
        .extension()
        .is_some_and(|ext| ext == "py" || ext == "sh")
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn mark_executable(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scaffold_creates_layout_and_skills() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("lib");
        let report = scaffold(&root).unwrap();
        assert_eq!(report.written.len(), TEMPLATE.len());
        assert!(report.kept.is_empty());
        for sub in DIRS {
            assert!(root.join(sub).is_dir(), "missing {sub}");
        }
        for name in ["ingest", "organize", "video-transcribe"] {
            let skill = fs::read_to_string(root.join(".claude/skills").join(name).join("SKILL.md"))
                .unwrap();
            assert!(skill.starts_with("---\nname: "), "{name} lacks frontmatter");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let script = root.join(".claude/skills/video-transcribe/scripts/transcribe.py");
            assert_ne!(
                fs::metadata(script).unwrap().permissions().mode() & 0o111,
                0
            );
        }
    }

    #[test]
    fn scaffold_never_overwrites_existing_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("CLAUDE.md"), "用户自己的约定").unwrap();
        let first = scaffold(root).unwrap();
        assert_eq!(first.kept, vec!["CLAUDE.md".to_string()]);
        assert_eq!(
            fs::read_to_string(root.join("CLAUDE.md")).unwrap(),
            "用户自己的约定"
        );

        fs::write(root.join(".claude/skills/ingest/SKILL.md"), "改过的").unwrap();
        let second = scaffold(root).unwrap();
        assert!(second.written.is_empty());
        assert_eq!(second.kept.len(), TEMPLATE.len());
        assert_eq!(
            fs::read_to_string(root.join(".claude/skills/ingest/SKILL.md")).unwrap(),
            "改过的"
        );
    }
}
