use crate::models::{
    PortClaim, PortConflict, RunnerInstance, RunnerInstanceStatus, RunnerLaunchPlan,
    RunnerLaunchSuggestedAction, RunnerProfile, RunnerProfileDraft,
};
use crate::repository::RunnerRepository;
use crate::services::{ListeningSocket, PortScanner, ProcessMonitorService};
use parking_lot::Mutex;
use std::collections::HashSet;
use std::sync::Arc;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tracing::{debug, warn};
use uuid::Uuid;

/// Runner Registry 业务编排：profile CRUD + 启动预演 + 端口快照刷新 + 进程清理
pub struct RunnerService {
    repo: Arc<RunnerRepository>,
    process_monitor: Arc<ProcessMonitorService>,
    /// 用于查询进程树（独立于 ProcessMonitorService 的 System，避免共用锁竞争）
    sys: Mutex<System>,
}

impl RunnerService {
    pub fn new(repo: Arc<RunnerRepository>, process_monitor: Arc<ProcessMonitorService>) -> Self {
        Self {
            repo,
            process_monitor,
            sys: Mutex::new(System::new()),
        }
    }

    // ============ Profile CRUD ============

    pub fn list_profiles(&self, project_path: &str) -> Result<Vec<RunnerProfile>, String> {
        self.repo.list_profiles_by_project(project_path)
    }

    pub fn get_profile(&self, id: &str) -> Result<Option<RunnerProfile>, String> {
        self.repo.get_profile(id)
    }

    /// 创建（draft.id 为 None）或更新（draft.id 提供）一个 profile
    pub fn upsert_profile(&self, draft: RunnerProfileDraft) -> Result<RunnerProfile, String> {
        Self::validate_draft(&draft)?;
        let now = Self::now();
        let profile = if let Some(id) = draft.id.clone() {
            let existing = self
                .repo
                .get_profile(&id)?
                .ok_or_else(|| format!("RunnerProfile not found: {}", id))?;
            RunnerProfile {
                id,
                project_path: draft.project_path,
                workspace_name: draft.workspace_name,
                name: draft.name,
                command: draft.command,
                cwd: draft.cwd,
                runtime_kind: draft.runtime_kind,
                wsl_distro: draft.wsl_distro,
                ssh_machine_id: draft.ssh_machine_id,
                env: draft.env,
                expected_ports: draft.expected_ports,
                tool_hint: draft.tool_hint,
                last_started_at: existing.last_started_at,
                created_at: existing.created_at,
                updated_at: now,
            }
        } else {
            RunnerProfile {
                id: Uuid::new_v4().to_string(),
                project_path: draft.project_path,
                workspace_name: draft.workspace_name,
                name: draft.name,
                command: draft.command,
                cwd: draft.cwd,
                runtime_kind: draft.runtime_kind,
                wsl_distro: draft.wsl_distro,
                ssh_machine_id: draft.ssh_machine_id,
                env: draft.env,
                expected_ports: draft.expected_ports,
                tool_hint: draft.tool_hint,
                last_started_at: None,
                created_at: now.clone(),
                updated_at: now,
            }
        };
        self.repo.upsert_profile(&profile)?;
        Ok(profile)
    }

    pub fn delete_profile(&self, id: &str) -> Result<(), String> {
        self.repo.delete_profile(id)
    }

    // ============ Launch planning ============

    /// 启动前预演：对 profile.expected_ports 求当前占用情况，返回冲突 + 建议
    pub fn plan_launch(&self, profile_id: &str) -> Result<RunnerLaunchPlan, String> {
        let profile = self
            .repo
            .get_profile(profile_id)?
            .ok_or_else(|| format!("RunnerProfile not found: {}", profile_id))?;

        if profile.expected_ports.is_empty() {
            return Ok(RunnerLaunchPlan {
                profile_id: profile.id,
                profile_name: profile.name,
                conflicts: Vec::new(),
                suggested_actions: vec![RunnerLaunchSuggestedAction::StartDirect],
            });
        }

        let conflicts = self.find_conflicts(&profile.expected_ports, Some(&profile.id))?;
        let suggested_actions = Self::suggest_actions(&conflicts);

        Ok(RunnerLaunchPlan {
            profile_id: profile.id,
            profile_name: profile.name,
            conflicts,
            suggested_actions,
        })
    }

