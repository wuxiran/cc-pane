use crate::constants::history::WATCH_GRACE_SECS;
use crate::services::HistoryService;
use crate::utils::{normalize_project_path, paths_equivalent};
use anyhow::Result;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryWatchStats {
    pub watching_projects: usize,
    pub session_count: usize,
}

#[derive(Default)]
struct ProjectWatchState {
    active: usize,
    generation: u64,
}

#[derive(Default)]
struct WatchState {
    sessions: HashMap<String, PathBuf>,
    projects: HashMap<PathBuf, ProjectWatchState>,
}

fn equivalent_path_key<T>(map: &HashMap<PathBuf, T>, path: &Path) -> Option<PathBuf> {
    map.keys().find(|key| paths_equivalent(key, path)).cloned()
}

pub struct HistoryWatchManager {
    history_service: Arc<HistoryService>,
    state: Arc<Mutex<WatchState>>,
    enabled: AtomicBool,
    grace: Duration,
}

impl HistoryWatchManager {
    pub fn new(history_service: Arc<HistoryService>) -> Self {
        Self::with_grace(history_service, Duration::from_secs(WATCH_GRACE_SECS))
    }

    pub fn with_grace(history_service: Arc<HistoryService>, grace: Duration) -> Self {
        Self {
            history_service,
            state: Arc::new(Mutex::new(WatchState::default())),
            enabled: AtomicBool::new(true),
            grace,
        }
    }

    pub fn on_session_created(
        &self,
        session_id: impl Into<String>,
        project_path: impl AsRef<Path>,
    ) -> Result<()> {
        if !self.enabled.load(Ordering::SeqCst) || should_skip_path(project_path.as_ref()) {
            return Ok(());
        }

        let project_path = normalize_project_path(project_path);
        if !project_path.is_dir() {
            return Ok(());
        }

        let session_id = session_id.into();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if !self.enabled.load(Ordering::SeqCst) || state.sessions.contains_key(&session_id) {
            return Ok(());
        }

        let project_path =
            equivalent_path_key(&state.projects, &project_path).unwrap_or(project_path);
        let project = state.projects.entry(project_path.clone()).or_default();
        if project.active == 0 {
            self.history_service.start_watching(&project_path)?;
            project.generation = project.generation.wrapping_add(1);
        }
        project.active += 1;
        state.sessions.insert(session_id, project_path);
        Ok(())
    }

    pub fn on_session_ended(&self, session_id: &str) {
        let generation = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let Some(project_path) = state.sessions.remove(session_id) else {
                return;
            };
            let Some(project) = state.projects.get_mut(&project_path) else {
                return;
            };
            project.active = project.active.saturating_sub(1);
            if project.active != 0 {
                return;
            }
            (project_path, project.generation)
        };

        let state = self.state.clone();
        let history_service = self.history_service.clone();
        let grace = self.grace;
        std::thread::spawn(move || {
            std::thread::sleep(grace);
            let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
            let should_stop = state
                .projects
                .get(&generation.0)
                .is_some_and(|project| project.active == 0 && project.generation == generation.1);
            if should_stop {
                let _ = history_service.stop_watching(&generation.0);
                if let Some(project) = state.projects.get_mut(&generation.0) {
                    project.generation = project.generation.wrapping_add(1);
                }
            }
        });
    }

    pub fn force_stop_project(&self, project_path: impl AsRef<Path>) {
        let project_path = normalize_project_path(project_path);
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let project_path =
            equivalent_path_key(&state.projects, &project_path).unwrap_or(project_path);
        state
            .sessions
            .retain(|_, path| !paths_equivalent(path, &project_path));
        let project = state.projects.entry(project_path.clone()).or_default();
        project.active = 0;
        project.generation = project.generation.wrapping_add(1);
        let _ = self.history_service.stop_watching(&project_path);
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::SeqCst);
        if enabled {
            return;
        }

        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.sessions.clear();
        for project in state.projects.values_mut() {
            project.active = 0;
            project.generation = project.generation.wrapping_add(1);
        }
        self.history_service.stop_all_watching();
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub fn stats(&self) -> HistoryWatchStats {
        HistoryWatchStats {
            watching_projects: self.history_service.watcher_count(),
            session_count: self
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .sessions
                .len(),
        }
    }
}

fn should_skip_path(path: &Path) -> bool {
    let value = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    value.starts_with("ssh://")
        || value.starts_with("//wsl$/")
        || value.starts_with("//wsl.localhost/")
}

#[cfg(test)]
mod tests {
    use super::{equivalent_path_key, HistoryWatchManager};
    use crate::services::HistoryService;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::Duration;
    use tempfile::tempdir;

    const TEST_GRACE: Duration = Duration::from_millis(50);

