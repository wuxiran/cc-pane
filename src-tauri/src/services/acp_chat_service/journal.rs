//! App-owned durable run history. One background writer serializes SQLite work;
//! prompt admission and completion await a durable acknowledgement. Streaming
//! never blocks the protocol reader, and a bounded queue reports incomplete logs.
use crate::utils::{AppError, AppResult};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc, Arc, Mutex,
};
use tokio::sync::{oneshot, OwnedSemaphorePermit, Semaphore};

const MAX_QUEUE_BYTES: usize = 16 * 1024 * 1024;
const MAX_EVENT_BYTES: usize = 16 * 1024 * 1024;
const MAX_PROMPT_BYTES: usize = 48 * 1024 * 1024;
const MAX_READ_BYTES: usize = 4 * 1024 * 1024;
type Reply<T> = oneshot::Sender<AppResult<T>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub id: String,
    pub chat_id: String,
    pub engine_id: String,
    pub acp_session_id: String,
    pub cwd: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub status: String,
    pub checkpoint_id: Option<String>,
    pub recording_error: Option<String>,
    pub event_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    pub seq: u64,
    pub at: i64,
    pub kind: String,
    pub payload: Value,
}

#[derive(Default, Clone)]
pub struct RunFilter {
    pub chat_id: Option<String>,
    pub engine_id: Option<String>,
    pub acp_session_id: Option<String>,
    pub offset: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPage {
    pub runs: Vec<RunRecord>,
    pub has_more: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    pub events: Vec<RunEvent>,
    pub has_more: bool,
}

enum Job {
    Begin(RunRecord, String, OwnedSemaphorePermit, Reply<()>),
    Event(String, String, String, i64),
    Finish(String, String, Option<String>, Reply<Option<String>>),
    List(RunFilter, Reply<RunPage>),
    Read(String, u64, Reply<EventPage>),
    Shutdown,
}

#[derive(Clone)]
pub(super) struct RunJournal {
    sender: mpsc::Sender<Job>,
    queued: Arc<AtomicUsize>,
    faults: Arc<Mutex<HashMap<String, String>>>,
    admissions: Arc<Semaphore>,
    send_gate: Arc<Mutex<()>>,
    shutdown_started: Arc<AtomicBool>,
    stopped: tokio::sync::watch::Receiver<bool>,
}

fn storage_error(error: impl std::fmt::Display) -> AppError {
    AppError::coded(
        "ACP_RECORDING_FAILED",
        format!("Unable to save Agent run records: {error}"),
    )
}

struct LimitedJson {
    bytes: Vec<u8>,
    limit: usize,
}

impl Write for LimitedJson {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let needed = self.bytes.len().saturating_add(bytes.len());
        if needed > self.limit {
            return Err(std::io::Error::other(
                "durable record exceeds its byte limit",
            ));
        }
        if needed > self.bytes.capacity() {
            let capacity = self
                .bytes
                .capacity()
                .saturating_mul(2)
                .max(needed)
                .min(self.limit);
            self.bytes.reserve_exact(capacity - self.bytes.len());
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn encode_limited(value: &Value, limit: usize) -> AppResult<String> {
    let mut buffer = LimitedJson {
        bytes: Vec::with_capacity(limit.min(4096)),
        limit,
    };
    serde_json::to_writer(&mut buffer, value).map_err(storage_error)?;
    String::from_utf8(buffer.bytes).map_err(storage_error)
}

struct OwnerLease {
    file: File,
}

impl OwnerLease {
    fn acquire(directory: &Path) -> AppResult<Self> {
        let path = directory.join("writer.lock");
        if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(storage_error(
                "journal owner lock must not be a symbolic link",
            ));
        }
        let mut options = OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0);
        }
        let file = options.open(path).map_err(storage_error)?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            // SAFETY: this owned descriptor remains open for the worker lifetime.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err(storage_error(
                    "another application already owns the run journal",
                ));
            }
        }
        Ok(Self { file })
    }
}

