//! 内置技能按单个挂载（docs/109 第 2 批 C）。
//!
//! 内置根目录（`<data>/skills/builtin`）是一个 Claude 插件：
//! `.claude-plugin/plugin.json`、版本戳，和 `skills/<ccpanes-*>/SKILL.md`。
//! 启动档没选中全部时，在 `<data>/skills/builtin-sets/<sha256(排序后的名字)[..16]>/`
//! 物化同样布局的子集：非技能文件照抄，技能子目录 Unix 用符号链接、Windows 复制。
//! 同一选择复用同一目录；内置目录重新物化后按原选择重建（路径不变，运行中的会话不断）。

use crate::services::default_skill_service::MANAGED_SKILLS_SUBDIR;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use tracing::warn;

pub const BUILTIN_SETS_DIR_NAME: &str = "builtin-sets";
/// 子集目录里记录所选名字，供重新物化后按原选择重建。
const SET_MANIFEST_FILE: &str = ".ccpanes-builtin-set";
const SKILL_FILE: &str = "SKILL.md";

/// 启动档对内置技能的选择。名字是目录名（`ccpanes-launch-task`），不带 `builtin:` 前缀。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BuiltinSkillSelection {
    /// 全部挂载（没有启动档，或 core 模式没有关掉任何内置技能）。
    All,
    /// core 模式：全部减去这些。
    Except(Vec<String>),
    /// custom 模式：只挂这些。
    Only(Vec<String>),
}

/// `<builtin_root>` 的兄弟目录 `builtin-sets/`。
pub fn builtin_sets_dir(builtin_root: &Path) -> PathBuf {
    builtin_root
        .parent()
        .map(|parent| parent.join(BUILTIN_SETS_DIR_NAME))
        .unwrap_or_else(|| PathBuf::from(BUILTIN_SETS_DIR_NAME))
}

/// 内置根目录下实际存在的技能（含 SKILL.md 的 `skills/<name>/`）。
fn available_skills(builtin_root: &Path) -> BTreeSet<String> {
    let Ok(entries) = std::fs::read_dir(builtin_root.join(MANAGED_SKILLS_SUBDIR)) else {
        return BTreeSet::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.path().join(SKILL_FILE).is_file())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect()
}

fn set_hash(names: &BTreeSet<String>) -> String {
    let joined = names.iter().cloned().collect::<Vec<_>>().join("\n");
    let digest = Sha256::digest(joined.as_bytes());
    digest
        .iter()
        .map(|byte| format!("{:02x}", byte))
        .collect::<String>()[..16]
        .to_string()
}

/// 本次会话要挂载的内置目录：全选返回原目录，部分选择返回子集目录，选中为空返回 `None`。
/// 物化子集失败时退回原目录（宁可多挂，不让会话丢掉全部内置技能）。
pub fn builtin_mount_dir(
    builtin_root: &Path,
    selection: &BuiltinSkillSelection,
) -> Option<PathBuf> {
    if !builtin_root.is_dir() {
        return None;
    }
    let available = available_skills(builtin_root);
    let chosen: BTreeSet<String> = match selection {
        BuiltinSkillSelection::All => return Some(builtin_root.to_path_buf()),
        BuiltinSkillSelection::Except(disabled) => available
            .iter()
            .filter(|name| !disabled.contains(name))
            .cloned()
            .collect(),
        BuiltinSkillSelection::Only(enabled) => available
            .iter()
            .filter(|name| enabled.contains(name))
            .cloned()
            .collect(),
    };
    if chosen.is_empty() {
        return None;
    }
    if chosen == available {
        return Some(builtin_root.to_path_buf());
    }
    let sets_dir = builtin_sets_dir(builtin_root);
    let target = sets_dir.join(set_hash(&chosen));
    if target.is_dir() {
        return Some(target);
    }
    match materialize_set(builtin_root, &sets_dir, &target, &chosen) {
        Ok(()) => Some(target),
        Err(error) => {
            warn!(
                "[builtin_skill_sets] failed to materialize subset {}: {}; mounting the full builtin dir",
                target.display(),
                error
            );
            Some(builtin_root.to_path_buf())
        }
    }
}