    fn manager() -> (Arc<HistoryService>, Arc<HistoryWatchManager>) {
        let history = Arc::new(HistoryService::new());
        let manager = Arc::new(HistoryWatchManager::with_grace(history.clone(), TEST_GRACE));
        (history, manager)
    }

    #[test]
    fn project_state_keys_follow_windows_drive_equivalence() {
        let projects = HashMap::from([(PathBuf::from(r"D:\Code\Project"), ())]);

        assert_eq!(
            equivalent_path_key(&projects, Path::new("d:/code/project/")),
            Some(PathBuf::from(r"D:\Code\Project"))
        );
        assert_eq!(
            equivalent_path_key(&projects, Path::new(r"\\server\share\project")),
            None
        );
    }

    #[test]
    fn multiple_sessions_share_one_watcher_until_grace_expires() {
        let dir = tempdir().unwrap();
        let (history, manager) = manager();

        manager.on_session_created("s1", dir.path()).unwrap();
        manager.on_session_created("s2", dir.path()).unwrap();
        assert_eq!(manager.stats().session_count, 2);
        assert_eq!(history.watcher_count(), 1);

        manager.on_session_ended("s1");
        assert_eq!(history.watcher_count(), 1);
        manager.on_session_ended("s2");
        std::thread::sleep(TEST_GRACE + Duration::from_millis(40));

        assert_eq!(manager.stats().session_count, 0);
        assert_eq!(history.watcher_count(), 0);
    }

    #[test]
    fn reopening_during_grace_keeps_the_watcher() {
        let dir = tempdir().unwrap();
        let (history, manager) = manager();

        manager.on_session_created("s1", dir.path()).unwrap();
        manager.on_session_ended("s1");
        std::thread::sleep(Duration::from_millis(10));
        manager.on_session_created("s2", dir.path()).unwrap();
        std::thread::sleep(TEST_GRACE + Duration::from_millis(40));

        assert_eq!(manager.stats().session_count, 1);
        assert_eq!(history.watcher_count(), 1);
    }

    #[test]
    fn unknown_or_duplicate_session_ids_are_idempotent() {
        let dir = tempdir().unwrap();
        let (history, manager) = manager();

        manager.on_session_ended("missing");
        manager.on_session_created("same", dir.path()).unwrap();
        manager.on_session_created("same", dir.path()).unwrap();

        assert_eq!(manager.stats().session_count, 1);
        assert_eq!(history.watcher_count(), 1);
    }

    #[test]
    fn unsupported_or_missing_paths_are_skipped() {
        let dir = tempdir().unwrap();
        let (_history, manager) = manager();

        manager
            .on_session_created("ssh", "ssh://example.com/repo")
            .unwrap();
        manager
            .on_session_created("wsl", r"\\wsl.localhost\Ubuntu\home\user\repo")
            .unwrap();
        manager
            .on_session_created("missing", dir.path().join("missing"))
            .unwrap();

        assert_eq!(manager.stats().session_count, 0);
        assert_eq!(manager.stats().watching_projects, 0);
    }

    #[test]
    fn disabling_stops_all_and_rejects_new_sessions_until_reenabled() {
        let dir = tempdir().unwrap();
        let (history, manager) = manager();
        manager.on_session_created("s1", dir.path()).unwrap();

        manager.set_enabled(false);
        assert_eq!(manager.stats().session_count, 0);
        assert_eq!(history.watcher_count(), 0);
        manager.on_session_created("s2", dir.path()).unwrap();
        assert_eq!(manager.stats().session_count, 0);

        manager.set_enabled(true);
        manager.on_session_created("s3", dir.path()).unwrap();
        assert_eq!(manager.stats().session_count, 1);
        assert_eq!(history.watcher_count(), 1);
    }

    #[test]
    fn force_stop_removes_project_sessions_immediately() {
        let dir = tempdir().unwrap();
        let (history, manager) = manager();
        manager.on_session_created("s1", dir.path()).unwrap();
        manager.on_session_created("s2", dir.path()).unwrap();

        manager.force_stop_project(dir.path());

        assert_eq!(manager.stats().session_count, 0);
        assert_eq!(history.watcher_count(), 0);
        manager.on_session_ended("s1");
        assert_eq!(manager.stats().session_count, 0);
    }

    #[test]
    fn alternate_path_spellings_share_one_project() {
        let dir = tempdir().unwrap();
        let (history, manager) = manager();
        let with_trailing_separator = format!("{}/", dir.path().display());

        manager.on_session_created("s1", dir.path()).unwrap();
        manager
            .on_session_created("s2", with_trailing_separator)
            .unwrap();

        assert_eq!(manager.stats().session_count, 2);
        assert_eq!(history.watcher_count(), 1);
    }
}
