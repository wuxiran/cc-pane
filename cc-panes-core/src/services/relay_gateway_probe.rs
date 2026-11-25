//! 启动前探活：供应商是从 Magpie 路由组 / cc-switch 本地代理导入的、且地址是回环时，
//! 先对网关端口做一次 ≤300ms 的 TCP 连接。连不上就直接让这次启动失败，并说清楚是哪个网关
//! 没在跑——否则 CLI 会启动成功、第一条请求才报连接被拒，看着像中转站坏了。
//!
//! 只在本机会话探：WSL / SSH 会话里的 `127.0.0.1` 指的是对端自己的回环（WSL2 NAT 下也不是
//! 宿主机），从宿主机探到的结果对它没有意义，所以记一条日志后放行。

use std::net::{IpAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

use tracing::warn;

use crate::models::provider::{EndpointKind, Provider, ProviderOriginKind};
use crate::services::provider_resolver::ResolvedProviderPlan;
use crate::utils::{AppError, AppResult, LaunchRuntime};

/// 探活超时。
pub const RELAY_PROBE_TIMEOUT: Duration = Duration::from_millis(300);
/// Magpie 路由组导入后的 `source.external_id` 前缀。
pub const MAGPIE_GROUP_EXTERNAL_PREFIX: &str = "group:";
/// cc-switch 代理导入后的 `source.external_id` 前缀。
pub const CC_SWITCH_PROXY_EXTERNAL_PREFIX: &str = "proxy:";

/// 依赖本地网关运行的供应商来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayGateway {
    Magpie,
    CcSwitchProxy,
}

impl RelayGateway {
    fn error_code(self) -> &'static str {
        match self {
            RelayGateway::Magpie => "MAGPIE_GATEWAY_UNREACHABLE",
            RelayGateway::CcSwitchProxy => "CC_SWITCH_PROXY_UNREACHABLE",
        }
    }

    fn message(self, address: &str) -> String {
        match self {
            RelayGateway::Magpie => {
                format!("Magpie 网关未运行（{address}），请先打开 Magpie 或运行 magpie serve")
            }
            RelayGateway::CcSwitchProxy => {
                format!("cc-switch 代理未运行（{address}），请先打开 cc-switch 并启用本地代理")
            }
        }
    }
}

/// 探活决定。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayProbeDecision {
    /// 不是依赖本地网关的供应商，或地址不是回环：不探。
    NotApplicable,
    /// 本机会话：探 `host:port`。
    Probe {
        gateway: RelayGateway,
        host: String,
        port: u16,
    },
    /// WSL / SSH 会话：回环指对端，不探，只记日志。
    SkipRemoteRuntime { gateway: RelayGateway },
}

/// 供应商是否来自需要本地网关的导入（看来源标记，不看地址）。
pub fn relay_gateway_of(provider: &Provider) -> Option<RelayGateway> {
    let origin = provider.source.as_ref()?;
    let external_id = origin.external_id.as_deref()?;
    match origin.kind {
        ProviderOriginKind::Magpie if external_id.starts_with(MAGPIE_GROUP_EXTERNAL_PREFIX) => {
            Some(RelayGateway::Magpie)
        }
        ProviderOriginKind::CcSwitch
            if external_id.starts_with(CC_SWITCH_PROXY_EXTERNAL_PREFIX) =>
        {
            Some(RelayGateway::CcSwitchProxy)
        }
        _ => None,
    }
}

/// URL 指向回环地址时返回 `(host, port)`（无端口按协议默认端口）。
pub fn loopback_host_port(url: &str) -> Option<(String, u16)> {
    let parsed = url::Url::parse(url.trim()).ok()?;
    let host = parsed.host_str()?;
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let loopback = bare.eq_ignore_ascii_case("localhost")
        || bare.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
    if !loopback {
        return None;
    }
    Some((bare.to_string(), parsed.port_or_known_default()?))
}

/// 供应商的第一个回环地址（主接口优先，其次其余接口与兼容字段 `base_url`）。
fn provider_loopback_addr(provider: &Provider) -> Option<(String, u16)> {
    let primary = provider.primary_endpoint_kind();
    let ordered = std::iter::once(primary).chain(
        EndpointKind::ALL
            .into_iter()
            .filter(move |kind| *kind != primary),
    );
    ordered
        .filter_map(|kind| provider.endpoints.get(kind).map(str::to_string))
        .chain(provider.base_url.clone())
        .find_map(|url| loopback_host_port(&url))
}

