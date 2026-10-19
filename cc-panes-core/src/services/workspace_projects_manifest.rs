//! `.ccpanes/projects.yaml`：工作空间根目录下给 LLM 看的项目清单，代码里没有消费方。
//!
//! 工作空间目录可能放在网盘同步目录里，由多台机器（Windows / macOS / Linux）共用。
//! 每台机器只知道自己注册的项目，所以清单按机器分段，写入时只替换本机那一段，
//! 其他机器的段原样保留——否则谁最后改项目，清单里就只剩谁的项目。
//!
//! 旧版写的是 `.ccpanes/projects.csv`（整份覆盖、无机器信息）。本机写入时把 csv 里的行并入
//! 清单后删除 csv：属于本机项目的行由本机接管，其余行归入 `unattributed` 段，不猜测归属、不丢弃。

use crate::utils::project_paths_equivalent;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

pub(crate) const MANIFEST_FILE_NAME: &str = "projects.yaml";
pub(crate) const LEGACY_CSV_FILE_NAME: &str = "projects.csv";
/// 旧 csv 里无法判断属于哪台机器的行
pub(crate) const UNATTRIBUTED_MACHINE: &str = "unattributed";

const MANIFEST_HEADER: &str = "\
# CC-Panes 项目清单（给 AI 的上下文，由 CC-Panes 自动生成，代码无消费方）。
# 按机器分段：工作空间目录被多台机器同步共用时，每台机器只改写自己那一段。
# 只有 machines 下与当前主机名相同的那一段路径在本机可用。
";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ProjectsManifest {
    #[serde(default)]
    pub machines: BTreeMap<String, MachineProjects>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct MachineProjects {
    #[serde(default)]
    pub projects: Vec<ManifestProject>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ManifestProject {
    pub path: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub alias: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub branch: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub status: String,
}

/// 本机标识：主机名，去掉 macOS mDNS 的 `.local` 后缀（随网络环境时有时无）。
pub(crate) fn current_machine_label() -> String {
    let raw = sysinfo::System::host_name().unwrap_or_default();
    let trimmed = raw.trim();
    let name = trimmed.strip_suffix(".local").unwrap_or(trimmed);
    if name.is_empty() {
        "unknown-host".to_string()
    } else {
        name.to_string()
    }
}

/// 读本机视角下的现有清单：yaml 解析失败按空清单处理（派生文件，下次写入即修复）；
/// 旧 csv 还在的话并入（csv 有 machine 列则按列归属，否则归入 `unattributed`）。
pub(crate) fn load(ccpanes_dir: &Path) -> ProjectsManifest {
    let mut manifest = fs::read_to_string(ccpanes_dir.join(MANIFEST_FILE_NAME))
        .ok()
        .and_then(|content| serde_yaml::from_str::<ProjectsManifest>(&content).ok())
        .unwrap_or_default();
    if let Ok(csv) = fs::read_to_string(ccpanes_dir.join(LEGACY_CSV_FILE_NAME)) {
        import_legacy_csv(&mut manifest, &csv);
    }
    manifest
}

/// 用本机项目替换本机那一段；其他段里与本机项目等价的路径一并移除（旧行被本机接管）。
pub(crate) fn replace_machine(
    manifest: &mut ProjectsManifest,
    machine: &str,
    projects: Vec<ManifestProject>,
) {
    for (name, section) in manifest.machines.iter_mut() {
        if name == machine {
            continue;
        }
        section.projects.retain(|existing| {
            !projects
                .iter()
                .any(|local| project_paths_equivalent(&local.path, &existing.path))
        });
    }
    manifest
        .machines
        .retain(|name, section| name != machine && !section.projects.is_empty());
    if !projects.is_empty() {
        manifest
            .machines
            .insert(machine.to_string(), MachineProjects { projects });
    }
}

pub(crate) fn render(manifest: &ProjectsManifest) -> Result<String, String> {
    let body = serde_yaml::to_string(manifest)
        .map_err(|e| format!("Failed to serialize projects.yaml: {e}"))?;
    Ok(format!("{MANIFEST_HEADER}{body}"))
}

/// 原子写入清单（内容没变则不写，避免无谓触发网盘同步），成功后删掉旧 csv。
pub(crate) fn save(ccpanes_dir: &Path, manifest: &ProjectsManifest) -> Result<(), String> {
    let path = ccpanes_dir.join(MANIFEST_FILE_NAME);
    let content = render(manifest)?;
    if fs::read_to_string(&path).ok().as_deref() != Some(content.as_str()) {
        let tmp_path = ccpanes_dir.join(format!("{MANIFEST_FILE_NAME}.{}.tmp", std::process::id()));
        fs::write(&tmp_path, content.as_bytes())
            .map_err(|e| format!("Failed to write projects.yaml: {e}"))?;
        fs::rename(&tmp_path, &path).map_err(|e| {
            let _ = fs::remove_file(&tmp_path);
            format!("Failed to replace projects.yaml: {e}")
        })?;
    }
    let legacy = ccpanes_dir.join(LEGACY_CSV_FILE_NAME);
    if legacy.exists() {
        let _ = fs::remove_file(legacy);
    }
    Ok(())
}

fn import_legacy_csv(manifest: &mut ProjectsManifest, content: &str) {
    let mut lines = content.lines().filter(|line| !line.trim().is_empty());
    let Some(header) = lines.next() else {
        return;
    };
    let columns: Vec<String> = split_csv_line(header)
        .into_iter()
        .map(|c| c.trim().to_ascii_lowercase())
        .collect();
    let index_of = |name: &str| columns.iter().position(|c| c == name);
    let Some(path_idx) = index_of("path") else {
        return;
    };
    let (alias_idx, branch_idx, status_idx, machine_idx) = (
        index_of("alias"),
        index_of("branch"),
        index_of("status"),
        index_of("machine"),
    );

    for line in lines {
        let fields = split_csv_line(line);
        let get = |idx: Option<usize>| {
            idx.and_then(|i| fields.get(i))
                .map(|v| v.trim().to_string())
                .unwrap_or_default()
        };
        let path = get(Some(path_idx));
        let already_listed = manifest.machines.values().any(|section| {
            section
                .projects
                .iter()
                .any(|p| project_paths_equivalent(&p.path, &path))
        });
        if path.is_empty() || already_listed {
            continue;
        }
        let machine = Some(get(machine_idx))
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| UNATTRIBUTED_MACHINE.to_string());
        manifest
            .machines
            .entry(machine)
            .or_default()
            .projects
            .push(ManifestProject {
                path,
                alias: get(alias_idx),
                branch: get(branch_idx),
                status: get(status_idx),
            });
    }
}