impl Drop for OwnerLease {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            // Release a normal shutdown explicitly, even across an unrelated
            // fork-before-exec. A crashed process still releases via the OS.
            unsafe {
                libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
            }
        }
        #[cfg(not(unix))]
        let _ = &self.file;
    }
}

fn project_history_payload(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            let image = fields
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| matches!(kind, "image" | "image_url" | "input_image"))
                || ["mimeType", "mime_type"].iter().any(|key| {
                    fields
                        .get(*key)
                        .and_then(Value::as_str)
                        .is_some_and(|mime| mime.starts_with("image/"))
                });
            let mut omitted = 0usize;
            for key in ["data", "blob", "base64", "url", "image_url", "imageUrl"] {
                let should_omit = fields.get(key).and_then(Value::as_str).is_some_and(|text| {
                    image && matches!(key, "data" | "blob" | "base64")
                        || text.starts_with("data:image/")
                });
                if should_omit {
                    if let Some(Value::String(data)) = fields.remove(key) {
                        omitted += data.len();
                    }
                }
            }
            if omitted > 0 {
                fields.insert("historyImageDataOmitted".into(), Value::Bool(true));
                fields.insert("historyImageDataBytes".into(), serde_json::json!(omitted));
            }
            for nested in fields.values_mut() {
                project_history_payload(nested);
            }
        }
        Value::Array(items) => {
            for item in items {
                project_history_payload(item);
            }
        }
        Value::String(text) if text.starts_with("data:image/") => {
            *text = format!(
                "[image data omitted in history preview: {} bytes]",
                text.len()
            );
        }
        Value::String(text) if text.len() > 64 * 1024 => {
            let mut end = 64 * 1024;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
            text.push_str("\n… [recorded text truncated in history preview]");
        }
        _ => {}
    }
}

impl RunJournal {
    pub fn new(directory: PathBuf) -> Self {
        let (sender, receiver) = mpsc::channel();
        let queued = Arc::new(AtomicUsize::new(0));
        let faults = Arc::new(Mutex::new(HashMap::new()));
        let queue = queued.clone();
        let errors = faults.clone();
        let (stopped_sender, stopped) = tokio::sync::watch::channel(false);
        // A failed worker leaves a disconnected sender; admission then fails
        // explicitly rather than running a turn with a fictitious history.
        if let Err(error) = std::thread::Builder::new()
            .name("cc-panes-run-journal".into())
            .spawn(move || {
                worker(directory, receiver, queue, errors);
                // worker has dropped both SQLite and the owner lease before
                // acknowledging shutdown to every concurrent waiter.
                let _ = stopped_sender.send(true);
            })
        {
            tracing::error!(%error, "cannot start Agent run journal");
        }
        Self {
            sender,
            queued,
            faults,
            admissions: Arc::new(Semaphore::new(2)),
            send_gate: Arc::new(Mutex::new(())),
            shutdown_started: Arc::new(AtomicBool::new(false)),
            stopped,
        }
    }

    async fn request<T>(&self, make: impl FnOnce(Reply<T>) -> Job) -> AppResult<T> {
        let (sender, receiver) = oneshot::channel();
        self.send_job(make(sender))?;
        receiver.await.map_err(storage_error)?
    }

    fn send_job(&self, job: Job) -> AppResult<()> {
        let _send = self.send_gate.lock().unwrap_or_else(|p| p.into_inner());
        if self.shutdown_started.load(Ordering::Acquire) {
            return Err(storage_error("run journal has stopped"));
        }
        self.sender.send(job).map_err(storage_error)
    }

    /// Drain already queued jobs and await the actual SQLite/owner-lease close.
    /// All clones share the same barrier, including callers whose waiter drops.
    pub async fn shutdown(&self) -> AppResult<()> {
        {
            let _send = self.send_gate.lock().unwrap_or_else(|p| p.into_inner());
            if !self.shutdown_started.swap(true, Ordering::AcqRel) {
                self.admissions.close();
                // If the receiver already closed, the watch signal below still
                // distinguishes a successful exit from a worker panic/failure.
                let _ = self.sender.send(Job::Shutdown);
            }
        }
        let mut stopped = self.stopped.clone();
        loop {
            if *stopped.borrow_and_update() {
                return Ok(());
            }
            stopped.changed().await.map_err(storage_error)?;
        }
    }

