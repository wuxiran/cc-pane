//! Browser trust is separate from socket locality: a website can call loopback.
use crate::state::AppState;
use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, Request, StatusCode, Uri},
    middleware::Next,
    response::{IntoResponse, Response},
};

pub async fn guard(State(state): State<AppState>, request: Request<Body>, next: Next) -> Response {
    if !trusted(
        request.headers(),
        state
            .settings_service
            .get_settings()
            .web_access
            .auth_required(),
    ) {
        return (StatusCode::FORBIDDEN, "Untrusted browser origin or host").into_response();
    }
    next.run(request).await
}

fn trusted(headers: &HeaderMap, authenticated_server: bool) -> bool {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    // Passwordless servers must not be reachable under a rebound attacker hostname.
    if !authenticated_server && host.is_some_and(|host| !loopback_host(host)) {
        return false;
    }
    if headers
        .get("sec-fetch-site")
        .is_some_and(|v| v == "cross-site")
    {
        return false;
    }
    let Some(origin) = headers.get(header::ORIGIN) else {
        // Native/mobile clients don't send Origin. They still pass IP and password checks.
        return true;
    };
    let Some(host) = host else {
        return false;
    };
    let Ok(origin) = origin.to_str().unwrap_or("").parse::<Uri>() else {
        return false;
    };
    let Some(scheme @ ("http" | "https")) = origin.scheme_str() else {
        return false;
    };
    if origin.path() != "/" && !origin.path().is_empty() || origin.query().is_some() {
        return false;
    }
    let Some(authority) = origin.authority() else {
        return false;
    };
    if authority.as_str().contains('@') {
        return false;
    }
    let Ok(expected) = host.parse::<axum::http::uri::Authority>() else {
        return false;
    };
    authority.host().eq_ignore_ascii_case(expected.host())
        && authority
            .port_u16()
            .unwrap_or(if scheme == "https" { 443 } else { 80 })
            == expected
                .port_u16()
                .unwrap_or(if scheme == "https" { 443 } else { 80 })
}

fn loopback_host(host: &str) -> bool {
    host.parse::<axum::http::uri::Authority>()
        .ok()
        .is_some_and(|authority| {
            let host = authority.host().trim_matches(['[', ']']);
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn origin_and_host_are_both_checked() {
        for (host, origin, auth, allowed) in [
            ("localhost:8080", "http://localhost:8080", false, true),
            ("[::1]:8080", "http://[::1]:8080", false, true),
            ("localhost:8080", "https://untrusted.example", false, false),
            ("localhost:8080", "http://localhost:9999", false, false),
            ("localhost:8080", "null", false, false),
            (
                "rebound.example:8080",
                "http://rebound.example:8080",
                false,
                false,
            ),
            ("private.example", "https://private.example", true, true),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(header::HOST, host.parse().unwrap());
            headers.insert(header::ORIGIN, origin.parse().unwrap());
            assert_eq!(trusted(&headers, auth), allowed, "{host} / {origin}");
        }
    }
}
