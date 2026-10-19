use cc_panes_core::services::TerminalBackend;

/// Shared daemon sessions survive the Web adapter. The shared adapter releases
/// only its own claims; only an in-process pool belongs to this server's lifetime.
pub fn cleanup(backend: &dyn TerminalBackend, owns_sessions: bool) {
    if !owns_sessions {
        if let Err(error) = backend.release_owned_sessions() {
            tracing::warn!(%error, "failed to release Web claims");
        }
        return;
    }
    match backend.get_all_status() {
        Ok(sessions) => {
            for session in sessions {
                if let Err(error) = backend.kill(&session.session_id) {
                    tracing::warn!(session_id = %session.session_id, %error, "terminal shutdown failed");
                }
            }
        }
        Err(error) => tracing::warn!(%error, "terminal shutdown enumeration failed"),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use cc_panes_core::{
        models::{CreateSessionRequest, TerminalReplaySnapshot},
        services::{terminal_service::SessionOutput, SessionStatusInfo},
        utils::{AppError, AppResult},
    };

    use super::*;

    #[derive(Default)]
    struct RecordingBackend {
        calls: Mutex<Vec<String>>,
        release_fails: bool,
        first_kill_fails: bool,
    }

    impl TerminalBackend for RecordingBackend {
        fn release_owned_sessions(&self) -> AppResult<()> {
            self.calls.lock().unwrap().push("release-owned".into());
            if self.release_fails {
                Err(AppError::from("daemon unavailable"))
            } else {
                Ok(())
            }
        }

        fn get_all_status(&self) -> AppResult<Vec<SessionStatusInfo>> {
            self.calls.lock().unwrap().push("list".into());
            Ok(["first", "second"]
                .into_iter()
                .map(|id| {
                    serde_json::from_value(serde_json::json!({
                        "sessionId": id, "status": "idle", "lastOutputAt": 0,
                        "pid": null, "updatedAt": 0,
                    }))
                    .unwrap()
                })
                .collect())
        }

        fn kill(&self, session_id: &str) -> AppResult<()> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("kill:{session_id}"));
            if self.first_kill_fails && session_id == "first" {
                Err(AppError::from("first process already unavailable"))
            } else {
                Ok(())
            }
        }

        fn create_session(&self, _: CreateSessionRequest) -> AppResult<String> {
            panic!("shutdown must not create a session")
        }

        fn write(&self, _: &str, _: &str) -> AppResult<()> {
            panic!("shutdown must not write to a session")
        }

        fn submit_text_to_session(&self, _: &str, _: &str) -> AppResult<()> {
            panic!("shutdown must not submit to a session")
        }

        fn resize(&self, _: &str, _: u16, _: u16) -> AppResult<()> {
            panic!("shutdown must not resize a session")
        }

        fn get_session_status(&self, _: &str) -> AppResult<Option<SessionStatusInfo>> {
            panic!("unexpected per-session status query")
        }

        fn get_session_output(&self, _: &str, _: usize) -> AppResult<SessionOutput> {
            panic!("shutdown must not read terminal output")
        }

        fn get_session_replay_snapshot(
            &self,
            _: &str,
        ) -> AppResult<Option<TerminalReplaySnapshot>> {
            panic!("shutdown must not read terminal output")
        }
    }

    #[test]
    fn shared_daemon_shutdown_only_releases_owned_claims() {
        let backend = RecordingBackend::default();
        cleanup(&backend, false);
        assert_eq!(*backend.calls.lock().unwrap(), ["release-owned"]);
    }

    #[test]
    fn shared_daemon_release_failure_never_falls_back_to_killing_sessions() {
        let backend = RecordingBackend {
            release_fails: true,
            ..Default::default()
        };
        cleanup(&backend, false);
        assert_eq!(*backend.calls.lock().unwrap(), ["release-owned"]);
    }

    #[test]
    fn in_process_shutdown_cleans_all_sessions_even_after_one_kill_fails() {
        let backend = RecordingBackend {
            first_kill_fails: true,
            ..Default::default()
        };
        cleanup(&backend, true);
        assert_eq!(
            *backend.calls.lock().unwrap(),
            ["list", "kill:first", "kill:second"]
        );
    }
}