    /// 查询给定端口集当前的占用情况，并交叉登记表标注每个 PID 是否属于已知 instance
    pub fn find_conflicts(
        &self,
        ports: &[u16],
        candidate_self_profile_id: Option<&str>,
    ) -> Result<Vec<PortConflict>, String> {
        let raw = PortScanner::find_by_ports(ports)?;
        let mut result = Vec::with_capacity(raw.len());
        for entry in raw {
            let owning = self
                .repo
                .find_active_instance_by_pid(entry.pid)
                .unwrap_or(None);
            let (owning_instance_id, owning_profile_id, owning_profile_name) =
                if let Some(inst) = owning {
                    let profile_name = inst
                        .profile_id
                        .as_deref()
                        .and_then(|pid| self.repo.get_profile(pid).ok().flatten())
                        .map(|p| p.name);
                    (Some(inst.id), inst.profile_id, profile_name)
                } else {
                    (None, None, None)
                };
            let _ = candidate_self_profile_id; // 标识保留供未来扩展（如忽略自身预占）
            result.push(PortConflict {
                port: entry.port,
                protocol: entry.protocol,
                pid: entry.pid,
                listen_addr: Some(entry.listen_addr),
                owning_instance_id,
                owning_profile_id,
                owning_profile_name,
            });
        }
        Ok(result)
    }

    fn suggest_actions(conflicts: &[PortConflict]) -> Vec<RunnerLaunchSuggestedAction> {
        if conflicts.is_empty() {
            return vec![RunnerLaunchSuggestedAction::StartDirect];
        }
        let any_unknown = conflicts.iter().any(|c| c.owning_instance_id.is_none());
        if any_unknown {
            return vec![RunnerLaunchSuggestedAction::InvestigateUnknown];
        }
        let all_share_profile = conflicts.iter().all(|c| c.owning_profile_id.is_some())
            && conflicts
                .windows(2)
                .all(|w| w[0].owning_profile_id == w[1].owning_profile_id);
        if all_share_profile {
            vec![RunnerLaunchSuggestedAction::KillSelfThenStart]
        } else {
            vec![RunnerLaunchSuggestedAction::AskUserBeforeKill]
        }
    }

    // ============ Instance lifecycle ============

    /// 显式登记一个 instance（用户从 RunnerProfile 启动）
    #[allow(clippy::too_many_arguments)]
    pub fn register_instance(
        &self,
        profile_id: Option<&str>,
        project_path: &str,
        workspace_name: Option<&str>,
        session_id: Option<&str>,
        root_pid: u32,
        runtime_kind: &str,
        command: &str,
        cwd: &str,
    ) -> Result<RunnerInstance, String> {
        let now = Self::now();
        let instance = RunnerInstance {
            id: Uuid::new_v4().to_string(),
            profile_id: profile_id.map(|s| s.to_string()),
            project_path: project_path.to_string(),
            workspace_name: workspace_name.map(|s| s.to_string()),
            session_id: session_id.map(|s| s.to_string()),
            root_pid,
            runtime_kind: runtime_kind.to_string(),
            command: command.to_string(),
            cwd: cwd.to_string(),
            started_at: now.clone(),
            exited_at: None,
            exit_code: None,
            status: RunnerInstanceStatus::Running,
            metadata: None,
        };
        self.repo.record_instance_start(&instance)?;
        if let Some(pid) = profile_id {
            self.repo.touch_profile_last_started(pid, &now)?;
        }
        Ok(instance)
    }

    pub fn mark_instance_exited(
        &self,
        instance_id: &str,
        exit_code: Option<i32>,
        status: RunnerInstanceStatus,
    ) -> Result<(), String> {
        let now = Self::now();
        self.repo
            .mark_instance_exited(instance_id, &now, exit_code, status)
    }

