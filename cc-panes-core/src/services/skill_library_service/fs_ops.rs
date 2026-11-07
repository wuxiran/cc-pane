//! 资源库技能的文件操作：treeHash、文件列表、带过滤的复制、目录大小。

use crate::services::user_skill_service::USER_SKILL_METADATA_FILE;
use sha2::{Digest, Sha256};
use std::io;
use std::path::{Path, PathBuf};

/// 不进 treeHash、不随技能复制的目录。
const IGNORED_DIRS: [&str; 4] = ["node_modules", ".venv", "__pycache__", ".git"];
/// 不进 treeHash 的文件（任意层级）。锁文件随安装器变化，不算用户改动。
const IGNORED_FILES: [&str; 6] = [
    ".DS_Store",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "uv.lock",
];
/// 符号链接环路兜底。
const MAX_DEPTH: usize = 24;

pub(crate) fn is_ignored_dir_name(name: &str) -> bool {
    IGNORED_DIRS.contains(&name)
}

/// `relative` 用 `/` 分隔。根目录的 `skill.json` 是 CC-Panes 自己的元数据，也忽略。
pub(crate) fn is_hash_ignored(relative: &str) -> bool {
    if relative == USER_SKILL_METADATA_FILE {
        return true;
    }
    let mut segments = relative.split('/').peekable();
    while let Some(segment) = segments.next() {
        let is_last = segments.peek().is_none();
        if is_last {
            return IGNORED_FILES.contains(&segment);
        }
        if is_ignored_dir_name(segment) {
            return true;
        }
    }
    false
}

/// 目录内参与 treeHash 的文件（相对路径，`/` 分隔，已排序）。
pub(crate) fn list_files(dir: &Path) -> io::Result<Vec<String>> {
    let mut files = Vec::new();
    walk(dir, "", 0, &mut files)?;
    files.sort();
    Ok(files)
}

fn walk(dir: &Path, prefix: &str, depth: usize, out: &mut Vec<String>) -> io::Result<()> {
    if depth > MAX_DEPTH {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", prefix, name)
        };
        // metadata() 跟随符号链接：导入自 ~/.agents/skills 的技能常是软链接。
        let Ok(metadata) = std::fs::metadata(entry.path()) else {
            continue;
        };
        if metadata.is_dir() {
            if is_ignored_dir_name(&name) {
                continue;
            }
            walk(&entry.path(), &relative, depth + 1, out)?;
        } else if metadata.is_file() && !is_hash_ignored(&relative) {
            out.push(relative);
        }
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{:02x}", byte)).collect()
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// `sha256(路径 + \0 + 文件sha256 + \n …)`，文件按相对路径排序。
pub(crate) fn tree_hash(dir: &Path) -> io::Result<String> {
    let mut hasher = Sha256::new();
    for relative in list_files(dir)? {
        let bytes = std::fs::read(dir.join(relative_to_native(&relative)))?;
        hasher.update(relative.as_bytes());
        hasher.update([0u8]);
        hasher.update(sha256_hex(&bytes).as_bytes());
        hasher.update(b"\n");
    }
    Ok(hex(&hasher.finalize()))
}

pub(crate) fn relative_to_native(relative: &str) -> PathBuf {
    relative.split('/').collect()
}

/// 参与哈希的文件总大小与个数。
pub(crate) fn dir_size(dir: &Path) -> io::Result<(u64, usize)> {
    let files = list_files(dir)?;
    let mut total = 0u64;
    for relative in &files {
        if let Ok(metadata) = std::fs::metadata(dir.join(relative_to_native(relative))) {
            total += metadata.len();
        }
    }
    Ok((total, files.len()))
}

/// 复制技能目录，跳过 `.git`、`node_modules` 等，符号链接按内容复制。
pub(crate) fn copy_dir_filtered(src: &Path, dst: &Path) -> io::Result<()> {
    copy_inner(src, dst, 0)
}

fn copy_inner(src: &Path, dst: &Path, depth: usize) -> io::Result<()> {
    if depth > MAX_DEPTH {
        return Ok(());
    }
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let Ok(metadata) = std::fs::metadata(entry.path()) else {
            continue;
        };
        if metadata.is_dir() {
            if is_ignored_dir_name(&name_str) {
                continue;
            }
            copy_inner(&entry.path(), &dst.join(&name), depth + 1)?;
        } else if metadata.is_file() {
            if name_str == ".DS_Store" {
                continue;
            }
            std::fs::copy(entry.path(), dst.join(&name))?;
        }
    }
    Ok(())
}

/// 先尝试 rename，跨设备失败时退回复制 + 删除。
pub(crate) fn move_dir(src: &Path, dst: &Path) -> io::Result<()> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(_) => {
            copy_dir_filtered(src, dst)?;
            std::fs::remove_dir_all(src)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, relative: &str, content: &str) {
        let path = root.join(relative_to_native(relative));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn ignore_rules_cover_metadata_lockfiles_and_tool_dirs() {
        for ignored in [
            "skill.json",
            ".DS_Store",
            "sub/.DS_Store",
            "node_modules/x/index.js",
            "a/node_modules/b.js",
            ".venv/bin/python",
            "scripts/__pycache__/x.pyc",
            ".git/HEAD",
            "package-lock.json",
            "web/pnpm-lock.yaml",
            "yarn.lock",
            "bun.lockb",
            "uv.lock",
        ] {
            assert!(is_hash_ignored(ignored), "{ignored} should be ignored");
        }
        for kept in ["SKILL.md", "sub/skill.json", "scripts/run.py", "lock.md"] {
            assert!(!is_hash_ignored(kept), "{kept} should count");
        }
    }

    #[test]
    fn tree_hash_is_stable_ignores_noise_and_detects_edits() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "SKILL.md", "# x");
        write(root, "scripts/run.sh", "echo");
        let base = tree_hash(root).unwrap();

        write(root, "skill.json", "{}");
        write(root, ".DS_Store", "junk");
        write(root, "node_modules/dep/index.js", "x");
        write(root, "uv.lock", "x");
        assert_eq!(
            tree_hash(root).unwrap(),
            base,
            "ignored files must not count"
        );

        write(root, "scripts/run.sh", "echo changed");
        assert_ne!(tree_hash(root).unwrap(), base);

        // 同内容不同路径也算改动
        write(root, "scripts/run.sh", "echo");
        assert_eq!(tree_hash(root).unwrap(), base);
        std::fs::rename(root.join("scripts"), root.join("bin")).unwrap();
        assert_ne!(tree_hash(root).unwrap(), base);
    }

    #[test]
    fn tree_hash_matches_documented_formula() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "b.txt", "B");
        write(tmp.path(), "SKILL.md", "A");
        let expected = sha256_hex(
            format!(
                "SKILL.md\0{}\nb.txt\0{}\n",
                sha256_hex(b"A"),
                sha256_hex(b"B")
            )
            .as_bytes(),
        );
        assert_eq!(tree_hash(tmp.path()).unwrap(), expected);
    }

    #[test]
    fn copy_skips_git_and_node_modules() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        write(&src, "SKILL.md", "x");
        write(&src, ".git/HEAD", "ref");
        write(&src, "node_modules/a.js", "x");
        write(&src, "refs/a.md", "x");
        let dst = tmp.path().join("dst");
        copy_dir_filtered(&src, &dst).unwrap();
        assert!(dst.join("SKILL.md").is_file());
        assert!(dst.join("refs/a.md").is_file());
        assert!(!dst.join(".git").exists());
        assert!(!dst.join("node_modules").exists());
        assert_eq!(dir_size(&dst).unwrap(), (2, 2));
    }
}
