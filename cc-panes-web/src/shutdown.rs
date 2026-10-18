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