pub fn relay_probe_decision(
    provider: Option<&Provider>,
    runtime: LaunchRuntime,
) -> RelayProbeDecision {
    let Some(provider) = provider else {
        return RelayProbeDecision::NotApplicable;
    };
    let Some(gateway) = relay_gateway_of(provider) else {
        return RelayProbeDecision::NotApplicable;
    };
    let Some((host, port)) = provider_loopback_addr(provider) else {
        return RelayProbeDecision::NotApplicable;
    };
    if runtime != LaunchRuntime::Local {
        return RelayProbeDecision::SkipRemoteRuntime { gateway };
    }
    RelayProbeDecision::Probe {
        gateway,
        host,
        port,
    }
}

/// 一次 TCP 连接探活。`localhost` 解析出的每个地址都试一次。
pub fn tcp_reachable(host: &str, port: u16, timeout: Duration) -> bool {
    let Ok(addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    addrs
        .into_iter()
        .any(|addr| TcpStream::connect_timeout(&addr, timeout).is_ok())
}

/// 启动前检查：依赖本地网关的供应商在本机会话里，网关必须连得上。
pub fn ensure_relay_gateway_reachable(
    plan: &ResolvedProviderPlan,
    runtime: LaunchRuntime,
) -> AppResult<()> {
    check_relay_gateway_with(plan.provider.as_ref(), runtime, |host, port| {
        tcp_reachable(host, port, RELAY_PROBE_TIMEOUT)
    })
}

fn check_relay_gateway_with(
    provider: Option<&Provider>,
    runtime: LaunchRuntime,
    connect: impl Fn(&str, u16) -> bool,
) -> AppResult<()> {
    match relay_probe_decision(provider, runtime) {
        RelayProbeDecision::NotApplicable => Ok(()),
        RelayProbeDecision::SkipRemoteRuntime { gateway } => {
            warn!(
                ?gateway,
                ?runtime,
                "provider relies on a loopback gateway; not probing from the host for a remote runtime"
            );
            Ok(())
        }
        RelayProbeDecision::Probe {
            gateway,
            host,
            port,
        } => {
            if connect(&host, port) {
                return Ok(());
            }
            let address = if host.contains(':') {
                format!("[{host}]:{port}")
            } else {
                format!("{host}:{port}")
            };
            let mut params =
                std::collections::HashMap::from([("address".to_string(), address.clone())]);
            if let Some(provider) = provider {
                params.insert("providerId".to_string(), provider.id.clone());
            }
            Err(AppError::coded_with_params(
                gateway.error_code(),
                gateway.message(&address),
                params,
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::provider::{ProviderEndpoints, ProviderOrigin, ProviderType};
    use std::cell::Cell;

    fn relay_provider(kind: ProviderOriginKind, external_id: &str, url: &str) -> Provider {
        Provider {
            id: "p".into(),
            provider_type: ProviderType::Anthropic,
            endpoints: ProviderEndpoints {
                anthropic: Some(url.into()),
                ..ProviderEndpoints::default()
            },
            source: Some(ProviderOrigin {
                kind,
                external_id: Some(external_id.into()),
                imported_at: None,
                fingerprint: None,
            }),
            ..Provider::default()
        }
    }

    #[test]
    fn loopback_detection_covers_ipv4_ipv6_and_localhost() {
        assert_eq!(
            loopback_host_port("http://127.0.0.1:3425/v1"),
            Some(("127.0.0.1".into(), 3425))
        );
        assert_eq!(
            loopback_host_port("http://localhost:15721"),
            Some(("localhost".into(), 15721))
        );
        assert_eq!(
            loopback_host_port("http://[::1]:3425"),
            Some(("::1".into(), 3425))
        );
        assert_eq!(
            loopback_host_port("http://127.0.0.1"),
            Some(("127.0.0.1".into(), 80))
        );
        assert_eq!(loopback_host_port("https://relay.example.com"), None);
        assert_eq!(loopback_host_port("http://192.168.1.20:3425/v1"), None);
        assert_eq!(loopback_host_port("not a url"), None);
    }

    #[test]
    fn decision_probes_only_gateway_sources_on_loopback_in_local_runtime() {
        let magpie = relay_provider(
            ProviderOriginKind::Magpie,
            "group:code",
            "http://127.0.0.1:3425",
        );
        assert_eq!(
            relay_probe_decision(Some(&magpie), LaunchRuntime::Local),
            RelayProbeDecision::Probe {
                gateway: RelayGateway::Magpie,
                host: "127.0.0.1".into(),
                port: 3425
            }
        );
        for runtime in [LaunchRuntime::Wsl, LaunchRuntime::Ssh] {
            assert_eq!(
                relay_probe_decision(Some(&magpie), runtime),
                RelayProbeDecision::SkipRemoteRuntime {
                    gateway: RelayGateway::Magpie
                }
            );
        }
        // Magpie 的普通中转站（非路由组）不探
        let plain = relay_provider(ProviderOriginKind::Magpie, "myrelay", "http://127.0.0.1:1");
        assert_eq!(
            relay_probe_decision(Some(&plain), LaunchRuntime::Local),
            RelayProbeDecision::NotApplicable
        );
        // 指向局域网的路由组（共享的 Magpie）不探
        let remote = relay_provider(
            ProviderOriginKind::Magpie,
            "group:code",
            "http://192.168.1.20:3425",
        );
        assert_eq!(
            relay_probe_decision(Some(&remote), LaunchRuntime::Local),
            RelayProbeDecision::NotApplicable
        );
        // 手动建的回环中转站不探
        let mut manual = magpie.clone();
        manual.source = None;
        assert_eq!(
            relay_probe_decision(Some(&manual), LaunchRuntime::Local),
            RelayProbeDecision::NotApplicable
        );
        assert_eq!(
            relay_probe_decision(None, LaunchRuntime::Local),
            RelayProbeDecision::NotApplicable
        );
        let proxy = relay_provider(
            ProviderOriginKind::CcSwitch,
            "proxy:claude",
            "http://127.0.0.1:15721",
        );
        assert!(matches!(
            relay_probe_decision(Some(&proxy), LaunchRuntime::Local),
            RelayProbeDecision::Probe {
                gateway: RelayGateway::CcSwitchProxy,
                port: 15721,
                ..
            }
        ));
    }

    #[test]
    fn unreachable_gateway_fails_with_coded_user_visible_error() {
        let magpie = relay_provider(
            ProviderOriginKind::Magpie,
            "group:code",
            "http://127.0.0.1:3425",
        );
        let err = check_relay_gateway_with(Some(&magpie), LaunchRuntime::Local, |_, _| false)
            .unwrap_err();
        let text = err.to_string();
        assert!(
            text.contains("Magpie 网关未运行（127.0.0.1:3425）"),
            "{text}"
        );
        assert!(text.contains("magpie serve"), "{text}");
        let value = serde_json::to_value(&err).unwrap();
        assert_eq!(value["code"], "MAGPIE_GATEWAY_UNREACHABLE");
        assert_eq!(value["params"]["address"], "127.0.0.1:3425");

        let proxy = relay_provider(
            ProviderOriginKind::CcSwitch,
            "proxy:codex",
            "http://127.0.0.1:15721/v1",
        );
        let err =
            check_relay_gateway_with(Some(&proxy), LaunchRuntime::Local, |_, _| false).unwrap_err();
        assert_eq!(
            serde_json::to_value(&err).unwrap()["code"],
            "CC_SWITCH_PROXY_UNREACHABLE"
        );

        assert!(check_relay_gateway_with(Some(&magpie), LaunchRuntime::Local, |_, _| true).is_ok());
        // 远端会话：不调用探测
        let called = Cell::new(false);
        assert!(
            check_relay_gateway_with(Some(&magpie), LaunchRuntime::Wsl, |_, _| {
                called.set(true);
                false
            })
            .is_ok()
        );
        assert!(!called.get());
    }

    #[test]
    fn tcp_probe_hits_own_ephemeral_listener_and_misses_after_close() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(tcp_reachable("127.0.0.1", port, RELAY_PROBE_TIMEOUT));
        drop(listener);
        assert!(!tcp_reachable("127.0.0.1", port, RELAY_PROBE_TIMEOUT));
    }
}
