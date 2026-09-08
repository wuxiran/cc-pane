//! Skills 管理端核心：中央仓库 + 多 Agent 目录 Junction/Symlink 启停。
//! 语义与 K:\AI\skill-manager（PowerShell/Node 版）对齐：
//! 启用 = 在 <工作空间根>/<.工具名>/skills/<技能> 创建指向中央仓库原件的链接；
//! 禁用 = 只移除链接本体，绝不删除真实目录。
use crate::models::link_skill::{
    AddWorkspaceOutcome, DisableCounts, EnableCounts, LinkAgent, LinkSnapshot, LinkState,
    LinkWorkspace, ManagedSkill, SkillAgentState,
};
use crate::utils::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const SKILL_MD: &str = "SKILL.md";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LockEntry {
    #[serde(default)]
    source: String,
    #[serde(default, rename = "sourceUrl")]
    source_url: String,
}

/// 配置（与 Skills 管理端 config.json 同构，可直接互拷）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillLinkConfig {
    pub master_dir: String,
    #[serde(default)]
    pub skill_repo_map: BTreeMap<String, String>,
    #[serde(default = "default_agents")]
    pub agents: Vec<LinkAgent>,
    #[serde(default = "default_workspaces")]
    pub workspaces: Vec<LinkWorkspace>,
    #[serde(default)]
    pub active_workspace: String,
}

fn default_agents() -> Vec<LinkAgent> {
    vec![
        LinkAgent {
            name: "ZCode".into(),
            folder: ".zcode".into(),
        },
        LinkAgent {
            name: "Claude".into(),
            folder: ".claude".into(),
        },
        LinkAgent {
            name: "Codex".into(),
            folder: ".codex".into(),
        },
        LinkAgent {
            name: "Grok".into(),
            folder: ".grok".into(),
        },
        LinkAgent {
            name: "OpenCode".into(),
            folder: ".opencode".into(),
        },
    ]
}

fn default_workspaces() -> Vec<LinkWorkspace> {
    vec![LinkWorkspace {
        name: "全局（用户级）".into(),
        path: String::new(),
    }]
}

impl Default for SkillLinkConfig {
    fn default() -> Self {
        Self {
            master_dir: home_dir()
                .join(".agents")
                .join("skills")
                .to_string_lossy()
                .into_owned(),
            skill_repo_map: BTreeMap::new(),
            agents: default_agents(),
            workspaces: default_workspaces(),
            active_workspace: "全局（用户级）".into(),
        }
    }
}

impl SkillLinkConfig {
    pub fn load_or_default(path: &Path) -> Self {
        match fs::read_to_string(path) {
            Ok(raw) => {
                let raw = raw.trim_start_matches('\u{feff}');
                serde_json::from_str(raw).unwrap_or_default()
            }
            Err(_) => Self::default(),
        }
    }
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// 多 Agent 技能链接管理服务。内部用 Mutex 保护配置（workspace 增删/切换会写盘）。
pub struct SkillLinkService {
    config_path: PathBuf,
    config: Mutex<SkillLinkConfig>,
}

impl SkillLinkService {
    pub fn new(config_path: PathBuf) -> Self {
        let config = SkillLinkConfig::load_or_default(&config_path);
        Self {
            config_path,
            config: Mutex::new(config),
        }
    }

    /// 测试/定制：直接给定配置
    pub fn with_config(config_path: PathBuf, config: SkillLinkConfig) -> Self {
        Self {
            config_path,
            config: Mutex::new(config),
        }
    }

    fn lock_config(&self) -> std::sync::MutexGuard<'_, SkillLinkConfig> {
        self.config.lock().expect("skill link config poisoned")
    }

    fn persist(&self, config: &SkillLinkConfig) -> AppResult<()> {
        if let Some(parent) = self.config_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let content = serde_json::to_string_pretty(config)
            .map_err(|err| AppError::from(format!("serialize skill link config: {err}")))?;
        fs::write(&self.config_path, content)?;
        Ok(())
    }

