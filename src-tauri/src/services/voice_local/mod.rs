// 本地转写：sherpa-onnx 离线识别程序 + 本机模型，音频不出本机。
// 引擎和模型都在用户点「下载」后才拉取（catalog.rs 钉死地址与摘要），
// 每次转写起一个 sherpa-onnx-offline 进程读临时 WAV，解析它打印的 JSON 结果。
pub mod catalog;
pub mod install;

use crate::models::settings::VoiceSettings;
use crate::utils::AppResult;
use catalog::{
    engine_archive, engine_binary_relative, find_model, LocalModel, ModelKind, DEFAULT_LOCAL_MODEL,
    LOCAL_MODELS,
};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::voice_service::VoiceTranscribeResponse;

const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelStatus {
    pub id: &'static str,
    pub installed: bool,
    /// 首次下载量（含缺失的引擎包），字节
    pub download_size: u64,
    pub hotwords: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalVoiceStatus {
    pub supported: bool,
    pub engine_installed: bool,
    pub models: Vec<LocalModelStatus>,
    pub install: Option<install::InstallProgress>,
    pub directory: String,
}

pub fn root_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("voice-local")
}

fn engine_binary(root: &Path) -> Option<PathBuf> {
    install::engine_dir(root).map(|dir| dir.join(engine_binary_relative()))
}

pub fn status(root: &Path) -> LocalVoiceStatus {
    let engine = engine_archive();
    let engine_installed = engine_binary(root).is_some_and(|path| path.is_file());
    let engine_cost = if engine_installed {
        0
    } else {
        engine.map_or(0, |a| a.size)
    };
    LocalVoiceStatus {
        supported: engine.is_some(),
        engine_installed,
        models: LOCAL_MODELS
            .iter()
            .map(|model| {
                let installed = install::model_dir(root, model).is_dir();
                LocalModelStatus {
                    id: model.id,
                    installed,
                    download_size: if installed {
                        0
                    } else {
                        model.archive.size + engine_cost
                    },
                    hotwords: model.hotwords,
                }
            })
            .collect(),
        install: install::current_progress(),
        directory: root.display().to_string(),
    }
}

pub fn resolve_model(id: &str) -> AppResult<&'static LocalModel> {
    find_model(id).ok_or_else(|| format!("Unknown local model: {id}").into())
}

