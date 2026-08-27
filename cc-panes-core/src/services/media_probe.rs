//! Optional, bounded probing for generated and staged video assets.
//!
//! ComfyUI and other providers usually return useful media metadata, but that
//! metadata is still a declaration.  This module treats the bytes as the
//! authority when a local `ffprobe` executable is available.  Probing is
//! deliberately best-effort: an unavailable or broken probe tool never turns
//! an otherwise valid provider output into a failed generation.

use crate::utils::command::no_window_command;
use serde_json::Value;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_MAX_OUTPUT_BYTES: usize = 512 * 1024;
pub const MEDIA_PROBE_EXECUTABLE_ENV: &str = "CCPANES_FFPROBE";

/// Outcome of the optional probe.  The status is persisted so clients can
/// distinguish "no audio" from "audio could not be inspected".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaProbeStatus {
    Ok,
    Skipped,
    Unavailable,
    Timeout,
    OutputLimit,
    Failed,
    Invalid,
}

impl MediaProbeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Skipped => "skipped",
            Self::Unavailable => "unavailable",
            Self::Timeout => "timeout",
            Self::OutputLimit => "output_limit",
            Self::Failed => "failed",
            Self::Invalid => "invalid",
        }
    }
}

/// Runtime-only limits and executable selection for a probe.
#[derive(Debug, Clone)]
pub struct MediaProbeConfig {
    /// If set, use this executable and do not silently fall back to PATH.
    pub executable: Option<PathBuf>,
    pub timeout: Duration,
    pub max_output_bytes: usize,
}

impl Default for MediaProbeConfig {
    fn default() -> Self {
        Self {
            executable: None,
            timeout: DEFAULT_TIMEOUT,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
        }
    }
}

impl MediaProbeConfig {
    /// Read only the executable path from the process environment. Limits stay
    /// compiled in so an environment variable cannot disable the safety fence.
    pub fn from_environment() -> Self {
        let mut config = Self::default();
        if let Some(path) =
            std::env::var_os(MEDIA_PROBE_EXECUTABLE_ENV).filter(|value| !value.is_empty())
        {
            config.executable = Some(PathBuf::from(path));
        }
        config
    }

    pub fn with_executable(mut self, executable: impl Into<PathBuf>) -> Self {
        self.executable = Some(executable.into());
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout.clamp(Duration::from_millis(100), Duration::from_secs(60));
        self
    }

    pub fn with_max_output_bytes(mut self, bytes: usize) -> Self {
        self.max_output_bytes = bytes.clamp(4 * 1024, 8 * 1024 * 1024);
        self
    }
}

/// Normalized stream/container facts extracted from ffprobe JSON.
#[derive(Debug, Clone, PartialEq)]
pub struct MediaProbeReport {
    pub status: MediaProbeStatus,
    pub tool: Option<String>,
    pub reason: Option<String>,
    pub container: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
    pub fps: Option<f64>,
    pub frame_count: Option<i64>,
    pub audio: Option<bool>,
    pub codec: Option<String>,
    pub audio_codec: Option<String>,
    pub audio_channels: Option<i64>,
    pub sample_rate: Option<i64>,
    pub color_space: Option<String>,
    pub color_transfer: Option<String>,
    pub color_primaries: Option<String>,
    pub pixel_format: Option<String>,
    pub bit_depth: Option<i64>,
}

impl MediaProbeReport {
    fn status(status: MediaProbeStatus, reason: impl Into<String>) -> Self {
        Self {
            status,
            tool: None,
            reason: Some(reason.into()),
            container: None,
            width: None,
            height: None,
            duration_ms: None,
            fps: None,
            frame_count: None,
            audio: None,
            codec: None,
            audio_codec: None,
            audio_channels: None,
            sample_rate: None,
            color_space: None,
            color_transfer: None,
            color_primaries: None,
            pixel_format: None,
            bit_depth: None,
        }
    }

    fn skipped(reason: &str) -> Self {
        Self::status(MediaProbeStatus::Skipped, reason)
    }
}

/// Bounded ffprobe runner.  The struct is cheap to clone and contains no
/// process handles, so one instance can be shared by desktop and web workers.
#[derive(Debug, Clone, Default)]
pub struct MediaProbe {
    config: MediaProbeConfig,
}

impl MediaProbe {
    pub fn new(config: MediaProbeConfig) -> Self {
        Self { config }
    }

    pub fn from_environment() -> Self {
        Self::new(MediaProbeConfig::from_environment())
    }