    fn lock_map(config: &SkillLinkConfig) -> BTreeMap<String, LockEntry> {
        let master = PathBuf::from(&config.master_dir);
        for cand in [
            master.parent().map(|p| p.join(".skill-lock.json")),
            Some(master.join(".skill-lock.json")),
        ]
        .into_iter()
        .flatten()
        {
            if let Ok(text) = fs::read_to_string(&cand) {
                if let Ok(map) = serde_json::from_str::<BTreeMap<String, LockEntry>>(
                    text.trim_start_matches('\u{feff}'),
                ) {
                    return map;
                }
            }
        }
        BTreeMap::new()
    }

    fn workspace<'a>(config: &'a SkillLinkConfig, name: Option<&str>) -> &'a LinkWorkspace {
        let by_name = name
            .filter(|n| !n.trim().is_empty())
            .and_then(|n| config.workspaces.iter().find(|w| w.name == n));
        by_name.unwrap_or_else(|| {
            config
                .workspaces
                .iter()
                .find(|w| w.name == config.active_workspace)
                .unwrap_or(&config.workspaces[0])
        })
    }

    fn workspace_root(ws: &LinkWorkspace) -> PathBuf {
        if ws.path.is_empty() {
            home_dir()
        } else {
            PathBuf::from(&ws.path)
        }
    }

    fn agent_dir(root: &Path, folder: &str) -> PathBuf {
        root.join(folder).join("skills")
    }

    fn link_state(path: &Path) -> LinkState {
        match fs::symlink_metadata(path) {
            Ok(meta) if meta.file_type().is_symlink() => LinkState::Linked,
            Ok(_) => LinkState::Copied,
            Err(_) => LinkState::None,
        }
    }

    fn same_real(a: &Path, b: &Path) -> bool {
        match (fs::canonicalize(a), fs::canonicalize(b)) {
            (Ok(x), Ok(y)) => {
                x.to_string_lossy().to_lowercase() == y.to_string_lossy().to_lowercase()
            }
            _ => false,
        }
    }

    fn create_link(target: &Path, link: &Path) -> bool {
        #[cfg(target_os = "windows")]
        {
            // Junction 不需要管理员权限；std 的 symlink_dir 在 Windows 上需要特权
            CommandHelper::mklink_junction(target, link)
        }
        #[cfg(not(target_os = "windows"))]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    fn remove_link(path: &Path) -> bool {
        #[cfg(target_os = "windows")]
        {
            fs::remove_dir(path).is_ok() // Junction：只删重解析点
        }
        #[cfg(not(target_os = "windows"))]
        {
            fs::remove_file(path).is_ok() // POSIX：symlink 用 unlink
        }
    }

    /// 单技能启用：ok / skip / conflict / nomaster / fail
    pub fn enable_one(
        master_dir: &Path,
        dir_name: &str,
        agent_dir: &Path,
        overwrite: bool,
    ) -> String {
        let src = master_dir.join(dir_name);
        if !src.is_dir() {
            return "nomaster".into();
        }
        if fs::create_dir_all(agent_dir).is_err() {
            return "fail".into();
        }
        let link = agent_dir.join(dir_name);
        match Self::link_state(&link) {
            LinkState::Linked => {
                if Self::same_real(&link, &src) {
                    return "skip".into();
                }
                if !Self::remove_link(&link) {
                    return "fail".into();
                }
            }
            LinkState::Copied => {
                if !overwrite {
                    return "conflict".into();
                }
                if fs::remove_dir_all(&link).is_err() {
                    return "fail".into();
                }
            }
            LinkState::None => {}
        }
        if !Self::create_link(&src, &link) {
            return "fail".into();
        }
        if Self::link_state(&link) == LinkState::Linked && Self::same_real(&link, &src) {
            "ok".into()
        } else {
            "fail".into()
        }
    }

    /// 单技能禁用：ok / skip / protected / fail
    pub fn disable_one(dir_name: &str, agent_dir: &Path) -> String {
        let link = agent_dir.join(dir_name);
        match Self::link_state(&link) {
            LinkState::None => "skip".into(),
            LinkState::Copied => "protected".into(),
            LinkState::Linked => {
                if Self::remove_link(&link) && Self::link_state(&link) == LinkState::None {
                    "ok".into()
                } else {
                    "fail".into()
                }
            }
        }
    }

    fn list_dirs(dir: &Path) -> Vec<String> {
        let mut out = Vec::new();
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') {
                    continue;
                }
                let is_dir_like = entry
                    .file_type()
                    .map(|t| t.is_dir() || t.is_symlink())
                    .unwrap_or(false);
                if is_dir_like {
                    out.push(name);
                }
            }
        }
        out
    }

    fn parse_skill_meta(dir: &Path, fallback: &str) -> (String, Option<String>) {
        let Ok(content) = fs::read_to_string(dir.join(SKILL_MD)) else {
            return (fallback.to_string(), None);
        };
        let mut name = None;
        let mut description = None;
        for line in content.lines().take(30) {
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let value = value.trim().trim_matches('"').trim_matches('\'').trim();
            match key.trim() {
                "name" if !value.is_empty() => name = Some(value.to_string()),
                "description" if !value.is_empty() && description.is_none() => {
                    description = Some(value.to_string())
                }
                _ => {}
            }
        }
        (name.unwrap_or_else(|| fallback.to_string()), description)
    }

    /// 仓库分组：手动标注 > .skill-lock.json > （本项目）/（未分组）
    fn repo_label(
        config: &SkillLinkConfig,
        lock: &BTreeMap<String, LockEntry>,
        dir_name: &str,
        in_master: bool,
    ) -> Option<String> {
        if let Some(repo) = config.skill_repo_map.get(dir_name) {
            if !repo.is_empty() {
                return Some(repo.clone());
            }
        }
        if let Some(entry) = lock.get(dir_name) {
            if !entry.source.is_empty() {
                return Some(entry.source.clone());
            }
        }
        Some(if in_master {
            "（未分组）".into()
        } else {
            "（本项目）".into()
        })
    }

    /// 全量扫描快照
    pub fn snapshot(&self, ws_name: Option<&str>) -> AppResult<LinkSnapshot> {
        let config = self.lock_config();
        let lock = Self::lock_map(&config);
        let ws = Self::workspace(&config, ws_name).clone();
        let root = Self::workspace_root(&ws);
        let master = PathBuf::from(&config.master_dir);
        let master_dirs = Self::list_dirs(&master);

        // 工作空间内已有、但仓库没有的私有技能（探测 agent 目录 + .agents）
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut ws_only: Vec<(String, PathBuf)> = Vec::new();
        let mut probe_folders: Vec<String> =
            config.agents.iter().map(|a| a.folder.clone()).collect();
        probe_folders.push(".agents".into());
        probe_folders.dedup();
        for folder in probe_folders {
            let ad = Self::agent_dir(&root, &folder);
            for name in Self::list_dirs(&ad) {
                if !seen.contains(&name) && !master.join(&name).is_dir() {
                    seen.insert(name.clone());
                    let path = ad.join(&name);
                    ws_only.push((name, path));
                }
            }
        }

        let mut rows: Vec<ManagedSkill> = Vec::new();
        for dir_name in &master_dirs {
            seen.insert(dir_name.clone());
            rows.push(Self::build_row(
                &config,
                &lock,
                dir_name,
                &master.join(dir_name),
                true,
                &ws,
                &config.agents,
            ));
        }
        ws_only.sort();
        for (dir_name, path) in &ws_only {
            rows.push(Self::build_row(
                &config,
                &lock,
                dir_name,
                path,
                false,
                &ws,
                &config.agents,
            ));
        }
        rows.sort_by(|a, b| {
            a.repo
                .as_deref()
                .unwrap_or("")
                .cmp(b.repo.as_deref().unwrap_or(""))
                .then_with(|| a.skill.cmp(&b.skill))
        });

        Ok(LinkSnapshot {
            master_count: master_dirs.len(),
            master_dir: config.master_dir.clone(),
            agents: config.agents.clone(),
            workspaces: config.workspaces.clone(),
            active_workspace: config.active_workspace.clone(),
            workspace_name: ws.name.clone(),
            workspace_root: root.to_string_lossy().into_owned(),
            rows,
        })
    }

    fn build_row(
        config: &SkillLinkConfig,
        lock: &BTreeMap<String, LockEntry>,
        dir_name: &str,
        dir_path: &Path,
        in_master: bool,
        ws: &LinkWorkspace,
        agents: &[LinkAgent],
    ) -> ManagedSkill {
        let (skill, description) = Self::parse_skill_meta(dir_path, dir_name);
        let root = Self::workspace_root(ws);
        let statuses = agents
            .iter()
            .map(|a| SkillAgentState {
                agent: a.name.clone(),
                state: Self::link_state(&Self::agent_dir(&root, &a.folder).join(dir_name)),
            })
            .collect();
        ManagedSkill {
            dir: dir_name.to_string(),
            skill,
            description,
            repo: Self::repo_label(config, lock, dir_name, in_master),
            url: lock
                .get(dir_name)
                .map(|e| e.source_url.trim_end_matches(".git").to_string())
                .filter(|u| !u.is_empty()),
            in_master,
            statuses,
        }
    }

    /// 批量启用（agent = "*" 表示全部 Agent）
    pub fn enable(
        &self,
        skills: &[String],
        agent: &str,
        ws: Option<&str>,
        overwrite: bool,
    ) -> AppResult<EnableCounts> {
        let config = self.lock_config();
        let ws = Self::workspace(&config, ws).clone();
        let root = Self::workspace_root(&ws);
        let master = PathBuf::from(&config.master_dir);
        let targets: Vec<&LinkAgent> = if agent == "*" {
            config.agents.iter().collect()
        } else {
            config.agents.iter().filter(|a| a.name == agent).collect()
        };
        let mut counts = EnableCounts::default();
        for dir_name in skills {
            for a in &targets {
                let ad = Self::agent_dir(&root, &a.folder);
                match Self::enable_one(&master, dir_name, &ad, overwrite).as_str() {
                    "ok" => counts.ok += 1,
                    "skip" => counts.skip += 1,
                    "conflict" => counts.conflict += 1,
                    "nomaster" => counts.nomaster += 1,
                    _ => counts.fail += 1,
                }
            }
        }
        Ok(counts)
    }

    /// 批量禁用
    pub fn disable(
        &self,
        skills: &[String],
        agent: &str,
        ws: Option<&str>,
    ) -> AppResult<DisableCounts> {
        let config = self.lock_config();
        let ws = Self::workspace(&config, ws).clone();
        let root = Self::workspace_root(&ws);
        let targets: Vec<&LinkAgent> = if agent == "*" {
            config.agents.iter().collect()
        } else {
            config.agents.iter().filter(|a| a.name == agent).collect()
        };
        let mut counts = DisableCounts::default();
        for dir_name in skills {
            for a in &targets {
                let ad = Self::agent_dir(&root, &a.folder);
                match Self::disable_one(dir_name, &ad).as_str() {
                    "ok" => counts.ok += 1,
                    "skip" => counts.skip += 1,
                    "protected" => counts.protected_count += 1,
                    _ => counts.fail += 1,
                }
            }
        }
        Ok(counts)
    }

    pub fn set_active_workspace(&self, name: &str) -> AppResult<()> {
        let mut config = self.lock_config();
        if !config.workspaces.iter().any(|w| w.name == name) {
            return Err(AppError::from(format!("未知工作空间: {name}")));
        }
        config.active_workspace = name.to_string();
        self.persist(&config)?;
        Ok(())
    }

    pub fn add_workspace(&self, path: &str) -> AppResult<AddWorkspaceOutcome> {
        let mut config = self.lock_config();
        if config.workspaces.iter().any(|w| w.path == path) {
            return Ok(AddWorkspaceOutcome {
                name: path.to_string(),
                duplicate: true,
            });
        }
        let name = Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string());
        config.workspaces.push(LinkWorkspace {
            name: name.clone(),
            path: path.to_string(),
        });
        self.persist(&config)?;
        Ok(AddWorkspaceOutcome {
            name,
            duplicate: false,
        })
    }

    /// 手动标注仓库分组（repo 为空 = 清除）
    pub fn annotate_repo(&self, dir: &str, repo: &str) -> AppResult<()> {
        let mut config = self.lock_config();
        let repo = repo.trim();
        if repo.is_empty() || repo == "（未分组）" {
            config.skill_repo_map.remove(dir);
        } else {
            config
                .skill_repo_map
                .insert(dir.to_string(), repo.to_string());
        }
        self.persist(&config)?;
        Ok(())
    }
}