fn materialize_set(
    builtin_root: &Path,
    sets_dir: &Path,
    target: &Path,
    chosen: &BTreeSet<String>,
) -> std::io::Result<()> {
    std::fs::create_dir_all(sets_dir)?;
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let staging = sets_dir.join(format!(".staging-{}", &nonce[..12]));
    let built = build_set(builtin_root, &staging, chosen);
    if let Err(error) = built {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    if let Err(error) = std::fs::rename(&staging, target) {
        let _ = std::fs::remove_dir_all(&staging);
        // 并发启动同一选择：另一个进程先建好了，直接复用。
        if target.is_dir() {
            return Ok(());
        }
        return Err(error);
    }
    Ok(())
}

fn build_set(builtin_root: &Path, dest: &Path, chosen: &BTreeSet<String>) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(builtin_root)?.flatten() {
        let name = entry.file_name();
        if name == MANAGED_SKILLS_SUBDIR {
            continue;
        }
        copy_tree(&entry.path(), &dest.join(&name))?;
    }
    let source_skills = builtin_root.join(MANAGED_SKILLS_SUBDIR);
    let dest_skills = dest.join(MANAGED_SKILLS_SUBDIR);
    std::fs::create_dir_all(&dest_skills)?;
    for entry in std::fs::read_dir(&source_skills)?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        if path.is_dir() {
            if chosen.contains(&name) {
                link_or_copy_dir(&path, &dest_skills.join(&name))?;
            }
        } else {
            // 版本戳等非技能文件照抄（WSL 同步以它为前置校验）。
            std::fs::copy(&path, dest_skills.join(&name))?;
        }
    }
    let manifest = chosen.iter().cloned().collect::<Vec<_>>().join("\n");
    std::fs::write(dest.join(SET_MANIFEST_FILE), manifest)
}

