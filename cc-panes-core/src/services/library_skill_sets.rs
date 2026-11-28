//! 资源库技能原生挂载（docs/109 第 2 批 D）。
//!
//! 启动档选中的 `user:<id>` 物化成一个 Claude 插件根
//! `<data>/skills/library-sets/<sha256(选择)[..16]>/`：`.claude-plugin/plugin.json`
//! 加 `skills/<id>/`（Unix 符号链接到库里的技能目录，Windows 复制）。物化逻辑复用
//! `builtin_skill_sets`；挂载方式也与内置技能一致——目录追加进 `skill_mount_paths`，
//! Claude / Cursor 走 `--plugin-dir`，Codex 链接进项目 `.agents/skills`，其余 adapter 同理。
//!
//! 原生挂载的技能，CLI 只把 name + description 放进上下文、正文按需加载，所以
//! `LaunchProfileService` 不再内联它们。回退规则集中在 [`library_skills_mountable`]：
//! adapter 不消费挂载、或运行时是 WSL / SSH（路径映射不了）时整组内联；
//! 单个技能缺 frontmatter `name` / `description`（CLI 认不出）时只把它内联；
//! 物化失败时打 warn 并整组内联——宁可多占上下文，不能让会话丢技能。

use crate::services::builtin_skill_sets::{link_or_copy_dir, materialize_into, set_dir_name};
use crate::services::{skill_frontmatter_field, UserSkillContent};
use cc_cli_adapters::InjectionProfile;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use tracing::warn;

pub const LIBRARY_SETS_DIR_NAME: &str = "library-sets";
/// 插件名即 Claude 菜单里的命名空间前缀（`ccpanes-library:<id>`）。
pub const LIBRARY_PLUGIN_NAME: &str = "ccpanes-library";
const SET_MANIFEST_FILE: &str = ".ccpanes-library-set";
const SKILLS_SUBDIR: &str = "skills";

/// 本次启动原生挂载的资源库技能。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibrarySkillMount {
    /// 插件根，追加进 `skill_mount_paths`。
    pub dir: PathBuf,
    /// 已挂载的技能 id（不带 `user:` 前缀），这些不再内联进提示词。
    pub mounted_ids: BTreeSet<String>,
}

/// 回退规则（唯一一处）：只有本机运行、且 adapter 真正消费 `skill_mount_paths` 时才原生挂载。
/// WSL / SSH 的挂载路径要经翻译或根本到不了远端，资源库技能一律内联。
pub fn library_skills_mountable(injection: &InjectionProfile, runtime_kind: &str) -> bool {
    runtime_kind == "local" && injection.skill_mounts_consumed(runtime_kind)
}

/// CLI 认技能靠 SKILL.md frontmatter 的 `name` + `description`；缺了就挂不上，留给内联。
fn natively_loadable(skill: &UserSkillContent) -> Option<PathBuf> {
    let has = |key: &str| {
        skill_frontmatter_field(&skill.content, key).is_some_and(|value| !value.trim().is_empty())
    };
    if !has("name") || !has("description") {
        return None;
    }
    let dir = Path::new(skill.skill.file_path.as_deref()?).parent()?;
    dir.is_dir().then(|| dir.to_path_buf())
}