    pub async fn begin(&self, record: RunRecord, prompt: &Value) -> AppResult<()> {
        if self.shutdown_started.load(Ordering::Acquire) {
            return Err(storage_error("run journal has stopped"));
        }
        // A queued job owns the permit even if the awaiting caller is cancelled.
        // Acquire before encoding so parallel large prompts cannot allocate without bound.
        let permit = self
            .admissions
            .clone()
            .acquire_owned()
            .await
            .map_err(storage_error)?;
        let encoded = encode_limited(prompt, MAX_PROMPT_BYTES)?;
        self.request(|reply| Job::Begin(record, encoded, permit, reply))
            .await
    }

    pub fn event(&self, id: &str, kind: &str, payload: &Value) {
        if self.shutdown_started.load(Ordering::Acquire) {
            return;
        }
        if self
            .faults
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains_key(id)
        {
            return;
        }
        let encoded = match encode_limited(payload, MAX_EVENT_BYTES) {
            Ok(value) => value,
            Err(error) => {
                self.faults
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .insert(id.into(), error.to_string());
                return;
            }
        };
        let size = encoded.len();
        if size > MAX_EVENT_BYTES
            || self.queued.fetch_add(size, Ordering::Relaxed) + size > MAX_QUEUE_BYTES
        {
            if size <= MAX_EVENT_BYTES {
                self.queued.fetch_sub(size, Ordering::Relaxed);
            }
            self.faults
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(
                    id.into(),
                    "Recording buffer limit reached; this run's history is incomplete".into(),
                );
            return;
        }
        if self
            .send_job(Job::Event(
                id.into(),
                kind.into(),
                encoded,
                super::unix_millis(),
            ))
            .is_err()
        {
            self.queued.fetch_sub(size, Ordering::Relaxed);
            self.faults
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(
                    id.into(),
                    "Recording worker stopped; this run's history is incomplete".into(),
                );
        }
    }

    pub async fn finish(
        &self,
        id: String,
        status: String,
        checkpoint_id: Option<String>,
    ) -> AppResult<Option<String>> {
        self.request(|reply| Job::Finish(id, status, checkpoint_id, reply))
            .await
    }
    pub async fn list(&self, filter: RunFilter) -> AppResult<RunPage> {
        self.request(|reply| Job::List(filter, reply)).await
    }
    pub async fn read(&self, id: String, after: u64) -> AppResult<EventPage> {
        self.request(|reply| Job::Read(id, after, reply)).await
    }
}

struct OwnedConnection {
    connection: Connection,
    _lease: OwnerLease,
}

fn open(directory: &Path) -> AppResult<OwnedConnection> {
    std::fs::create_dir_all(directory).map_err(storage_error)?;
    if std::fs::symlink_metadata(directory)
        .map_err(storage_error)?
        .file_type()
        .is_symlink()
    {
        return Err(storage_error(
            "journal directory must not be a symbolic link",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
            .map_err(storage_error)?;
    }
    // Recovery must never run in a second application process before the
    // desktop single-instance plugin has rejected that process.
    let lease = OwnerLease::acquire(directory)?;
    let path = directory.join("runs.sqlite3");
    if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(storage_error(
            "journal database must not be a symbolic link",
        ));
    }
    let conn = Connection::open(&path).map_err(storage_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(storage_error)?;
    }
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(storage_error)?;
    let journal_mode: String = conn
        .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
        .map_err(storage_error)?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(storage_error("journal database could not enable WAL mode"));
    }
    conn.pragma_update(None, "synchronous", "FULL")
        .map_err(storage_error)?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, chat_id TEXT NOT NULL,
        engine_id TEXT NOT NULL, session_id TEXT NOT NULL, cwd TEXT NOT NULL,
        started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL,
        checkpoint_id TEXT, recording_error TEXT);
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id), at INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
        CREATE INDEX IF NOT EXISTS runs_chat ON runs(chat_id, started_at);
        CREATE INDEX IF NOT EXISTS runs_session ON runs(engine_id, session_id);").map_err(storage_error)?;
    conn.execute(
        "UPDATE runs SET status='interrupted',finished_at=?1 WHERE status='running'",
        [super::unix_millis()],
    )
    .map_err(storage_error)?;
    Ok(OwnedConnection {
        connection: conn,
        _lease: lease,
    })
}

