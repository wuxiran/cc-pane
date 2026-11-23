//! 项目级技能链接的会话租约（docs/110 §7 #1，见 [`crate::project_skills`]）：
//! `<data>/cli-adapters/project-skill-leases/<session>.json` 记 CLI、项目与本会话要的技能名，
//! 与批 2 的 MCP 租约分目录存放（同一会话可能同时持有两种租约）。

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::json;
use tracing::warn;

use crate::project_mcp_files::LEASE_TTL;

fn leases_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("cli-adapters").join("project-skill-leases")
}

pub(crate) fn lease_path(data_dir: &Path, session_id: &str) -> Option<PathBuf> {
    let safe = !session_id.is_empty()
        && session_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_');
    safe.then(|| leases_dir(data_dir).join(format!("{session_id}.json")))
}

pub(crate) fn write_lease(path: &Path, cli_id: &str, project: &Path, skills: &[String]) {
    let body =
        json!({ "cliId": cli_id, "projectPath": project.to_string_lossy(), "skills": skills });
    let written = path
        .parent()
        .map_or(Ok(()), fs::create_dir_all)
        .and_then(|()| fs::write(path, body.to_string()));
    if let Err(error) = written {
        warn!(%error, "project skills: failed to record session lease");
    }
}

pub(crate) fn read_lease(path: &Path) -> Option<(String, PathBuf, Vec<String>)> {
    let value: serde_json::Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    let skills = value
        .get("skills")?
        .as_array()?
        .iter()
        .filter_map(|name| name.as_str().map(str::to_string))
        .collect();
    Some((
        value.get("cliId")?.as_str()?.to_string(),
        PathBuf::from(value.get("projectPath")?.as_str()?),
        skills,
    ))
}

/// 同 (CLI, 项目) 其他有效租约要的技能名；超过 [`LEASE_TTL`] 的崩溃遗留不算。
pub(crate) fn skills_wanted_by_other_leases(
    data_dir: &Path,
    cli_id: &str,
    project: &Path,
) -> BTreeSet<String> {
    let Ok(entries) = fs::read_dir(leases_dir(data_dir)) else {
        return BTreeSet::new();
    };
    let now = SystemTime::now();
    entries
        .flatten()
        .filter(|entry| {
            entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|modified| now.duration_since(modified).ok())
                .is_some_and(|age| age < LEASE_TTL)
        })
        .filter_map(|entry| read_lease(&entry.path()))
        .filter(|(other_cli, other_project, _)| other_cli == cli_id && other_project == project)
        .flat_map(|(_, _, skills)| skills)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hostile_session_ids_never_get_a_lease() {
        assert!(lease_path(Path::new("/data"), "../x").is_none());
        assert!(lease_path(Path::new("/data"), "").is_none());
        assert!(lease_path(Path::new("/data"), "ok-1_a").is_some());
    }
}