    pub fn config(&self) -> &MediaProbeConfig {
        &self.config
    }

    /// Probe a controlled file.  Non-video files are intentionally skipped;
    /// image dimensions remain the provider/image decoder responsibility.
    pub fn probe_path(&self, path: &Path, mime_type: &str) -> MediaProbeReport {
        if !mime_type
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .starts_with("video/")
        {
            return MediaProbeReport::skipped("non-video asset");
        }
        if !path.is_file() {
            return MediaProbeReport::status(
                MediaProbeStatus::Failed,
                "probe input file is unavailable",
            );
        }
        let executable = match resolve_executable(self.config.executable.as_deref()) {
            Some(path) => path,
            None => {
                return MediaProbeReport::status(
                    MediaProbeStatus::Unavailable,
                    "ffprobe executable is unavailable",
                )
            }
        };
        let mut command = no_window_command(executable);
        command.args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            "-count_frames",
        ]);
        command.arg(path);
        report_from_process_result(run_bounded_command(
            &mut command,
            self.config.timeout,
            self.config.max_output_bytes,
        ))
    }
}

/// Parse ffprobe JSON independently of a process.  Keeping this pure makes
/// metadata behavior testable on hosts that do not ship ffmpeg.
pub fn parse_ffprobe_json(value: &Value) -> Result<MediaProbeReport, String> {
    let streams = value
        .get("streams")
        .and_then(Value::as_array)
        .ok_or_else(|| "ffprobe response has no streams".to_string())?;
    let video = streams
        .iter()
        .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("video"))
        .and_then(Value::as_object)
        .ok_or_else(|| "ffprobe response has no video stream".to_string())?;
    let audio = streams
        .iter()
        .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio"))
        .and_then(Value::as_object);
    let format = value.get("format").and_then(Value::as_object);
    let duration_ms = first_duration_ms(video, format);
    let frame_count = first_i64(video, &["nb_read_frames", "nb_frames"]);
    let fps = first_fps(video, &["avg_frame_rate", "r_frame_rate"]);
    let report = MediaProbeReport {
        status: MediaProbeStatus::Ok,
        tool: Some("ffprobe".to_string()),
        reason: None,
        container: format.and_then(|object| string_field(object, "format_name")),
        width: positive_i64(video, "width"),
        height: positive_i64(video, "height"),
        duration_ms,
        fps,
        frame_count,
        audio: Some(audio.is_some()),
        codec: string_field(video, "codec_name"),
        audio_codec: audio.and_then(|stream| string_field(stream, "codec_name")),
        audio_channels: audio.and_then(|stream| positive_i64(stream, "channels")),
        sample_rate: audio.and_then(|stream| positive_i64(stream, "sample_rate")),
        color_space: string_field(video, "color_space"),
        color_transfer: string_field(video, "color_transfer"),
        color_primaries: string_field(video, "color_primaries"),
        pixel_format: string_field(video, "pix_fmt"),
        bit_depth: first_i64(video, &["bits_per_raw_sample", "bits_per_sample"]),
    };
    Ok(report)
}

fn resolve_executable(configured: Option<&Path>) -> Option<PathBuf> {
    if let Some(path) = configured {
        if path.components().count() == 1 {
            return which::which(path).ok();
        }
        if !path.is_absolute() {
            return None;
        }
        return path.is_file().then(|| path.to_path_buf());
    }
    which::which("ffprobe").ok()
}

fn string_field(object: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .map(ToOwned::to_owned)
}

fn positive_i64(object: &serde_json::Map<String, Value>, key: &str) -> Option<i64> {
    parse_i64(object.get(key)).filter(|value| *value > 0)
}