fn worker(
    directory: PathBuf,
    receiver: mpsc::Receiver<Job>,
    queued: Arc<AtomicUsize>,
    faults: Arc<Mutex<HashMap<String, String>>>,
) {
    let connection = open(&directory);
    let mut deferred = None;
    loop {
        let Some(job) = deferred.take().or_else(|| receiver.recv().ok()) else {
            break;
        };
        let result = connection
            .as_ref()
            .map(|owned| &owned.connection)
            .map_err(storage_error);
        match job {
            Job::Shutdown => break,
            Job::Begin(record, prompt, permit, reply) => {
                let outcome = result.and_then(|conn| {
                    let tx = conn.unchecked_transaction().map_err(storage_error)?;
                    tx.execute("INSERT INTO runs(id,chat_id,engine_id,session_id,cwd,started_at,status,checkpoint_id) VALUES (?1,?2,?3,?4,?5,?6,'running',?7)",
                        params![record.id,record.chat_id,record.engine_id,record.acp_session_id,record.cwd,record.started_at,record.checkpoint_id]).map_err(storage_error)?;
                    tx.execute("INSERT INTO events(run_id,at,kind,payload) VALUES (?1,?2,'user_prompt',?3)", params![record.id,record.started_at,prompt]).map_err(storage_error)?;
                    tx.commit().map_err(storage_error)
                });
                drop(permit);
                let _ = reply.send(outcome);
            }
            Job::Event(id, kind, payload, at) => {
                let mut batch = vec![(id, kind, payload, at)];
                let deadline = std::time::Instant::now() + std::time::Duration::from_millis(8);
                while batch.len() < 64 {
                    match receiver
                        .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                    {
                        Ok(Job::Event(id, kind, payload, at)) => {
                            batch.push((id, kind, payload, at))
                        }
                        Ok(other) => {
                            deferred = Some(other);
                            break;
                        }
                        Err(_) => break,
                    }
                }
                let bytes = batch.iter().map(|event| event.2.len()).sum();
                let outcome = result.and_then(|conn| {
                    let tx = conn.unchecked_transaction().map_err(storage_error)?;
                    for (id, kind, payload, at) in &batch {
                        tx.execute(
                            "INSERT INTO events(run_id,at,kind,payload) VALUES (?1,?2,?3,?4)",
                            params![id, at, kind, payload],
                        )
                        .map_err(storage_error)?;
                    }
                    tx.commit().map_err(storage_error)
                });
                if let Err(error) = outcome {
                    let mut errors = faults.lock().unwrap_or_else(|p| p.into_inner());
                    for (id, _, _, _) in &batch {
                        errors
                            .entry(id.clone())
                            .or_insert_with(|| error.to_string());
                    }
                }
                queued.fetch_sub(bytes, Ordering::Relaxed);
            }
            Job::Finish(id, status, checkpoint, reply) => {
                let error = faults
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(&id)
                    .cloned();
                let outcome = result.and_then(|conn| {
                    let changed = conn.execute("UPDATE runs SET status=?2,finished_at=?3,checkpoint_id=COALESCE(?4,checkpoint_id),recording_error=?5 WHERE id=?1 AND status='running'",
                        params![id,status,super::unix_millis(),checkpoint,error]).map_err(storage_error)?;
                    if changed != 1 { return Err(storage_error("run was not active during finalization")); }
                    // The durable row now retains this error; the live-only index
                    // must not accumulate one entry for every past failed run.
                    faults.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
                    Ok(error)
                });
                let _ = reply.send(outcome);
            }
            Job::List(filter, reply) => {
                let _ = reply.send(result.and_then(|conn| list(conn, filter, &faults)));
            }
            Job::Read(id, after, reply) => {
                let _ = reply.send(result.and_then(|conn| read(conn, &id, after)));
            }
        }
    }
}

