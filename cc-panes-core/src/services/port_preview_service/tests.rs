use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

/// 假转发：本地端口 = 首选端口（或 50000+序号），存活状态可从外部切换，drop 时计数。
struct FakeForward {
    port: u16,
    alive: Arc<AtomicBool>,
    dropped: Arc<AtomicUsize>,
}

impl PreviewForward for FakeForward {
    fn local_port(&self) -> u16 {
        self.port
    }
    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
}

impl Drop for FakeForward {
    fn drop(&mut self) {
        self.dropped.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct FakeForwarder {
    opened: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
    alive: Arc<Mutex<Vec<Arc<AtomicBool>>>>,
    taken_local_ports: Vec<u16>,
}

impl PreviewForwarder for FakeForwarder {
    fn open(
        &self,
        _ssh: &SshConnectionInfo,
        _remote_host: &str,
        remote_port: u16,
        preferred_local_port: Option<u16>,
    ) -> Result<Box<dyn PreviewForward>> {
        let index = self.opened.fetch_add(1, Ordering::SeqCst);
        let port = preferred_local_port
            .filter(|port| !self.taken_local_ports.contains(port))
            .unwrap_or(50_000 + index as u16);
        assert_eq!(preferred_local_port, Some(remote_port));
        let alive = Arc::new(AtomicBool::new(true));
        self.alive.lock().unwrap().push(alive.clone());
        Ok(Box::new(FakeForward {
            port,
            alive,
            dropped: self.dropped.clone(),
        }))
    }
}

fn ssh() -> SshConnectionInfo {
    SshConnectionInfo {
        host: "devbox".into(),
        port: 22,
        user: Some("me".into()),
        remote_path: "/srv/app".into(),
        identity_file: None,
        machine_id: None,
        auth_method: None,
    }
}

struct Harness {
    service: PortPreviewService,
    opened: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
    alive: Arc<Mutex<Vec<Arc<AtomicBool>>>>,
}

fn harness(taken_local_ports: Vec<u16>) -> Harness {
    let forwarder = FakeForwarder {
        taken_local_ports,
        ..FakeForwarder::default()
    };
    let opened = forwarder.opened.clone();
    let dropped = forwarder.dropped.clone();
    let alive = forwarder.alive.clone();
    Harness {
        service: PortPreviewService::new(Box::new(forwarder)),
        opened,
        dropped,
        alive,
    }
}

#[test]
fn normalizes_and_restricts_remote_hosts() {
    assert_eq!(
        normalize_preview_remote_host("0.0.0.0").unwrap(),
        "127.0.0.1"
    );
    assert_eq!(normalize_preview_remote_host("[::1]").unwrap(), "::1");
    assert_eq!(
        normalize_preview_remote_host("LocalHost").unwrap(),
        "localhost"
    );
    assert!(normalize_preview_remote_host("10.0.0.5").is_err());
    assert!(normalize_preview_remote_host("example.com").is_err());
}

#[test]
fn prefers_the_remote_port_locally_and_falls_back_when_taken() {
    let h = harness(vec![3000]);
    let free = h.service.open("s1", &ssh(), "localhost", 5173).unwrap();
    assert_eq!(free.local_port, 5173);
    let taken = h.service.open("s1", &ssh(), "localhost", 3000).unwrap();
    assert_ne!(taken.local_port, 3000);
    assert_eq!(taken.ssh_host, "devbox");
}

#[test]
fn reuses_a_live_tunnel_for_the_same_target() {
    let h = harness(vec![]);
    let first = h.service.open("s1", &ssh(), "0.0.0.0", 3000).unwrap();
    let again = h.service.open("s1", &ssh(), "127.0.0.1", 3000).unwrap();
    assert_eq!(first.id, again.id);
    assert_eq!(h.opened.load(Ordering::SeqCst), 1);
    // 不同会话或不同端口是不同隧道
    h.service.open("s2", &ssh(), "localhost", 3000).unwrap();
    h.service.open("s1", &ssh(), "localhost", 3001).unwrap();
    assert_eq!(h.service.list().len(), 3);
}

#[test]
fn rejects_invalid_requests_without_connecting() {
    let h = harness(vec![]);
    assert!(h.service.open("", &ssh(), "localhost", 3000).is_err());
    assert!(h.service.open("s1", &ssh(), "localhost", 0).is_err());
    assert!(h.service.open("s1", &ssh(), "192.168.1.2", 3000).is_err());
    assert_eq!(h.opened.load(Ordering::SeqCst), 0);
}

#[test]
fn close_and_session_end_release_forwards() {
    let h = harness(vec![]);
    let a = h.service.open("s1", &ssh(), "localhost", 3000).unwrap();
    h.service.open("s1", &ssh(), "localhost", 3001).unwrap();
    h.service.open("s2", &ssh(), "localhost", 3000).unwrap();

    assert!(h.service.close(&a.id));
    assert!(!h.service.close(&a.id));
    assert_eq!(h.dropped.load(Ordering::SeqCst), 1);

    assert_eq!(h.service.close_for_session("s1"), 1);
    assert_eq!(h.service.close_for_session("s1"), 0);
    let left = h.service.list();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].session_id, "s2");
    assert_eq!(h.dropped.load(Ordering::SeqCst), 2);
}

#[test]
fn dead_tunnels_are_pruned_and_reopened() {
    let h = harness(vec![]);
    let first = h.service.open("s1", &ssh(), "localhost", 3000).unwrap();
    h.alive.lock().unwrap()[0].store(false, Ordering::SeqCst);
    assert!(h.service.list().is_empty());
    let reopened = h.service.open("s1", &ssh(), "localhost", 3000).unwrap();
    assert_ne!(first.id, reopened.id);
    assert_eq!(h.opened.load(Ordering::SeqCst), 2);
}

#[test]
fn caps_the_number_of_tunnels() {
    let h = harness(vec![]);
    for port in 0..MAX_TUNNELS as u16 {
        h.service
            .open("s1", &ssh(), "localhost", 3000 + port)
            .unwrap();
    }
    assert!(h.service.open("s1", &ssh(), "localhost", 9999).is_err());
}
