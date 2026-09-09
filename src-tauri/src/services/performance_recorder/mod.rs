mod models;
mod ring_log;
pub use models::{DiagnosticEvent, EventKind, FrontendSnapshot, RecorderStatus};

use super::TerminalDaemonEventBridge;
use cc_panes_core::services::SystemStatsService;
use ring_log::{RingLog, FILE_BYTES, FILE_COUNT};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SAMPLE_INTERVAL: Duration = Duration::from_secs(15);
const EVENT_CAPACITY: usize = 128;

pub struct PerformanceRecorder {
    directory: PathBuf,
    frontend: Mutex<Option<(Instant, FrontendSnapshot)>>,
    events: mpsc::SyncSender<Option<DiagnosticEvent>>,
    stop: AtomicBool,
    running: AtomicBool,
    dropped: AtomicU64,
    last_write: AtomicU64,
    last_error: Mutex<Option<String>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn executable_hash() -> Option<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(std::env::current_exe().ok()?).ok()?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).ok()?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Some(format!("{:x}", hash.finalize()))
}

impl PerformanceRecorder {
    pub fn start(
        directory: PathBuf,
        manifest: PathBuf,
        version: String,
        bridge: Arc<TerminalDaemonEventBridge>,
    ) -> Arc<Self> {
        let (events, receiver) = mpsc::sync_channel(EVENT_CAPACITY);
        let recorder = Arc::new(Self {
            directory,
            frontend: Mutex::new(None),
            events,
            stop: AtomicBool::new(false),
            running: AtomicBool::new(false),
            dropped: AtomicU64::new(0),
            last_write: AtomicU64::new(0),
            last_error: Mutex::new(None),
        });
        let worker = recorder.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("performance-recorder".into())
            .spawn(move || worker.run(receiver, manifest, version, bridge))
        {
            recorder.set_error(error.to_string());
        }
        recorder
    }

    pub fn update_frontend(&self, snapshot: FrontendSnapshot) -> Result<(), &'static str> {
        snapshot.validate()?;
        *self.frontend.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), snapshot));
        Ok(())
    }

    pub fn record_event(&self, event: DiagnosticEvent) -> bool {
        if event
            .session_id
            .as_deref()
            .is_some_and(|id| !models::valid_session_id(id))
        {
            return false;
        }
        if self.events.try_send(Some(event)).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        true
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.events.try_send(None);
    }

    pub fn status(&self) -> RecorderStatus {
        RecorderStatus {
            running: self.running.load(Ordering::Acquire),
            directory: self.directory.to_string_lossy().into_owned(),
            last_write_at_ms: self.last_write.load(Ordering::Relaxed),
            dropped_events: self.dropped.load(Ordering::Relaxed),
            last_error: self
                .last_error
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
            sample_interval_seconds: SAMPLE_INTERVAL.as_secs(),
            max_total_bytes: FILE_BYTES * FILE_COUNT as u64,
        }
    }

    fn set_error(&self, message: String) {
        let mut error = self.last_error.lock().unwrap_or_else(|e| e.into_inner());
        if error.as_deref() != Some(&message) {
            tracing::warn!(error = %message, "performance recorder write failed");
        }
        *error = Some(message);
    }

    fn write(&self, log: &mut RingLog, boot: &str, kind: &str, data: Value) {
        let timestamp = now_ms();
        let record = json!({ "schemaVersion":1, "timestampMs":timestamp, "bootId":boot,
            "appPid":std::process::id(), "kind":kind, "data":data });
        match log.append(&record) {
            Ok(()) => {
                self.last_write.store(timestamp, Ordering::Relaxed);
                *self.last_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
            }
            Err(error) => self.set_error(error.to_string()),
        }
    }

    fn sample(
        &self,
        stats: &SystemStatsService,
        manifest: &std::path::Path,
        bridge: &TerminalDaemonEventBridge,
    ) -> Value {
        #[derive(serde::Deserialize)]
        struct Manifest {
            pid: u32,
        }
        let started = Instant::now();
        let daemon = std::fs::read(manifest)
            .ok()
            .and_then(|data| serde_json::from_slice::<Manifest>(&data).ok())
            .map(|m| m.pid);
        let processes = stats.get_diagnostic_processes(daemon);
        let (frontend_age_ms, frontend) = self
            .frontend
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|(at, snapshot)| {
                (
                    Some(at.elapsed().as_millis() as u64),
                    Some(snapshot.clone()),
                )
            })
            .unwrap_or((None, None));
        json!({ "processes":processes, "bridge":bridge.stats(), "frontendAgeMs":frontend_age_ms,
            "frontend":frontend, "droppedEvents":self.dropped.load(Ordering::Relaxed), "sampleDurationMs":started.elapsed().as_millis() as u64 })
    }

    fn run(
        &self,
        receiver: mpsc::Receiver<Option<DiagnosticEvent>>,
        manifest: PathBuf,
        version: String,
        bridge: Arc<TerminalDaemonEventBridge>,
    ) {
        let mut log = match RingLog::new(&self.directory, FILE_BYTES, FILE_COUNT) {
            Ok(log) => log,
            Err(error) => {
                self.set_error(error.to_string());
                return;
            }
        };
        self.running.store(true, Ordering::Release);
        let boot = uuid::Uuid::new_v4().to_string();
        let stats = SystemStatsService::new();
        self.write(&mut log, &boot, "start", json!({ "version":version, "executableSha256":executable_hash(), "platform":std::env::consts::OS,
            "intervalSeconds":SAMPLE_INTERVAL.as_secs(), "cpuBasis":"one-core-100-percent", "maxTotalBytes":FILE_BYTES * FILE_COUNT as u64 }));
        let mut next_sample = Instant::now();
        while !self.stop.load(Ordering::Acquire) {
            if Instant::now() >= next_sample {
                self.write(
                    &mut log,
                    &boot,
                    "sample",
                    self.sample(&stats, &manifest, &bridge),
                );
                next_sample = Instant::now() + SAMPLE_INTERVAL;
            }
            match receiver.recv_timeout(next_sample.saturating_duration_since(Instant::now())) {
                Ok(Some(event)) => {
                    let manual = matches!(event.kind, EventKind::ManualMarker);
                    self.write(&mut log, &boot, "event", json!(event));
                    if manual {
                        next_sample = Instant::now();
                    }
                }
                Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
        self.write(&mut log, &boot, "stop", json!({}));
        self.running.store(false, Ordering::Release);
    }
}