fn list(
    conn: &Connection,
    filter: RunFilter,
    faults: &Mutex<HashMap<String, String>>,
) -> AppResult<RunPage> {
    let mut query = conn.prepare("SELECT id,chat_id,engine_id,session_id,cwd,started_at,finished_at,status,checkpoint_id,recording_error,
        (SELECT COUNT(*) FROM events WHERE run_id=runs.id) FROM runs
        WHERE (?1 IS NULL OR chat_id=?1) AND (?2 IS NULL OR engine_id=?2) AND (?3 IS NULL OR session_id=?3)
        ORDER BY started_at DESC,id DESC LIMIT 51 OFFSET ?4").map_err(storage_error)?;
    let mut runs = query
        .query_map(
            params![
                filter.chat_id,
                filter.engine_id,
                filter.acp_session_id,
                filter.offset
            ],
            |row| {
                Ok(RunRecord {
                    id: row.get(0)?,
                    chat_id: row.get(1)?,
                    engine_id: row.get(2)?,
                    acp_session_id: row.get(3)?,
                    cwd: row.get(4)?,
                    started_at: row.get(5)?,
                    finished_at: row.get(6)?,
                    status: row.get(7)?,
                    checkpoint_id: row.get(8)?,
                    recording_error: row.get(9)?,
                    event_count: row.get(10)?,
                })
            },
        )
        .map_err(storage_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(storage_error)?;
    let more = runs.len() > 50;
    runs.truncate(50);
    let faults = faults.lock().unwrap_or_else(|p| p.into_inner());
    for run in &mut runs {
        if let Some(error) = faults.get(&run.id) {
            run.recording_error = Some(error.clone());
        }
    }
    Ok(RunPage {
        runs,
        has_more: more,
    })
}

fn read(conn: &Connection, id: &str, after: u64) -> AppResult<EventPage> {
    let after = i64::try_from(after).map_err(storage_error)?;
    let mut query = conn.prepare("SELECT seq,at,kind,payload FROM events WHERE run_id=?1 AND seq>?2 ORDER BY seq LIMIT 201").map_err(storage_error)?;
    let mut rows = query.query(params![id, after]).map_err(storage_error)?;
    let mut events = Vec::new();
    let mut read_bytes = 0usize;
    while let Some(row) = rows.next().map_err(storage_error)? {
        let encoded: String = row.get(3).map_err(storage_error)?;
        if events.len() == 200
            || (!events.is_empty() && read_bytes.saturating_add(encoded.len()) > MAX_READ_BYTES)
        {
            return Ok(EventPage {
                events,
                has_more: true,
            });
        }
        read_bytes = read_bytes.saturating_add(encoded.len());
        let mut payload: Value = serde_json::from_str(&encoded).map_err(storage_error)?;
        project_history_payload(&mut payload);
        if encode_limited(&payload, MAX_READ_BYTES).is_err() {
            payload = serde_json::json!({"historyPayloadOmitted":true,"originalBytes":encoded.len(),
                "reason":"Recorded event exceeds the history preview limit"});
        }
        events.push(RunEvent {
            seq: row.get(0).map_err(storage_error)?,
            at: row.get(1).map_err(storage_error)?,
            kind: row.get(2).map_err(storage_error)?,
            payload,
        });
    }
    Ok(EventPage {
        events,
        has_more: false,
    })
}

#[cfg(test)]
#[path = "journal_tests.rs"]
mod tests;