    /// Hook 入口：根据 PTY session_id 找到对应活跃 instance 并标记退出。
    /// 找不到时静默成功（隐式扫描可能还未登记，或这不是一个 runner session）。
    pub fn mark_exited_by_session(
        &self,
        session_id: &str,
        exit_code: Option<i32>,
    ) -> Result<bool, String> {
        let actives = self.repo.list_active_instances(None)?;
        let Some(inst) = actives
            .into_iter()
            .find(|i| i.session_id.as_deref() == Some(session_id))
        else {
            return Ok(false);
        };
        self.mark_instance_exited(&inst.id, exit_code, RunnerInstanceStatus::Exited)?;
        Ok(true)
    }

    /// 杀掉 instance 的根进程树（委托 ProcessMonitorService）
    pub fn kill_instance(&self, instance_id: &str) -> Result<bool, String> {
        let inst = self
            .repo
            .get_instance(instance_id)?
            .ok_or_else(|| format!("RunnerInstance not found: {}", instance_id))?;
        let killed = self
            .process_monitor
            .kill_process(inst.root_pid)
            .map_err(|e| e.to_string())?;
        if killed {
            self.mark_instance_exited(instance_id, None, RunnerInstanceStatus::Exited)?;
        }
        Ok(killed)
    }

    pub fn list_active_instances(
        &self,
        project_path: Option<&str>,
    ) -> Result<Vec<RunnerInstance>, String> {
        self.repo.list_active_instances(project_path)
    }

    pub fn list_active_by_profile(&self, profile_id: &str) -> Result<Vec<RunnerInstance>, String> {
        self.repo.list_active_by_profile(profile_id)
    }

    pub fn list_profiles_by_workspace(
        &self,
        workspace_name: &str,
    ) -> Result<Vec<RunnerProfile>, String> {
        self.repo.list_profiles_by_workspace(workspace_name)
    }

    // ============ Port-claim refresh ============

    /// 用 sysinfo 查 instance.root_pid 的子进程树 ∩ netstat2 的监听 socket
    /// → 一组 PortClaim，覆写到 port_claims 表
    pub fn refresh_port_claims(&self, instance_id: &str) -> Result<Vec<PortClaim>, String> {
        let inst = self
            .repo
            .get_instance(instance_id)?
            .ok_or_else(|| format!("RunnerInstance not found: {}", instance_id))?;
        if inst.status != RunnerInstanceStatus::Running {
            return Ok(Vec::new());
        }

        let pids = self.descendant_pids_including_root(inst.root_pid);
        let sockets = PortScanner::list_listening_for_pids(&pids)?;
        let now = Self::now();
        let claims: Vec<PortClaim> = sockets
            .into_iter()
            .map(|s: ListeningSocket| PortClaim {
                id: 0,
                instance_id: Some(inst.id.clone()),
                pid: s.pid,
                port: s.port,
                protocol: s.protocol,
                listen_addr: Some(s.listen_addr),
                detected_at: now.clone(),
            })
            .collect();

        self.repo
            .replace_port_claims_for_instance(&inst.id, &claims)?;
        debug!(instance_id, count = claims.len(), "port claims refreshed");
        Ok(claims)
    }

    /// 隐式扫描入口：用户在已存在的 PTY 里手敲 npm run dev，hook 上报 session + root_pid
    /// 服务端登记为一个匿名 instance（profile_id = None），并立即扫一次端口
    #[allow(clippy::too_many_arguments)]
    pub fn register_implicit_instance(
        &self,
        project_path: &str,
        workspace_name: Option<&str>,
        session_id: Option<&str>,
        root_pid: u32,
        runtime_kind: &str,
        command: &str,
        cwd: &str,
    ) -> Result<RunnerInstance, String> {
        // 复用 register_instance；不绑定 profile，不 touch last_started_at
        let inst = self.register_instance(
            None,
            project_path,
            workspace_name,
            session_id,
            root_pid,
            runtime_kind,
            command,
            cwd,
        )?;
        if let Err(e) = self.refresh_port_claims(&inst.id) {
            warn!(err = %e, instance_id = inst.id, "initial port claim refresh failed");
        }
        Ok(inst)
    }

