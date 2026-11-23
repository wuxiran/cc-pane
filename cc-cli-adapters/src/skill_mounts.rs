//! 技能挂载补齐（docs/110 批 1）。
//!
//! `CliAdapterContext::skill_mount_paths` 里的每一项都是一个 **Claude 插件根**
//! （`.claude-plugin/plugin.json` + `skills/<name>/SKILL.md`）：内置 `skills/builtin`、
//! 子集 `skills/builtin-sets/<hash>`、工作空间技能 `workspaces/<name>/skills`。
//! Claude 直接消费它们（不经本模块），Codex 经 [`crate::project_skills`] 链接进项目；
//! 其余 CLI 按各自的参数形态取用：
//!
//! - 认 Claude 插件布局的（grok / omp `--plugin-dir`）直接传挂载根；
//! - 认技能目录的（kimi `--skills-dir`、opencode `skills.paths`）传 `<根>/skills`；
//! - 认单个技能的（pi `--skill`）逐个传 `<根>/skills/<name>`；
//! - 需要别的布局的（cursor 插件清单、antigravity `.agents/skills`）先拼成**每会话
//!   staging 目录** `<data_dir>/skill-staging/<session_id>/`（符号链接，建不了链接时复制），
//!   会话结束由 [`retire_session_staging`] 打退休标记、下次 staging 时由
//!   [`crate::mcp_config_lifecycle`] 的同款规则回收。
//!
//! 只读挂载源，绝不写用户的 CLI 主目录（docs/97「零写入」）。

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tracing::warn;

/// staging 根目录名（`<data_dir>/skill-staging/`）。
pub const SKILL_STAGING_DIR_NAME: &str = "skill-staging";
/// staging 目录同时是一个插件：Claude / Cursor 两种清单里的名字。
pub const SESSION_PLUGIN_NAME: &str = "ccpanes-session-skills";
/// 退休后保留多久再回收：会话已退出，staging 只是链接，短保留即可。
pub const RETIRED_STAGING_RETENTION: Duration = Duration::from_secs(60 * 60);
const SKILLS_SUBDIR: &str = "skills";
const SKILL_FILE: &str = "SKILL.md";

/// 挂载根下的技能目录：`<根>/skills` 存在就用它，否则（根本身就是技能目录）用根。
pub fn mount_skill_roots(mounts: &[String]) -> Vec<PathBuf> {
    mounts
        .iter()
        .map(|mount| PathBuf::from(mount.trim()))
        .filter(|root| !root.as_os_str().is_empty() && root.is_dir())
        .map(|root| {
            let skills = root.join(SKILLS_SUBDIR);
            if skills.is_dir() {
                skills
            } else {
                root
            }
        })
        .collect()
}

/// 所有挂载根里的单个技能（含 `SKILL.md` 的直接子目录），按目录名去重，先出现的胜出
/// （内置在前、工作空间在后，与 `skill_mount_paths_for_profile` 的顺序一致）。
pub fn mount_skill_dirs(mounts: &[String]) -> Vec<(String, PathBuf)> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for root in mount_skill_roots(mounts) {
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        let mut dirs: Vec<(String, PathBuf)> = entries
            .flatten()
            .map(|entry| {
                (
                    entry.file_name().to_string_lossy().into_owned(),
                    entry.path(),
                )
            })
            .filter(|(name, path)| !name.starts_with('.') && path.join(SKILL_FILE).is_file())
            .collect();
        dirs.sort();
        for (name, path) in dirs {
            if seen.insert(name.clone()) {
                out.push((name, path));
            } else {
                warn!(skill = %name, path = %path.display(), "skill mount: duplicate skill name, keeping the first");
            }
        }
    }
    out
}

/// staging 要额外摆出的布局。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StagingLayout {
    /// `.cursor-plugin/plugin.json`（Cursor 插件清单；`skills/` 走默认发现）。
    pub cursor_plugin: bool,
    /// `.agents/skills/<name>`（antigravity 把 `--add-dir` 目录当工作区根读它）。
    pub agents_skills: bool,
}

/// `<data_dir>/skill-staging/<session_id>`
pub fn session_staging_dir(data_dir: &Path, session_id: &str) -> Option<PathBuf> {
    let safe = session_id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_');
    (!session_id.is_empty() && safe).then(|| data_dir.join(SKILL_STAGING_DIR_NAME).join(session_id))
}