/// 同一选择复用同一目录。Unix 下是链接，库里技能更新即生效；复制的平台把
/// SKILL.md 的大小和修改时间也算进 key，内容变了就换新目录。
fn selection_key(skills: &BTreeMap<String, PathBuf>) -> String {
    skills
        .iter()
        .map(|(id, dir)| {
            let mut line = format!("{id}\t{}", dir.display());
            if cfg!(not(unix)) {
                if let Ok(meta) = std::fs::metadata(dir.join("SKILL.md")) {
                    let modified = meta
                        .modified()
                        .ok()
                        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|age| age.as_nanos())
                        .unwrap_or_default();
                    line.push_str(&format!("\t{}\t{modified}", meta.len()));
                }
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn build_library_set(dest: &Path, skills: &BTreeMap<String, PathBuf>) -> std::io::Result<()> {
    let manifest = serde_json::json!({
        "name": LIBRARY_PLUGIN_NAME,
        "description": "CC-Panes library skills selected by the launch profile",
        "author": { "name": "CC-Panes" },
    });
    let plugin_dir = dest.join(".claude-plugin");
    std::fs::create_dir_all(&plugin_dir)?;
    std::fs::write(
        plugin_dir.join("plugin.json"),
        serde_json::to_vec_pretty(&manifest).map_err(std::io::Error::other)?,
    )?;
    let skills_dir = dest.join(SKILLS_SUBDIR);
    std::fs::create_dir_all(&skills_dir)?;
    for (id, source) in skills {
        link_or_copy_dir(source, &skills_dir.join(id))?;
    }
    let ids = skills.keys().cloned().collect::<Vec<_>>().join("\n");
    std::fs::write(dest.join(SET_MANIFEST_FILE), ids)
}

/// 把选中的资源库技能物化成可挂载的插件根。没有能原生加载的技能、或物化失败时返回 `None`
/// （调用方全部内联）。`skills_root` 是 `<data>/skills`。
pub fn library_mount_dir(
    skills_root: &Path,
    selected: &[UserSkillContent],
) -> Option<LibrarySkillMount> {
    let skills: BTreeMap<String, PathBuf> = selected
        .iter()
        .filter_map(|skill| Some((skill.skill.id.clone(), natively_loadable(skill)?)))
        .collect();
    if skills.is_empty() {
        return None;
    }
    let sets_dir = skills_root.join(LIBRARY_SETS_DIR_NAME);
    let target = sets_dir.join(set_dir_name(&selection_key(&skills)));
    if !target.join(SET_MANIFEST_FILE).is_file() {
        if let Err(error) =
            materialize_into(&sets_dir, &target, |dest| build_library_set(dest, &skills))
        {
            warn!(
                "[library_skill_sets] failed to materialize {}: {}; inlining library skills instead",
                target.display(),
                error
            );
            return None;
        }
    }
    Some(LibrarySkillMount {
        dir: target,
        mounted_ids: skills.into_keys().collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::InstalledUserSkill;

    pub(crate) fn user_skill(root: &Path, id: &str, content: &str) -> UserSkillContent {
        let dir = root.join("skills").join("user").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        let md = dir.join("SKILL.md");
        std::fs::write(&md, content).unwrap();
        UserSkillContent {
            skill: InstalledUserSkill {
                id: id.into(),
                name: id.into(),
                description: None,
                category: None,
                tags: Vec::new(),
                version: "1".into(),
                license: None,
                homepage_url: None,
                source_url: None,
                content_sha256: "x".into(),
                installed_at: "t".into(),
                file_path: Some(md.to_string_lossy().into_owned()),
                provenance: None,
                gone: false,
            },
            content: content.into(),
        }
    }

    fn good(id: &str) -> String {
        format!("---\nname: {id}\ndescription: does {id}\n---\nbody")
    }

    #[test]
    fn materializes_plugin_root_and_reuses_it() {
        let tmp = tempfile::tempdir().unwrap();
        let skills_root = tmp.path().join("skills");
        let a = user_skill(tmp.path(), "alpha", &good("alpha"));
        let b = user_skill(tmp.path(), "beta", &good("beta"));

        let mount = library_mount_dir(&skills_root, &[a.clone(), b.clone()]).unwrap();
        assert_eq!(
            mount.dir.parent().unwrap(),
            skills_root.join(LIBRARY_SETS_DIR_NAME)
        );
        let manifest: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(mount.dir.join(".claude-plugin/plugin.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["name"], LIBRARY_PLUGIN_NAME);
        assert!(mount.dir.join("skills/alpha/SKILL.md").is_file());
        assert!(mount.dir.join("skills/beta/SKILL.md").is_file());
        assert_eq!(
            mount.mounted_ids.iter().cloned().collect::<Vec<_>>(),
            vec!["alpha", "beta"]
        );

        // 顺序不同的同一选择复用同一目录
        let again = library_mount_dir(&skills_root, &[b, a]).unwrap();
        assert_eq!(again.dir, mount.dir);
        let sets = std::fs::read_dir(skills_root.join(LIBRARY_SETS_DIR_NAME))
            .unwrap()
            .count();
        assert_eq!(sets, 1);
    }

    #[test]
    fn skills_without_frontmatter_stay_out_of_the_mount() {
        let tmp = tempfile::tempdir().unwrap();
        let skills_root = tmp.path().join("skills");
        let plain = user_skill(tmp.path(), "plain", "# no frontmatter");
        let no_desc = user_skill(tmp.path(), "nodesc", "---\nname: nodesc\n---\nbody");
        assert!(library_mount_dir(&skills_root, &[plain.clone(), no_desc]).is_none());

        let ok = user_skill(tmp.path(), "ok", &good("ok"));
        let mount = library_mount_dir(&skills_root, &[plain, ok]).unwrap();
        assert_eq!(mount.mounted_ids.len(), 1);
        assert!(!mount.dir.join("skills/plain").exists());
    }

    #[test]
    fn materialize_failure_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        // skills 根是个文件，建不了 library-sets/
        let skills_root = tmp.path().join("skills-file");
        std::fs::write(&skills_root, "x").unwrap();
        let a = user_skill(tmp.path(), "alpha", &good("alpha"));
        assert!(library_mount_dir(&skills_root, &[a]).is_none());
    }

    #[test]
    fn only_local_runtimes_whose_adapter_consumes_mounts_are_mountable() {
        let registry = cc_cli_adapters::CliToolRegistry::with_builtin_adapters();
        let profile = |id: &str| registry.get(id).unwrap().injection_profile();
        for id in ["claude", "codex", "cursor"] {
            assert!(library_skills_mountable(&profile(id), "local"), "{id}");
            assert!(!library_skills_mountable(&profile(id), "wsl"), "{id} wsl");
            assert!(!library_skills_mountable(&profile(id), "ssh"), "{id} ssh");
        }
        // 没有原生技能通道的 CLI 回退内联
        assert!(!library_skills_mountable(&profile("jcode"), "local"));
    }
}