/// 按 RFC 4180 拆一行：支持双引号包裹与 `""` 转义（路径里可能有逗号）。
fn split_csv_line(line: &str) -> Vec<String> {
    let line = line.strip_suffix('\r').unwrap_or(line);
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' if in_quotes && chars.peek() == Some(&'"') => {
                current.push('"');
                chars.next();
            }
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes => fields.push(std::mem::take(&mut current)),
            _ => current.push(ch),
        }
    }
    fields.push(current);
    fields
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(path: &str) -> ManifestProject {
        ManifestProject {
            path: path.to_string(),
            alias: String::new(),
            branch: "main".to_string(),
            status: "clean".to_string(),
        }
    }

    fn paths(manifest: &ProjectsManifest, machine: &str) -> Vec<String> {
        manifest
            .machines
            .get(machine)
            .map(|s| s.projects.iter().map(|p| p.path.clone()).collect())
            .unwrap_or_default()
    }

    #[test]
    fn alternating_writers_never_drop_each_other() {
        let mut manifest = ProjectsManifest::default();
        replace_machine(&mut manifest, "win", vec![project(r"D:\a")]);
        replace_machine(&mut manifest, "mac", vec![project("/Users/me/b")]);
        replace_machine(
            &mut manifest,
            "win",
            vec![project(r"D:\a"), project(r"D:\c")],
        );
        assert_eq!(paths(&manifest, "win"), vec![r"D:\a", r"D:\c"]);
        assert_eq!(paths(&manifest, "mac"), vec!["/Users/me/b"]);

        // 本机清空项目只去掉本机那一段
        replace_machine(&mut manifest, "mac", Vec::new());
        assert!(!manifest.machines.contains_key("mac"));
        assert_eq!(paths(&manifest, "win"), vec![r"D:\a", r"D:\c"]);
    }

    #[test]
    fn render_then_parse_round_trips_awkward_paths() {
        let mut manifest = ProjectsManifest::default();
        let mut quoted = project(r"D:\repos\a,b: #1");
        quoted.alias = "say \"hi\"".to_string();
        replace_machine(&mut manifest, "win-pc", vec![quoted]);
        replace_machine(
            &mut manifest,
            "mac",
            vec![project(r"\\wsl.localhost\Ubuntu\home\me\x")],
        );
        let rendered = render(&manifest).unwrap();
        assert!(rendered.starts_with("# CC-Panes"));
        assert_eq!(
            serde_yaml::from_str::<ProjectsManifest>(&rendered).unwrap(),
            manifest
        );
    }

    #[test]
    fn legacy_csv_is_imported_then_adopted_by_owner() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(LEGACY_CSV_FILE_NAME),
            "path,alias,branch,status\r\nD:\\repos\\team,,main,clean\r\n\"/Users/me/a,b\",x,dev,dirty\r\n",
        )
        .unwrap();

        let mut manifest = load(dir.path());
        assert_eq!(
            paths(&manifest, UNATTRIBUTED_MACHINE),
            vec![r"D:\repos\team", "/Users/me/a,b"]
        );

        replace_machine(&mut manifest, "mac", vec![project("/Users/me/a,b")]);
        save(dir.path(), &manifest).unwrap();

        assert!(!dir.path().join(LEGACY_CSV_FILE_NAME).exists());
        let reloaded = load(dir.path());
        assert_eq!(
            paths(&reloaded, UNATTRIBUTED_MACHINE),
            vec![r"D:\repos\team"]
        );
        assert_eq!(paths(&reloaded, "mac"), vec!["/Users/me/a,b"]);
    }

    #[test]
    fn csv_written_later_by_old_version_is_merged_not_duplicated() {
        let dir = tempfile::tempdir().unwrap();
        let mut manifest = ProjectsManifest::default();
        replace_machine(&mut manifest, "mac", vec![project("/Users/me/b")]);
        save(dir.path(), &manifest).unwrap();
        // 另一台机器的旧版本又整份写了一次 csv
        fs::write(
            dir.path().join(LEGACY_CSV_FILE_NAME),
            "path,alias,branch,status\n/Users/me/b,,main,clean\nD:\\a,,main,clean\n",
        )
        .unwrap();

        let reloaded = load(dir.path());
        assert_eq!(paths(&reloaded, "mac"), vec!["/Users/me/b"]);
        assert_eq!(paths(&reloaded, UNATTRIBUTED_MACHINE), vec![r"D:\a"]);
    }

    #[test]
    fn corrupt_yaml_or_headerless_csv_degrades_to_empty() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(MANIFEST_FILE_NAME), "machines: [oops").unwrap();
        fs::write(dir.path().join(LEGACY_CSV_FILE_NAME), "foo,bar\n1,2\n").unwrap();
        assert_eq!(load(dir.path()), ProjectsManifest::default());
    }

    #[test]
    fn machine_label_is_never_empty() {
        let label = current_machine_label();
        assert!(!label.is_empty());
        assert!(!label.ends_with(".local"));
    }
}