/// 把挂载根里的技能拼成每会话 staging 目录，返回目录路径。没有任何技能（或会话 id
/// 不安全）时返回 None，调用方不传参数。失败只 warn：技能缺失不致命。
///
/// 布局（两种清单 + 技能目录，一份目录同时满足 Claude 插件 / Cursor 插件 / 技能目录）：
/// `skills/<name>` → 源技能目录的链接；`.claude-plugin/plugin.json`；按 `layout` 追加
/// `.cursor-plugin/plugin.json` 与 `.agents/skills/<name>`。
pub fn stage_session_skills(
    data_dir: &Path,
    session_id: &str,
    mounts: &[String],
    layout: StagingLayout,
) -> Option<PathBuf> {
    let skills = mount_skill_dirs(mounts);
    if skills.is_empty() {
        return None;
    }
    let dir = session_staging_dir(data_dir, session_id)?;
    if let Some(parent) = dir.parent() {
        collect_retired_stagings(parent, session_id);
    }
    match build_staging(&dir, &skills, layout) {
        Ok(()) => Some(dir),
        Err(error) => {
            warn!(dir = %dir.display(), %error, "skill staging: failed to build per-session directory");
            let _ = fs::remove_dir_all(&dir);
            None
        }
    }
}

fn build_staging(
    dir: &Path,
    skills: &[(String, PathBuf)],
    layout: StagingLayout,
) -> io::Result<()> {
    if fs::symlink_metadata(dir).is_ok() {
        fs::remove_dir_all(dir)?;
    }
    let _ = fs::remove_file(retired_marker(dir));
    let manifest = format!(
        "{{\n  \"name\": \"{SESSION_PLUGIN_NAME}\",\n  \"version\": \"1.0.0\",\n  \"description\": \"CC-Panes skills mounted for this session\"\n}}\n"
    );
    write_file(&dir.join(".claude-plugin").join("plugin.json"), &manifest)?;
    if layout.cursor_plugin {
        write_file(&dir.join(".cursor-plugin").join("plugin.json"), &manifest)?;
    }
    let mut targets = vec![dir.join(SKILLS_SUBDIR)];
    if layout.agents_skills {
        targets.push(dir.join(".agents").join(SKILLS_SUBDIR));
    }
    for target_root in &targets {
        fs::create_dir_all(target_root)?;
        for (name, source) in skills {
            link_or_copy_dir(source, &target_root.join(name))?;
        }
    }
    Ok(())
}

fn write_file(path: &Path, content: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)
}

/// [`link_or_copy_dir`] 实际落下的形态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LinkKind {
    Symlink,
    Copy,
}

/// 目录链接；平台不允许（Windows 未开开发者模式）时退回递归复制。
pub(crate) fn link_or_copy_dir(source: &Path, target: &Path) -> io::Result<LinkKind> {
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(source, target);
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_dir(source, target);
    #[cfg(not(any(unix, windows)))]
    let linked: io::Result<()> = Err(io::Error::from(io::ErrorKind::Unsupported));
    match linked {
        Ok(()) => Ok(LinkKind::Symlink),
        Err(_) => copy_dir_recursive(source, target).map(|()| LinkKind::Copy),
    }
}

fn copy_dir_recursive(source: &Path, target: &Path) -> io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn retired_marker(dir: &Path) -> PathBuf {
    let mut name = dir.file_name().unwrap_or_default().to_os_string();
    name.push(".retired");
    dir.with_file_name(name)
}

/// 会话真正退出时调用：给 staging 打退休标记（重复调用不刷新时间）。
pub fn retire_session_staging(data_dir: &Path, session_id: &str) {
    let Some(dir) = session_staging_dir(data_dir, session_id) else {
        return;
    };
    if !dir.is_dir() {
        return;
    }
    let marker = retired_marker(&dir);
    if marker.exists() {
        return;
    }
    if let Err(error) = fs::write(&marker, b"cc-panes-skill-staging-retired-v1\n") {
        warn!(dir = %dir.display(), %error, "skill staging: failed to mark retired");
    }
}

/// 回收退休超过保留期的 staging。没有退休标记的（崩溃遗留 / 正在用）一律保留，
/// 与 `mcp_config_lifecycle::collect_retired_configs` 同一条规则。
pub fn collect_retired_stagings(staging_root: &Path, current_session: &str) {
    collect_at(staging_root, current_session, std::time::SystemTime::now());
}