fn copy_tree(source: &Path, dest: &Path) -> std::io::Result<()> {
    if source.is_dir() {
        std::fs::create_dir_all(dest)?;
        for entry in std::fs::read_dir(source)?.flatten() {
            copy_tree(&entry.path(), &dest.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(source, dest).map(|_| ())
    }
}

#[cfg(unix)]
fn link_or_copy_dir(source: &Path, dest: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, dest)
}

#[cfg(not(unix))]
fn link_or_copy_dir(source: &Path, dest: &Path) -> std::io::Result<()> {
    copy_tree(source, dest)
}

/// 内置目录重新物化后调用：按每个子集记录的选择重建（技能增删、插件清单、Windows 上的
/// 复制内容都跟着更新）。读不出选择的子集直接删除，下次启动时按需再建。
pub fn refresh_builtin_sets(builtin_root: &Path) {
    let sets_dir = builtin_sets_dir(builtin_root);
    let Ok(entries) = std::fs::read_dir(&sets_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let chosen: Option<BTreeSet<String>> =
            std::fs::read_to_string(path.join(SET_MANIFEST_FILE))
                .ok()
                .map(|raw| {
                    raw.lines()
                        .map(str::trim)
                        .filter(|line| !line.is_empty())
                        .map(str::to_string)
                        .collect()
                });
        if let Err(error) = std::fs::remove_dir_all(&path) {
            warn!(
                "[builtin_skill_sets] failed to clear {}: {}",
                path.display(),
                error
            );
            continue;
        }
        let Some(chosen) = chosen else {
            continue;
        };
        let available = available_skills(builtin_root);
        let still: BTreeSet<String> = chosen.intersection(&available).cloned().collect();
        // 名字没变才原地重建：hash 由名字决定，路径保持不变。
        if still != chosen || still.is_empty() {
            continue;
        }
        if let Err(error) = materialize_set(builtin_root, &sets_dir, &path, &chosen) {
            warn!(
                "[builtin_skill_sets] failed to rebuild {}: {}",
                path.display(),
                error
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn builtin_fixture(root: &Path, names: &[&str]) -> PathBuf {
        let builtin = root.join("skills").join("builtin");
        std::fs::create_dir_all(builtin.join(".claude-plugin")).unwrap();
        std::fs::write(
            builtin.join(".claude-plugin/plugin.json"),
            "{\"name\":\"ccpanes\"}",
        )
        .unwrap();
        std::fs::write(builtin.join(".ccpanes-default-skills-version"), "1.0").unwrap();
        let skills = builtin.join(MANAGED_SKILLS_SUBDIR);
        std::fs::create_dir_all(&skills).unwrap();
        std::fs::write(skills.join(".ccpanes-default-skills-version"), "1.0").unwrap();
        for name in names {
            std::fs::create_dir_all(skills.join(name)).unwrap();
            std::fs::write(skills.join(name).join(SKILL_FILE), format!("# {name}")).unwrap();
        }
        builtin
    }

    fn names(selection: &[&str]) -> Vec<String> {
        selection.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn full_selection_mounts_the_original_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let builtin = builtin_fixture(tmp.path(), &["ccpanes-a", "ccpanes-b"]);
        assert_eq!(
            builtin_mount_dir(&builtin, &BuiltinSkillSelection::All),
            Some(builtin.clone())
        );
        assert_eq!(
            builtin_mount_dir(&builtin, &BuiltinSkillSelection::Except(Vec::new())),
            Some(builtin.clone())
        );
        // 选了全部（外加一个不存在的名字）也算全选
        assert_eq!(
            builtin_mount_dir(
                &builtin,
                &BuiltinSkillSelection::Only(names(&["ccpanes-a", "ccpanes-b", "ccpanes-gone"]))
            ),
            Some(builtin.clone())
        );
        assert!(!builtin_sets_dir(&builtin).exists());
    }

    #[test]
    fn empty_selection_mounts_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let builtin = builtin_fixture(tmp.path(), &["ccpanes-a"]);
        assert_eq!(
            builtin_mount_dir(&builtin, &BuiltinSkillSelection::Only(Vec::new())),
            None
        );
        assert_eq!(
            builtin_mount_dir(
                &builtin,
                &BuiltinSkillSelection::Except(names(&["ccpanes-a"]))
            ),
            None
        );
        let missing = tmp.path().join("nope");
        assert_eq!(
            builtin_mount_dir(&missing, &BuiltinSkillSelection::All),
            None
        );
    }

    #[test]
    fn subset_dir_contains_only_selected_skills_and_is_reused() {
        let tmp = tempfile::tempdir().unwrap();
        let builtin = builtin_fixture(tmp.path(), &["ccpanes-a", "ccpanes-b", "ccpanes-c"]);
        let subset = builtin_mount_dir(
            &builtin,
            &BuiltinSkillSelection::Except(names(&["ccpanes-b"])),
        )
        .unwrap();
        assert_ne!(subset, builtin);
        assert_eq!(
            subset.parent().unwrap(),
            tmp.path().join("skills").join(BUILTIN_SETS_DIR_NAME)
        );
        assert_eq!(subset.file_name().unwrap().len(), 16);
        assert!(subset.join(".claude-plugin/plugin.json").is_file());
        assert!(subset.join(".ccpanes-default-skills-version").is_file());
        assert!(subset
            .join("skills/.ccpanes-default-skills-version")
            .is_file());
        assert!(subset.join("skills/ccpanes-a/SKILL.md").is_file());
        assert!(subset.join("skills/ccpanes-c/SKILL.md").is_file());
        assert!(!subset.join("skills/ccpanes-b").exists());

        // 同一选择（另一种写法）复用同一目录
        let again = builtin_mount_dir(
            &builtin,
            &BuiltinSkillSelection::Only(names(&["ccpanes-c", "ccpanes-a"])),
        )
        .unwrap();
        assert_eq!(again, subset);
        let set_count = std::fs::read_dir(builtin_sets_dir(&builtin))
            .unwrap()
            .count();
        assert_eq!(set_count, 1);
    }

    #[test]
    fn refresh_rebuilds_sets_in_place_after_rematerialization() {
        let tmp = tempfile::tempdir().unwrap();
        let builtin = builtin_fixture(tmp.path(), &["ccpanes-a", "ccpanes-b"]);
        let only_a = BuiltinSkillSelection::Only(names(&["ccpanes-a"]));
        let subset = builtin_mount_dir(&builtin, &only_a).unwrap();
        std::fs::write(
            builtin.join(".claude-plugin/plugin.json"),
            "{\"version\":\"2\"}",
        )
        .unwrap();
        std::fs::write(builtin.join("skills/ccpanes-a/SKILL.md"), "# a v2").unwrap();

        refresh_builtin_sets(&builtin);
        assert_eq!(
            std::fs::read_to_string(subset.join(".claude-plugin/plugin.json")).unwrap(),
            "{\"version\":\"2\"}"
        );
        assert_eq!(
            std::fs::read_to_string(subset.join("skills/ccpanes-a/SKILL.md")).unwrap(),
            "# a v2"
        );

        // 所选技能下架：子集作废，不再重建
        std::fs::remove_dir_all(builtin.join("skills/ccpanes-a")).unwrap();
        refresh_builtin_sets(&builtin);
        assert!(!subset.exists());
    }
}