    // ============ helpers ============

    fn validate_draft(draft: &RunnerProfileDraft) -> Result<(), String> {
        if draft.name.trim().is_empty() {
            return Err("RunnerProfile.name must not be empty".to_string());
        }
        if draft.command.trim().is_empty() {
            return Err("RunnerProfile.command must not be empty".to_string());
        }
        if draft.cwd.trim().is_empty() {
            return Err("RunnerProfile.cwd must not be empty".to_string());
        }
        if !["local", "wsl", "ssh"].contains(&draft.runtime_kind.as_str()) {
            return Err(format!(
                "RunnerProfile.runtime_kind must be local/wsl/ssh, got: {}",
                draft.runtime_kind
            ));
        }
        Ok(())
    }

    fn now() -> String {
        chrono::Utc::now().to_rfc3339()
    }

    /// BFS 找 root 及其所有子孙的 PID 集合
    fn descendant_pids_including_root(&self, root: u32) -> HashSet<u32> {
        let mut sys = self.sys.lock();
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            false,
            ProcessRefreshKind::nothing(),
        );

        let mut result = HashSet::new();
        result.insert(root);

        // 构建 parent -> children 反向索引，避免 O(N) 重复遍历
        use std::collections::HashMap;
        let mut children_map: HashMap<u32, Vec<u32>> = HashMap::new();
        for (pid, proc) in sys.processes() {
            if let Some(parent) = proc.parent() {
                children_map
                    .entry(parent.as_u32())
                    .or_default()
                    .push(pid.as_u32());
            }
        }

        let mut frontier = vec![root];
        while let Some(p) = frontier.pop() {
            if let Some(children) = children_map.get(&p) {
                for child in children {
                    if result.insert(*child) {
                        frontier.push(*child);
                    }
                }
            }
        }
        // Safety: 始终包含 root，即便 root 已退出
        let _ = Pid::from_u32(root);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::Database;
    use std::net::TcpListener;

    fn make_service() -> RunnerService {
        let db = Arc::new(Database::new_in_memory().expect("db"));
        let repo = Arc::new(RunnerRepository::new(db));
        let monitor = Arc::new(ProcessMonitorService::new());
        RunnerService::new(repo, monitor)
    }

    fn draft(name: &str, project: &str) -> RunnerProfileDraft {
        RunnerProfileDraft {
            id: None,
            project_path: project.to_string(),
            workspace_name: Some("ws".to_string()),
            name: name.to_string(),
            command: "npm run dev".to_string(),
            cwd: project.to_string(),
            runtime_kind: "local".to_string(),
            wsl_distro: None,
            ssh_machine_id: None,
            env: Default::default(),
            expected_ports: vec![],
            tool_hint: Some("npm".to_string()),
        }
    }

    #[test]
    fn upsert_creates_then_updates_profile() {
        let svc = make_service();
        let created = svc.upsert_profile(draft("dev", "/proj")).expect("create");
        assert!(!created.id.is_empty());

        let mut update = draft("dev", "/proj");
        update.id = Some(created.id.clone());
        update.command = "npm start".to_string();
        let updated = svc.upsert_profile(update).expect("update");
        assert_eq!(updated.id, created.id);
        assert_eq!(updated.command, "npm start");
        assert_eq!(updated.created_at, created.created_at);
    }

    #[test]
    fn validate_rejects_empty_command() {
        let svc = make_service();
        let mut d = draft("dev", "/proj");
        d.command = "  ".to_string();
        assert!(svc.upsert_profile(d).is_err());
    }

    #[test]
    fn validate_rejects_bad_runtime() {
        let svc = make_service();
        let mut d = draft("dev", "/proj");
        d.runtime_kind = "kubernetes".to_string();
        assert!(svc.upsert_profile(d).is_err());
    }