pub fn remove_model(root: &Path, model: &LocalModel) -> AppResult<()> {
    if install::current_progress().is_some_and(|p| p.active() && p.model_id == model.id) {
        return Err("The model is still downloading".into());
    }
    let dir = install::model_dir(root, model);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Windows 下别为子进程弹黑框。
pub(crate) fn hide_console_window(command: &mut tokio::process::Command) {
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    #[cfg(not(windows))]
    let _ = command;
}

pub async fn transcribe(
    root: &Path,
    settings: &VoiceSettings,
    wav: &[u8],
    language: Option<&str>,
    enable_itn: bool,
) -> AppResult<VoiceTranscribeResponse> {
    let model_id = if settings.local_model.is_empty() {
        DEFAULT_LOCAL_MODEL
    } else {
        settings.local_model.as_str()
    };
    let model = resolve_model(model_id)?;
    let binary = engine_binary(root)
        .filter(|path| path.is_file())
        .ok_or("The local speech engine is not downloaded yet")?;
    let model_dir = install::model_dir(root, model);
    if !model_dir.is_dir() {
        return Err("The local speech model is not downloaded yet".into());
    }
    let seconds =
        wav_duration_seconds(wav).ok_or("Local transcription needs 16-bit PCM WAV audio")?;

    let temp = tempfile::Builder::new()
        .prefix("cc-panes-voice-")
        .suffix(".wav")
        .tempfile()
        .map_err(|e| e.to_string())?;
    std::fs::write(temp.path(), wav).map_err(|e| e.to_string())?;

    let words: Vec<String> = settings.custom_words.clone();
    let mut command = tokio::process::Command::new(&binary);
    command
        .args(build_args(
            model.kind, &model_dir, language, enable_itn, &words, seconds,
        ))
        .arg(temp.path())
        .kill_on_drop(true);
    hide_console_window(&mut command);
    let output = tokio::time::timeout(TRANSCRIBE_TIMEOUT, command.output())
        .await
        .map_err(|_| "Local transcription timed out".to_string())?
        .map_err(|e| format!("Failed to start the local speech engine: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if let Some(mut response) = parse_output(&stdout).or_else(|| parse_output(&stderr)) {
        response.duration = Some(seconds);
        return Ok(response);
    }
    let detail = stderr
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("no output");
    Err(format!("Local transcription failed: {detail}").into())
}

fn threads() -> usize {
    std::thread::available_parallelism().map_or(2, |n| n.get().clamp(1, 4))
}

fn build_args(
    kind: ModelKind,
    dir: &Path,
    language: Option<&str>,
    enable_itn: bool,
    words: &[String],
    seconds: f64,
) -> Vec<String> {
    let path = |name: &str| dir.join(name).display().to_string();
    let mut args = vec![format!("--num-threads={}", threads())];
    match kind {
        ModelKind::SenseVoice => {
            // 只放行 SenseVoice 支持的语种，其余（含未指定）一律 auto。
            // 不能照 clippy::manual_unwrap_or 的建议写成 `language.unwrap_or("auto")`：
            // 那会把不支持的语种原样传给 sherpa-onnx。
            let language = language
                .filter(|code| matches!(*code, "zh" | "en" | "ja" | "ko" | "yue"))
                .unwrap_or("auto");
            args.extend([
                format!("--sense-voice-model={}", path("model.int8.onnx")),
                format!("--tokens={}", path("tokens.txt")),
                format!("--sense-voice-language={language}"),
                format!("--sense-voice-use-itn={}", u8::from(enable_itn)),
            ]);
        }
        ModelKind::Qwen3Asr => {
            // 默认 128 / 512 个 token 会把十几秒以上的录音截断成乱码，按时长放宽
            let new_tokens = 128 + (seconds * 12.0).ceil() as u64;
            let total = 512 + (seconds * 16.0).ceil() as u64 + new_tokens;
            args.extend([
                format!("--qwen3-asr-conv-frontend={}", path("conv_frontend.onnx")),
                format!("--qwen3-asr-encoder={}", path("encoder.int8.onnx")),
                format!("--qwen3-asr-decoder={}", path("decoder.int8.onnx")),
                format!("--qwen3-asr-tokenizer={}", path("tokenizer")),
                format!("--qwen3-asr-max-new-tokens={new_tokens}"),
                format!("--qwen3-asr-max-total-len={total}"),
            ]);
            let hotwords: Vec<String> = words
                .iter()
                .map(|word| word.replace(',', " ").trim().to_string())
                .filter(|word| !word.is_empty())
                .collect();
            if !hotwords.is_empty() {
                args.push(format!("--qwen3-asr-hotwords={}", hotwords.join(",")));
            }
        }
    }
    args
}

/// 16-bit PCM WAV 的时长（秒）；不是 WAV 时返回 None。
fn wav_duration_seconds(bytes: &[u8]) -> Option<f64> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut offset = 12;
    let mut byte_rate = None;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().ok()?) as usize;
        let body = offset + 8;
        if id == b"fmt " && body + 12 <= bytes.len() {
            byte_rate = Some(u32::from_le_bytes(
                bytes[body + 8..body + 12].try_into().ok()?,
            ));
        } else if id == b"data" {
            let rate = byte_rate.filter(|rate| *rate > 0)?;
            let len = size.min(bytes.len() - body);
            return Some(len as f64 / f64::from(rate));
        }
        offset = body + size + (size & 1);
    }
    None
}

