//! Long-lived streams must not outlive their authentication or network policy.
use crate::{
    state::AppState,
    web_auth::{self, RequestOrigin},
};
use axum::http::HeaderMap;
use cc_panes_core::models::settings::WebAccessSettings;
use std::net::IpAddr;

pub struct Access {
    token: Option<String>,
    peer: Option<IpAddr>,
    origin: RequestOrigin,
    credentials: WebAccessSettings,
}

impl Access {
    pub fn new(
        state: &AppState,
        headers: &HeaderMap,
        peer: Option<IpAddr>,
        origin: RequestOrigin,
    ) -> Self {
        Self {
            token: web_auth::session_from_headers(headers),
            peer,
            origin,
            credentials: state.settings_service.get_settings().web_access,
        }
    }

    /// Does not refresh idle time: output/heartbeats must not keep a session unlocked.
    pub fn permissions(&self, state: &AppState) -> Option<bool> {
        let settings = state.settings_service.get_settings().web_access;
        if self
            .peer
            .is_some_and(|ip| !web_auth::remote_allowed(ip, &settings))
        {
            return None;
        }
        if settings.auth_required() != self.credentials.auth_required()
            || settings.username != self.credentials.username
            || settings.password_hash != self.credentials.password_hash
            || settings.password_salt != self.credentials.password_salt
        {
            return None;
        }
        if settings.auth_required()
            && !self.token.as_ref().is_some_and(|token| {
                state
                    .web_auth
                    .session_is_valid(token, web_auth::idle_timeout(&settings))
            })
        {
            return None;
        }
        Some(web_auth::effective_read_only(self.origin, &settings))
    }

    pub fn touch_input(&self, state: &AppState) -> bool {
        let settings = state.settings_service.get_settings().web_access;
        !settings.auth_required()
            || self.token.as_ref().is_some_and(|token| {
                state
                    .web_auth
                    .validate_session(token, web_auth::idle_timeout(&settings))
            })
    }

    pub async fn revoked(&self, state: &AppState) {
        let mut changes = state.web_auth.subscribe();
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            if self.permissions(state).is_none() {
                return;
            }
            tokio::select! { _ = changes.changed() => {}, _ = timer.tick() => {} }
        }
    }
}