fn first_i64(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<i64> {
    keys.iter()
        .find_map(|key| parse_i64(object.get(*key)).filter(|value| *value >= 0))
}

fn parse_i64(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(number)) => number.as_i64().or_else(|| {
            number
                .as_f64()
                .filter(|value| value.is_finite())
                .map(|value| value.round() as i64)
        }),
        Some(Value::String(value)) => value.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn first_duration_ms(
    video: &serde_json::Map<String, Value>,
    format: Option<&serde_json::Map<String, Value>>,
) -> Option<i64> {
    [
        video.get("duration"),
        format.and_then(|object| object.get("duration")),
    ]
    .into_iter()
    .find_map(parse_seconds_ms)
}

fn parse_seconds_ms(value: Option<&Value>) -> Option<i64> {
    let seconds = match value {
        Some(Value::Number(number)) => number.as_f64()?,
        Some(Value::String(value)) => value.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    if !seconds.is_finite() || seconds < 0.0 || seconds > i64::MAX as f64 / 1000.0 {
        return None;
    }
    Some((seconds * 1000.0).round() as i64)
}

fn first_fps(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| parse_fps(object.get(*key)))
}

fn parse_fps(value: Option<&Value>) -> Option<f64> {
    let raw = match value {
        Some(Value::Number(number)) => {
            return number
                .as_f64()
                .filter(|value| value.is_finite() && *value > 0.0)
        }
        Some(Value::String(value)) => value.trim(),
        _ => return None,
    };
    let fps = if let Some((numerator, denominator)) = raw.split_once('/') {
        let numerator = numerator.parse::<f64>().ok()?;
        let denominator = denominator.parse::<f64>().ok()?;
        if denominator <= 0.0 {
            return None;
        }
        numerator / denominator
    } else {
        raw.parse::<f64>().ok()?
    };
    fps.is_finite()
        .then_some(fps)
        .filter(|value| *value > 0.0 && *value <= 10_000.0)
}

enum ProbeProcessError {
    Unavailable,
    Timeout,
    OutputLimit,
    Io,
}

struct ProbeProcessOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
}

fn report_from_process_result(
    result: Result<ProbeProcessOutput, ProbeProcessError>,
) -> MediaProbeReport {
    let output = match result {
        Ok(output) => output,
        Err(ProbeProcessError::Unavailable) => {
            return MediaProbeReport::status(
                MediaProbeStatus::Unavailable,
                "ffprobe executable is unavailable",
            )
        }
        Err(ProbeProcessError::Timeout) => {
            return MediaProbeReport::status(MediaProbeStatus::Timeout, "ffprobe timed out")
        }
        Err(ProbeProcessError::OutputLimit) => {
            return MediaProbeReport::status(
                MediaProbeStatus::OutputLimit,
                "ffprobe output exceeded the limit",
            )
        }
        Err(ProbeProcessError::Io) => {
            return MediaProbeReport::status(
                MediaProbeStatus::Failed,
                "ffprobe could not be started",
            )
        }
    };
    if !output.status.success() {
        return MediaProbeReport::status(
            MediaProbeStatus::Failed,
            "ffprobe rejected the media container",
        );
    }
    let value = match serde_json::from_slice::<Value>(&output.stdout) {
        Ok(value) => value,
        Err(_) => {
            return MediaProbeReport::status(
                MediaProbeStatus::Invalid,
                "ffprobe returned invalid JSON",
            )
        }
    };
    match parse_ffprobe_json(&value) {
        Ok(mut report) => {
            report.tool = Some("ffprobe".to_string());
            report
        }
        Err(_) => MediaProbeReport::status(
            MediaProbeStatus::Invalid,
            "ffprobe JSON has no usable video stream",
        ),
    }
}

fn run_bounded_command(
    command: &mut Command,
    timeout: Duration,
    max_output_bytes: usize,
) -> Result<ProbeProcessOutput, ProbeProcessError> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                ProbeProcessError::Unavailable
            } else {
                ProbeProcessError::Io
            }
        })?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(ProbeProcessError::Io);
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(ProbeProcessError::Io);
    };
    let total = Arc::new(AtomicUsize::new(0));
    let exceeded = Arc::new(AtomicBool::new(false));
    let stdout_total = Arc::clone(&total);
    let stdout_exceeded = Arc::clone(&exceeded);
    let stdout_thread = thread::spawn(move || {
        read_limited(stdout, stdout_total, stdout_exceeded, max_output_bytes)
    });
    let stderr_total = Arc::clone(&total);
    let stderr_exceeded = Arc::clone(&exceeded);
    let stderr_thread = thread::spawn(move || {
        read_limited(stderr, stderr_total, stderr_exceeded, max_output_bytes)
    });

    let started = Instant::now();
    let status = loop {
        if exceeded.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            return Err(ProbeProcessError::OutputLimit);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return Err(ProbeProcessError::Timeout);
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return Err(ProbeProcessError::Io);
            }
        }
    };
    let stdout = stdout_thread.join().map_err(|_| ProbeProcessError::Io)?;
    let _ = stderr_thread.join().map_err(|_| ProbeProcessError::Io)?;
    if exceeded.load(Ordering::Acquire) {
        return Err(ProbeProcessError::OutputLimit);
    }
    Ok(ProbeProcessOutput { status, stdout })
}