    #[test]
    fn plan_launch_no_expected_ports_returns_start_direct() {
        let svc = make_service();
        let p = svc.upsert_profile(draft("dev", "/proj")).expect("create");
        let plan = svc.plan_launch(&p.id).expect("plan");
        assert!(plan.conflicts.is_empty());
        assert_eq!(
            plan.suggested_actions,
            vec![RunnerLaunchSuggestedAction::StartDirect]
        );
    }

    #[test]
    fn plan_launch_detects_real_port_conflict() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();

        let svc = make_service();
        let mut d = draft("dev", "/proj");
        d.expected_ports = vec![port];
        let p = svc.upsert_profile(d).expect("create");

        let plan = svc.plan_launch(&p.id).expect("plan");
        assert!(
            plan.conflicts.iter().any(|c| c.port == port),
            "expected port {} to appear in conflicts (got {:?})",
            port,
            plan.conflicts
        );
        // The owner is the test process; it isn't registered in runner_instances
        // → suggestion should be InvestigateUnknown
        assert_eq!(
            plan.suggested_actions,
            vec![RunnerLaunchSuggestedAction::InvestigateUnknown]
        );
        drop(listener);
    }

    #[test]
    fn register_instance_lifecycle() {
        let svc = make_service();
        let p = svc.upsert_profile(draft("dev", "/proj")).expect("create");

        let inst = svc
            .register_instance(
                Some(&p.id),
                "/proj",
                Some("ws"),
                Some("s1"),
                99999,
                "local",
                "npm run dev",
                "/proj",
            )
            .expect("register");
        assert_eq!(inst.status, RunnerInstanceStatus::Running);

        // profile.last_started_at should now be set
        let updated_profile = svc.get_profile(&p.id).expect("get").expect("some");
        assert!(updated_profile.last_started_at.is_some());

        svc.mark_instance_exited(&inst.id, Some(0), RunnerInstanceStatus::Exited)
            .expect("mark exited");
        let active = svc.list_active_instances(Some("/proj")).expect("list");
        assert!(active.iter().all(|i| i.id != inst.id));
    }

    #[test]
    fn suggest_actions_kill_self_when_conflicts_share_profile() {
        let conflicts = vec![
            PortConflict {
                port: 5173,
                protocol: "tcp".to_string(),
                pid: 1,
                listen_addr: Some("0.0.0.0".to_string()),
                owning_instance_id: Some("i1".to_string()),
                owning_profile_id: Some("p1".to_string()),
                owning_profile_name: Some("dev".to_string()),
            },
            PortConflict {
                port: 5174,
                protocol: "tcp".to_string(),
                pid: 1,
                listen_addr: Some("0.0.0.0".to_string()),
                owning_instance_id: Some("i1".to_string()),
                owning_profile_id: Some("p1".to_string()),
                owning_profile_name: Some("dev".to_string()),
            },
        ];
        assert_eq!(
            RunnerService::suggest_actions(&conflicts),
            vec![RunnerLaunchSuggestedAction::KillSelfThenStart]
        );
    }

    #[test]
    fn suggest_actions_ask_when_different_profiles() {
        let conflicts = vec![
            PortConflict {
                port: 5173,
                protocol: "tcp".to_string(),
                pid: 1,
                listen_addr: None,
                owning_instance_id: Some("i1".to_string()),
                owning_profile_id: Some("p1".to_string()),
                owning_profile_name: Some("dev".to_string()),
            },
            PortConflict {
                port: 5174,
                protocol: "tcp".to_string(),
                pid: 2,
                listen_addr: None,
                owning_instance_id: Some("i2".to_string()),
                owning_profile_id: Some("p2".to_string()),
                owning_profile_name: Some("api".to_string()),
            },
        ];
        assert_eq!(
            RunnerService::suggest_actions(&conflicts),
            vec![RunnerLaunchSuggestedAction::AskUserBeforeKill]
        );
    }

    #[test]
    fn mark_exited_by_session_finds_and_marks() {
        let svc = make_service();
        let _inst1 = svc
            .register_instance(
                None,
                "/proj",
                None,
                Some("session-A"),
                111,
                "local",
                "cmd",
                "/proj",
            )
            .expect("register A");
        let _inst2 = svc
            .register_instance(
                None,
                "/proj",
                None,
                Some("session-B"),
                222,
                "local",
                "cmd",
                "/proj",
            )
            .expect("register B");

        let found = svc
            .mark_exited_by_session("session-A", Some(0))
            .expect("mark A");
        assert!(found, "should find and mark session-A");

        let active = svc.list_active_instances(None).expect("list");
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].session_id.as_deref(), Some("session-B"));

        // unknown session_id should silently return false
        let missing = svc
            .mark_exited_by_session("nonexistent", None)
            .expect("mark missing");
        assert!(!missing, "should return false for unknown session");
    }

    #[test]
    fn list_active_by_profile_returns_only_running() {
        let svc = make_service();
        let profile_a = svc
            .upsert_profile(draft("dev-a", "/proj-a"))
            .expect("profile a");
        let profile_b = svc
            .upsert_profile(draft("dev-b", "/proj-b"))
            .expect("profile b");

        let running = svc
            .register_instance(
                Some(&profile_a.id),
                "/proj-a",
                Some("ws"),
                Some("session-running"),
                111,
                "local",
                "cmd",
                "/proj-a",
            )
            .expect("running");
        let exited = svc
            .register_instance(
                Some(&profile_a.id),
                "/proj-a",
                Some("ws"),
                Some("session-exited"),
                222,
                "local",
                "cmd",
                "/proj-a",
            )
            .expect("exited");
        let _other_profile = svc
            .register_instance(
                Some(&profile_b.id),
                "/proj-b",
                Some("ws"),
                Some("session-other"),
                333,
                "local",
                "cmd",
                "/proj-b",
            )
            .expect("other");

        svc.mark_instance_exited(&exited.id, Some(0), RunnerInstanceStatus::Exited)
            .expect("mark exited");

        let active = svc
            .list_active_by_profile(&profile_a.id)
            .expect("active profile a");
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, running.id);
    }

    #[test]
    fn list_profiles_by_workspace_returns_profiles_for_reservations() {
        let svc = make_service();
        let mut profile_a = draft("dev-a", "/proj-a");
        profile_a.workspace_name = Some("workspace-a".to_string());
        profile_a.expected_ports = vec![1420, 5173];
        let mut profile_b = draft("dev-b", "/proj-b");
        profile_b.workspace_name = Some("workspace-a".to_string());
        profile_b.expected_ports = vec![48080];
        let mut profile_c = draft("dev-c", "/proj-c");
        profile_c.workspace_name = Some("workspace-b".to_string());

        let created_b = svc.upsert_profile(profile_b).expect("profile b");
        let created_c = svc.upsert_profile(profile_c).expect("profile c");
        let created_a = svc.upsert_profile(profile_a).expect("profile a");

        let profiles = svc
            .list_profiles_by_workspace("workspace-a")
            .expect("workspace profiles");
        let ids = profiles
            .iter()
            .map(|profile| profile.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec![created_a.id.as_str(), created_b.id.as_str()]);
        assert!(!ids.contains(&created_c.id.as_str()));
        assert_eq!(profiles[0].expected_ports, vec![1420, 5173]);
        assert_eq!(profiles[1].expected_ports, vec![48080]);
    }

    #[test]
    fn refresh_port_claims_for_self_pid() {
        // 用一个 TcpListener 模拟"已知 instance 在监听端口"
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let self_pid = std::process::id();

        let svc = make_service();
        let inst = svc
            .register_instance(
                None,
                "/proj",
                None,
                Some("s1"),
                self_pid,
                "local",
                "test",
                "/proj",
            )
            .expect("register");

        let claims = svc.refresh_port_claims(&inst.id).expect("refresh");
        assert!(
            claims.iter().any(|c| c.port == port),
            "expected own listener port {} in claims",
            port
        );
        drop(listener);
    }
}