/// Windows Junction 创建（mklink /J 无需管理员权限；std::fs::symlink_dir 需要）
struct CommandHelper;

#[allow(dead_code)]
impl CommandHelper {
    #[cfg(target_os = "windows")]
    pub fn mklink_junction(target: &Path, link: &Path) -> bool {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    struct Fixture {
        _master_tmp: tempfile::TempDir,
        _ws_tmp: tempfile::TempDir,
        master: PathBuf,
        ws_root: PathBuf,
        service: SkillLinkService,
    }

    fn write_skill(master: &Path, dir: &str, name: &str, desc: &str) {
        let dir = master.join(dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(SKILL_MD),
            format!("---\nname: {name}\ndescription: {desc}\n---\nBody"),
        )
        .unwrap();
    }

    fn fixture() -> Fixture {
        let master_tmp = tempdir().unwrap();
        let ws_tmp = tempdir().unwrap();
        let master = master_tmp.path().join("master");
        let ws_root = ws_tmp.path().join("proj");
        fs::create_dir_all(&master).unwrap();
        fs::create_dir_all(&ws_root).unwrap();
        write_skill(&master, "tdd", "tdd", "Test-driven development");
        write_skill(&master, "grilling", "grilling", "Grill the user");
        let cfg_path = master_tmp.path().join("config.json");
        let mut config = SkillLinkConfig::default();
        config.master_dir = master.to_string_lossy().into_owned();
        config.workspaces.push(LinkWorkspace {
            name: "proj".into(),
            path: ws_root.to_string_lossy().into_owned(),
        });
        config.active_workspace = "proj".into();
        let service = SkillLinkService::with_config(cfg_path, config);
        Fixture {
            _master_tmp: master_tmp,
            _ws_tmp: ws_tmp,
            master,
            ws_root,
            service,
        }
    }

    #[test]
    fn enable_disable_full_roundtrip() {
        let fx = fixture();
        let ad = SkillLinkService::agent_dir(&fx.ws_root, ".claude");

        // 空白启用 → ok，Junction/Symlink 指向 master
        let counts = fx
            .service
            .enable(&["tdd".into()], "Claude", None, false)
            .unwrap();
        assert_eq!(counts.ok, 1);
        let link = ad.join("tdd");
        assert_eq!(SkillLinkService::link_state(&link), LinkState::Linked);
        assert!(SkillLinkService::same_real(&link, &fx.master.join("tdd")));

        // 重复启用 → skip（幂等）
        let counts = fx
            .service
            .enable(&["tdd".into()], "Claude", None, false)
            .unwrap();
        assert_eq!(counts.skip, 1);

        // 禁用 → ok，链接移除，master 原件完好
        let counts = fx.service.disable(&["tdd".into()], "Claude", None).unwrap();
        assert_eq!(counts.ok, 1);
        assert_eq!(SkillLinkService::link_state(&link), LinkState::None);
        assert!(fx.master.join("tdd").join(SKILL_MD).is_file());

        // 再禁用 → skip
        let counts = fx.service.disable(&["tdd".into()], "Claude", None).unwrap();
        assert_eq!(counts.skip, 1);
    }

    #[test]
    fn real_dir_is_protected_and_conflicts() {
        let fx = fixture();
        let ad = SkillLinkService::agent_dir(&fx.ws_root, ".claude");
        let link = ad.join("tdd");
        fs::create_dir_all(&link).unwrap();
        fs::write(link.join("marker.txt"), "real").unwrap();

        // 真实目录启用（不覆盖）→ conflict，内容保留
        let counts = fx
            .service
            .enable(&["tdd".into()], "Claude", None, false)
            .unwrap();
        assert_eq!(counts.conflict, 1);
        assert!(link.join("marker.txt").is_file());

        // 真实目录禁用 → protected，绝不自动删
        let counts = fx.service.disable(&["tdd".into()], "Claude", None).unwrap();
        assert_eq!(counts.protected_count, 1);
        assert!(link.join("marker.txt").is_file());

        // 显式覆盖启用 → 副本替换为链接
        let counts = fx
            .service
            .enable(&["tdd".into()], "Claude", None, true)
            .unwrap();
        assert_eq!(counts.ok, 1);
        assert_eq!(SkillLinkService::link_state(&link), LinkState::Linked);
        assert!(!link.join("marker.txt").exists());
    }

    #[test]
    fn nomaster_when_missing_in_master() {
        let fx = fixture();
        let counts = fx
            .service
            .enable(&["ghost".into()], "*", None, false)
            .unwrap();
        assert_eq!(counts.nomaster, 5); // 全部 5 个 Agent 都 nomaster
    }

    #[test]
    fn agent_all_targets_every_agent() {
        let fx = fixture();
        let counts = fx
            .service
            .enable(&["tdd".into()], "*", None, false)
            .unwrap();
        assert_eq!(counts.ok, 5);
        let counts = fx.service.disable(&["tdd".into()], "*", None).unwrap();
        assert_eq!(counts.ok, 5);
        let snap = fx.service.snapshot(None).unwrap();
        let tdd = snap.rows.iter().find(|r| r.dir == "tdd").unwrap();
        assert!(tdd.statuses.iter().all(|s| s.state == LinkState::None));
    }

    #[test]
    fn snapshot_lists_master_and_workspace_only_skills() {
        let fx = fixture();
        // 工作空间私有技能（不在 master）
        let private = fx.ws_root.join(".codex").join("skills").join("my-private");
        fs::create_dir_all(&private).unwrap();
        fs::write(
            private.join(SKILL_MD),
            "name: my-private\ndescription: Private",
        )
        .unwrap();

        let snap = fx.service.snapshot(None).unwrap();
        assert_eq!(snap.master_count, 2);
        assert_eq!(snap.rows.len(), 3); // 2 master + 1 私有
        let own = snap.rows.iter().find(|r| r.dir == "my-private").unwrap();
        assert!(!own.in_master);
        assert_eq!(own.repo.as_deref(), Some("（本项目）"));
        let tdd = snap.rows.iter().find(|r| r.dir == "tdd").unwrap();
        assert_eq!(tdd.skill, "tdd");
        assert_eq!(tdd.description.as_deref(), Some("Test-driven development"));
        assert_eq!(tdd.repo.as_deref(), Some("（未分组）"));
    }

    #[test]
    fn workspace_add_switch_and_snapshot() {
        let fx = fixture();
        let out = fx.service.add_workspace("/tmp/another-proj").unwrap();
        assert_eq!(out.name, "another-proj");
        assert!(!out.duplicate);
        let dup = fx.service.add_workspace("/tmp/another-proj").unwrap();
        assert!(dup.duplicate);
        fx.service.set_active_workspace("another-proj").unwrap();
        let snap = fx.service.snapshot(None).unwrap();
        assert_eq!(snap.active_workspace, "another-proj");
        // master 技能始终列出，但新空间内没有任何链接/副本
        assert_eq!(snap.master_count, 2);
        assert_eq!(snap.rows.len(), 2);
        assert!(snap
            .rows
            .iter()
            .all(|r| r.statuses.iter().all(|s| s.state == LinkState::None)));
        assert!(fx.service.set_active_workspace("不存在").is_err());
    }

    #[test]
    fn repo_map_annotation_overrides_label() {
        let fx = fixture();
        fx.service
            .annotate_repo("tdd", "mattpocock/skills")
            .unwrap();
        let snap = fx.service.snapshot(None).unwrap();
        let tdd = snap.rows.iter().find(|r| r.dir == "tdd").unwrap();
        assert_eq!(tdd.repo.as_deref(), Some("mattpocock/skills"));
        fx.service.annotate_repo("tdd", "").unwrap();
        let snap = fx.service.snapshot(None).unwrap();
        let tdd = snap.rows.iter().find(|r| r.dir == "tdd").unwrap();
        assert_eq!(tdd.repo.as_deref(), Some("（未分组）"));
    }

    #[test]
    fn config_persists_across_reload() {
        let fx = fixture();
        fx.service.set_active_workspace("proj").unwrap();
        let cfg_path = fx.master.parent().unwrap().join("config.json");
        let reloaded = SkillLinkService::new(cfg_path);
        let snap = reloaded.snapshot(None).unwrap();
        assert_eq!(snap.active_workspace, "proj");
    }
}