/// sherpa-onnx-offline 每个文件打印一行 JSON：{"lang":"<|zh|>","emotion":"<|NEUTRAL|>","text":"…"}
fn parse_output(output: &str) -> Option<VoiceTranscribeResponse> {
    let value: Value = output
        .lines()
        .filter(|line| line.trim_start().starts_with('{'))
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .find(|value| value.get("text").is_some())?;
    let tag = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(|raw| {
                raw.trim_start_matches("<|")
                    .trim_end_matches("|>")
                    .to_string()
            })
            .filter(|raw| !raw.is_empty())
    };
    Some(VoiceTranscribeResponse {
        text: value.get("text")?.as_str()?.trim().to_string(),
        language: tag("lang"),
        emotion: tag("emotion").map(|emotion| emotion.to_lowercase()),
        duration: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(seconds: u32) -> Vec<u8> {
        let rate = 16_000u32;
        let data = rate * 2 * seconds;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&rate.to_le_bytes());
        bytes.extend_from_slice(&(rate * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data.to_le_bytes());
        bytes.resize(bytes.len() + data as usize, 0);
        bytes
    }

    #[test]
    fn reads_wav_duration() {
        assert_eq!(wav_duration_seconds(&wav(3)), Some(3.0));
        assert_eq!(
            wav_duration_seconds(b"not a wav file at all, definitely not one"),
            None
        );
    }

    #[test]
    fn parses_sense_voice_json_line() {
        let out = "Started\n{\"lang\": \"<|zh|>\", \"emotion\": \"<|NEUTRAL|>\", \"event\": \"<|Speech|>\", \"text\": \"开饭时间早上9点。\", \"tokens\":[]}\n";
        let response = parse_output(out).expect("parsed");
        assert_eq!(response.text, "开饭时间早上9点。");
        assert_eq!(response.language.as_deref(), Some("zh"));
        assert_eq!(response.emotion.as_deref(), Some("neutral"));
        assert!(parse_output("Errors in config!").is_none());
    }

    #[test]
    fn sense_voice_args_map_language_and_itn() {
        let args = build_args(
            ModelKind::SenseVoice,
            Path::new("/m"),
            Some("fr"),
            true,
            &[],
            3.0,
        );
        assert!(args.iter().any(|a| a == "--sense-voice-language=auto"));
        assert!(args.iter().any(|a| a == "--sense-voice-use-itn=1"));
        assert!(!args.iter().any(|a| a.starts_with("--qwen3")));
    }

    #[test]
    fn qwen3_args_scale_tokens_and_pass_hotwords() {
        let words = vec!["CC-Panes".to_string(), "a,b".to_string()];
        let args = build_args(
            ModelKind::Qwen3Asr,
            Path::new("/m"),
            Some("zh"),
            false,
            &words,
            50.0,
        );
        assert!(args
            .iter()
            .any(|a| a == "--qwen3-asr-hotwords=CC-Panes,a b"));
        let new_tokens: u64 = args
            .iter()
            .find_map(|a| a.strip_prefix("--qwen3-asr-max-new-tokens="))
            .and_then(|v| v.parse().ok())
            .expect("new tokens");
        assert!(new_tokens >= 600, "50s of speech needs room: {new_tokens}");
    }

    #[test]
    fn status_reports_missing_components() {
        let dir = tempfile::tempdir().expect("tempdir");
        let status = status(dir.path());
        assert_eq!(status.models.len(), LOCAL_MODELS.len());
        assert!(!status.engine_installed);
        if status.supported {
            assert!(status
                .models
                .iter()
                .all(|m| !m.installed && m.download_size > 0));
        }
    }
}

/// 真机冒烟：CC_VOICE_LOCAL_ROOT 指向已装好引擎与模型的目录，CC_VOICE_LOCAL_WAV 指向一段 WAV。
/// `cargo test --lib voice_local::smoke -- --ignored --nocapture`
#[cfg(test)]
mod smoke {
    #[tokio::test]
    #[ignore]
    async fn transcribes_with_installed_models() {
        let root = std::path::PathBuf::from(std::env::var("CC_VOICE_LOCAL_ROOT").expect("root"));
        let wav =
            std::fs::read(std::env::var("CC_VOICE_LOCAL_WAV").expect("wav")).expect("read wav");
        for model in ["sense-voice", "qwen3-asr"] {
            let settings = crate::models::settings::VoiceSettings {
                provider: "local".into(),
                local_model: model.into(),
                custom_words: vec!["CC-Panes".into()],
                ..Default::default()
            };
            let response = super::transcribe(&root, &settings, &wav, Some("zh"), true)
                .await
                .expect("transcribe");
            println!("{model}: {response:?}");
            assert!(!response.text.is_empty());
        }
    }

    /// 真下载：CC_VOICE_LOCAL_INSTALL_ROOT 为空目录，装 SenseVoice（约 180MB）。
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn installs_sense_voice_from_release() {
        let root =
            std::path::PathBuf::from(std::env::var("CC_VOICE_LOCAL_INSTALL_ROOT").expect("root"));
        let model = super::resolve_model("sense-voice").expect("model");
        super::install::start(root.clone(), model, reqwest::Client::new()).expect("start");
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let progress = super::install::current_progress().expect("progress");
            if !progress.active() {
                assert_eq!(progress.stage, "done", "{progress:?}");
                break;
            }
        }
        let status = super::status(&root);
        assert!(status.engine_installed);
        assert!(status
            .models
            .iter()
            .any(|m| m.id == "sense-voice" && m.installed));
        assert!(!root
            .join("downloads")
            .read_dir()
            .expect("downloads")
            .any(|_| true));
    }
}