fn read_limited<R: Read>(
    mut reader: R,
    total: Arc<AtomicUsize>,
    exceeded: Arc<AtomicBool>,
    max_output_bytes: usize,
) -> Vec<u8> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                let current = total.fetch_add(read, Ordering::AcqRel).saturating_add(read);
                if current > max_output_bytes {
                    exceeded.store(true, Ordering::Release);
                    break;
                }
                output.extend_from_slice(&buffer[..read]);
            }
            Err(_) => break,
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_video_and_audio_stream_metadata() {
        let value = serde_json::json!({
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "h264",
                    "width": 1920,
                    "height": 1080,
                    "duration": "2.504",
                    "avg_frame_rate": "30000/1001",
                    "nb_read_frames": "75",
                    "color_space": "bt709",
                    "color_transfer": "bt709",
                    "color_primaries": "bt709",
                    "pix_fmt": "yuv420p",
                    "bits_per_raw_sample": "8"
                },
                {
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "channels": 2,
                    "sample_rate": "48000"
                }
            ],
            "format": {"format_name": "matroska,webm", "duration": "2.5"}
        });
        let report = parse_ffprobe_json(&value).expect("probe JSON");
        assert_eq!(report.status, MediaProbeStatus::Ok);
        assert_eq!(report.container.as_deref(), Some("matroska,webm"));
        assert_eq!(report.width, Some(1920));
        assert_eq!(report.height, Some(1080));
        assert_eq!(report.duration_ms, Some(2504));
        assert!((report.fps.expect("fps") - 29.970029).abs() < 0.001);
        assert_eq!(report.frame_count, Some(75));
        assert_eq!(report.audio, Some(true));
        assert_eq!(report.audio_codec.as_deref(), Some("aac"));
        assert_eq!(report.audio_channels, Some(2));
        assert_eq!(report.sample_rate, Some(48000));
        assert_eq!(report.color_space.as_deref(), Some("bt709"));
        assert_eq!(report.color_transfer.as_deref(), Some("bt709"));
        assert_eq!(report.color_primaries.as_deref(), Some("bt709"));
        assert_eq!(report.pixel_format.as_deref(), Some("yuv420p"));
        assert_eq!(report.bit_depth, Some(8));
    }

    #[test]
    fn rejects_json_without_video_stream() {
        let error = parse_ffprobe_json(&serde_json::json!({
            "streams": [{"codec_type": "audio"}]
        }))
        .unwrap_err();
        assert!(error.contains("video stream"));
    }

    #[test]
    fn missing_explicit_executable_is_reported_as_unavailable() {
        let temp = tempfile::NamedTempFile::new().expect("temp file");
        let probe = MediaProbe::new(
            MediaProbeConfig::default().with_executable("cc-panes-no-such-ffprobe"),
        );
        let report = probe.probe_path(temp.path(), "video/mp4");
        assert_eq!(report.status, MediaProbeStatus::Unavailable);
    }

    #[test]
    fn non_video_files_are_skipped_without_running_a_process() {
        let temp = tempfile::NamedTempFile::new().expect("temp file");
        let probe = MediaProbe::new(
            MediaProbeConfig::default().with_executable("cc-panes-no-such-ffprobe"),
        );
        let report = probe.probe_path(temp.path(), "image/png");
        assert_eq!(report.status, MediaProbeStatus::Skipped);
    }

    #[test]
    fn invalid_json_and_process_limits_are_explicit_statuses() {
        let status = successful_exit_status();
        let invalid = report_from_process_result(Ok(ProbeProcessOutput {
            status,
            stdout: b"not-json".to_vec(),
        }));
        assert_eq!(invalid.status, MediaProbeStatus::Invalid);
        assert_eq!(
            invalid.reason.as_deref(),
            Some("ffprobe returned invalid JSON")
        );

        let timeout = report_from_process_result(Err(ProbeProcessError::Timeout));
        assert_eq!(timeout.status, MediaProbeStatus::Timeout);
        let limited = report_from_process_result(Err(ProbeProcessError::OutputLimit));
        assert_eq!(limited.status, MediaProbeStatus::OutputLimit);
    }

    fn successful_exit_status() -> ExitStatus {
        #[cfg(windows)]
        {
            Command::new("cmd")
                .args(["/c", "exit", "0"])
                .status()
                .expect("cmd status")
        }
        #[cfg(not(windows))]
        {
            Command::new("sh")
                .args(["-c", "exit 0"])
                .status()
                .expect("sh status")
        }
    }
}