fn collect_at(staging_root: &Path, current_session: &str, now: std::time::SystemTime) {
    let Ok(entries) = fs::read_dir(staging_root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == current_session || name.ends_with(".retired") {
            continue;
        }
        let dir = entry.path();
        let marker = retired_marker(&dir);
        let is_real_dir = fs::symlink_metadata(&dir).is_ok_and(|meta| meta.is_dir());
        let expired = fs::metadata(&marker)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > RETIRED_STAGING_RETENTION);
        if is_real_dir && expired {
            if let Err(error) = fs::remove_dir_all(&dir).and_then(|_| fs::remove_file(&marker)) {
                warn!(dir = %dir.display(), %error, "skill staging: failed to collect retired directory");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plugin(root: &Path, skills: &[&str]) -> String {
        fs::create_dir_all(root.join(".claude-plugin")).unwrap();
        fs::write(root.join(".claude-plugin/plugin.json"), "{}").unwrap();
        for name in skills {
            let dir = root.join("skills").join(name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join(SKILL_FILE),
                format!("---\nname: {name}\n---\nbody-{name}\n"),
            )
            .unwrap();
        }
        root.to_string_lossy().into_owned()
    }

    #[test]
    fn skill_dirs_are_deduplicated_first_wins_and_skip_non_skills() {
        let temp = tempfile::tempdir().unwrap();
        let builtin = plugin(&temp.path().join("builtin"), &["ccpanes-a", "shared"]);
        let workspace = plugin(&temp.path().join("ws"), &["shared", "team"]);
        fs::create_dir_all(temp.path().join("ws/skills/not-a-skill")).unwrap();
        let dirs = mount_skill_dirs(&[builtin.clone(), workspace, "/does/not/exist".into()]);
        let names: Vec<_> = dirs.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, vec!["ccpanes-a", "shared", "team"]);
        assert!(dirs[1].1.starts_with(&builtin));
        assert_eq!(
            mount_skill_roots(&[builtin.clone()]),
            vec![PathBuf::from(&builtin).join("skills")]
        );
    }

    #[test]
    fn staging_builds_both_manifests_and_agents_layout() {
        let temp = tempfile::tempdir().unwrap();
        let builtin = plugin(&temp.path().join("builtin"), &["ccpanes-a"]);
        let data = temp.path().join("data");
        let layout = StagingLayout {
            cursor_plugin: true,
            agents_skills: true,
        };
        let dir = stage_session_skills(&data, "sess-1", &[builtin], layout).unwrap();
        assert!(dir.join(".claude-plugin/plugin.json").is_file());
        assert!(fs::read_to_string(dir.join(".cursor-plugin/plugin.json"))
            .unwrap()
            .contains(SESSION_PLUGIN_NAME));
        assert!(fs::read_to_string(dir.join("skills/ccpanes-a/SKILL.md"))
            .unwrap()
            .contains("body-ccpanes-a"));
        assert!(dir.join(".agents/skills/ccpanes-a/SKILL.md").is_file());
        // 重建是幂等的：同一会话再 staging 一次不报错
        assert!(stage_session_skills(
            &data,
            "sess-1",
            &[plugin(&temp.path().join("builtin"), &["ccpanes-a"])],
            layout
        )
        .is_some());
    }

    #[test]
    fn no_skills_or_unsafe_session_means_no_staging() {
        let temp = tempfile::tempdir().unwrap();
        let empty = temp.path().join("empty");
        fs::create_dir_all(&empty).unwrap();
        let data = temp.path().join("data");
        let mounts = [empty.to_string_lossy().into_owned()];
        assert!(stage_session_skills(&data, "sess", &mounts, StagingLayout::default()).is_none());
        let builtin = plugin(&temp.path().join("b"), &["x"]);
        assert!(
            stage_session_skills(&data, "../evil", &[builtin], StagingLayout::default()).is_none()
        );
        assert!(!data.join(SKILL_STAGING_DIR_NAME).exists());
    }

    #[test]
    fn retired_staging_is_collected_after_retention_but_sources_survive() {
        let temp = tempfile::tempdir().unwrap();
        let builtin = plugin(&temp.path().join("builtin"), &["ccpanes-a"]);
        let data = temp.path().join("data");
        let dir = stage_session_skills(&data, "old", &[builtin.clone()], StagingLayout::default())
            .unwrap();
        let root = dir.parent().unwrap().to_path_buf();
        collect_at(
            &root,
            "new",
            std::time::SystemTime::now() + RETIRED_STAGING_RETENTION * 2,
        );
        assert!(
            dir.is_dir(),
            "no retirement marker means the session may still be alive"
        );
        retire_session_staging(&data, "old");
        collect_at(&root, "new", std::time::SystemTime::now());
        assert!(dir.is_dir(), "retention not yet elapsed");
        collect_at(
            &root,
            "new",
            std::time::SystemTime::now() + RETIRED_STAGING_RETENTION * 2,
        );
        assert!(!dir.exists());
        assert!(!retired_marker(&dir).exists());
        assert!(Path::new(&builtin)
            .join("skills/ccpanes-a/SKILL.md")
            .is_file());
    }
}
