// 语音转写服务：provider 分发与 HTTP 请求构造/解析。
// command 层（voice_commands.rs）只留薄壳：读设置 + enabled 校验。
use crate::models::settings::VoiceSettings;
use crate::utils::AppResult;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

const MAX_COMPATIBLE_AUDIO_PAYLOAD_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTranscribeRequest {
    pub audio_base64: String,
    pub mime_type: String,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub enable_itn: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTranscribeResponse {
    pub text: String,
    pub language: Option<String>,
    pub emotion: Option<String>,
    pub duration: Option<f64>,
}

enum VoiceProvider {
    Dashscope,
    Mimo,
    Custom,
}

impl VoiceProvider {
    fn from_settings(provider: &str) -> Self {
        match provider {
            "mimo" => Self::Mimo,
            "custom" => Self::Custom,
            _ => Self::Dashscope,
        }
    }
}

pub async fn transcribe(
    settings: &VoiceSettings,
    request: &VoiceTranscribeRequest,
) -> AppResult<VoiceTranscribeResponse> {
    match VoiceProvider::from_settings(&settings.provider) {
        VoiceProvider::Dashscope => transcribe_with_dashscope(settings, request).await,
        VoiceProvider::Mimo => transcribe_with_mimo(settings, request).await,
        VoiceProvider::Custom => transcribe_with_custom(settings, request).await,
    }
}

async fn transcribe_with_dashscope(
    settings: &VoiceSettings,
    request: &VoiceTranscribeRequest,
) -> AppResult<VoiceTranscribeResponse> {
    if settings.dashscope_api_key.trim().is_empty() {
        return Err("DashScope API key is not configured".into());
    }

    let body = build_dashscope_request(settings, request)?;
    let endpoint = dashscope_endpoint(&settings.region);
    let client = reqwest::Client::new();
    let response = client
        .post(endpoint)
        .bearer_auth(settings.dashscope_api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("Qwen-ASR request failed: {}", err))?;

    let status = response.status();
    let response_body = response
        .text()
        .await
        .map_err(|err| format!("Failed to read Qwen-ASR response: {}", err))?;
    if !status.is_success() {
        return Err(format!(
            "Qwen-ASR request failed: HTTP {} {}",
            status,
            extract_error_message(&response_body)
        )
        .into());
    }

    let value: Value = serde_json::from_str(&response_body)
        .map_err(|err| format!("Failed to parse Qwen-ASR response: {}", err))?;
    parse_transcribe_response(&value)
}

async fn transcribe_with_mimo(
    settings: &VoiceSettings,
    request: &VoiceTranscribeRequest,
) -> AppResult<VoiceTranscribeResponse> {
    if settings.mimo_api_key.trim().is_empty() {
        return Err("Xiaomi MiMo API key is not configured".into());
    }

    let body = build_mimo_request(settings, request)?;
    let endpoint = mimo_endpoint(&settings.mimo_base_url);
    let client = reqwest::Client::new();
    let response = client
        .post(endpoint)
        .header("api-key", settings.mimo_api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("Xiaomi MiMo request failed: {}", err))?;

    let status = response.status();
    let response_body = response
        .text()
        .await
        .map_err(|err| format!("Failed to read Xiaomi MiMo response: {}", err))?;
    if !status.is_success() {
        return Err(format!(
            "Xiaomi MiMo request failed: HTTP {} {}",
            status,
            extract_error_message(&response_body)
        )
        .into());
    }

    let value: Value = serde_json::from_str(&response_body)
        .map_err(|err| format!("Failed to parse Xiaomi MiMo response: {}", err))?;
    parse_transcribe_response(&value)
}

async fn transcribe_with_custom(
    settings: &VoiceSettings,
    request: &VoiceTranscribeRequest,
) -> AppResult<VoiceTranscribeResponse> {
    // apiKey 允许为空：本地 whisper.cpp server / faster-whisper 无鉴权
    let form = build_custom_form(settings, request)?;
    let endpoint = custom_endpoint(&settings.custom_base_url);
    let client = reqwest::Client::new();
    let mut builder = client.post(endpoint).multipart(form);
    let api_key = settings.custom_api_key.trim();
    if !api_key.is_empty() {
        builder = builder.bearer_auth(api_key);
    }
    let response = builder
        .send()
        .await
        .map_err(|err| format!("Voice transcription request failed: {}", err))?;

    let status = response.status();
    let response_body = response
        .text()
        .await
        .map_err(|err| format!("Failed to read voice transcription response: {}", err))?;
    if !status.is_success() {
        return Err(format!(
            "Voice transcription request failed: HTTP {} {}",
            status,
            extract_error_message(&response_body)
        )
        .into());
    }

    let value: Value = serde_json::from_str(&response_body)
        .map_err(|err| format!("Failed to parse voice transcription response: {}", err))?;
    parse_custom_response(&value)
}

fn custom_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/audio/transcriptions") {
        trimmed.to_string()
    } else {
        format!("{}/audio/transcriptions", trimmed)
    }
}

fn build_custom_form(
    settings: &VoiceSettings,
    request: &VoiceTranscribeRequest,
) -> AppResult<reqwest::multipart::Form> {
    let audio_base64 = normalize_audio_base64(&request.audio_base64)?;
    let mime_type = normalize_mime_type(&request.mime_type)?;
    let audio_bytes = validate_base64_audio(audio_base64)?;

    // OpenAI/Groq 按文件扩展名判格式，file_name 必须与实际 MIME 匹配；
    // "audio/webm;codecs=opus" 要取基础类型再映射
    let base_mime = mime_type.split(';').next().unwrap_or(mime_type).trim();
    let part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name(file_name_for_mime(base_mime))
        .mime_str(base_mime)
        .map_err(|err| format!("Invalid audio MIME type {}: {}", base_mime, err))?;

    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", settings.custom_model.trim().to_string())
        .text("response_format", "json");

    let language = request
        .language
        .as_ref()
        .or(settings.language.as_ref())
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    if let Some(language) = language {
        form = form.text("language", language.to_string());
    }
    Ok(form)
}

fn file_name_for_mime(base_mime: &str) -> &'static str {
    match base_mime {
        "audio/wav" | "audio/x-wav" | "audio/wave" => "audio.wav",
        "audio/mpeg" | "audio/mp3" => "audio.mp3",
        "audio/mp4" | "audio/m4a" | "audio/x-m4a" => "audio.mp4",
        "audio/ogg" => "audio.ogg",
        "audio/flac" => "audio.flac",
        _ => "audio.webm",
    }
}

fn parse_custom_response(value: &Value) -> AppResult<VoiceTranscribeResponse> {
    // 标准 json 格式为 {"text": ...}；verbose_json 同样带 text，另有 language/duration
    let text = value
        .get("text")
        .and_then(Value::as_str)
        .and_then(|text| non_empty_text(text.to_string()))
        .ok_or_else(|| "Voice provider returned an empty transcript".to_string())?;
    Ok(VoiceTranscribeResponse {
        text,
        language: value
            .get("language")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        emotion: None,
        duration: value.get("duration").and_then(Value::as_f64),
    })
}

fn dashscope_endpoint(region: &str) -> &'static str {
    match region {
        "intl" => "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
        _ => "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    }
}

fn mimo_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{}/chat/completions", trimmed)
    }
}

fn build_dashscope_request(
    settings: &VoiceSettings,
    request: &VoiceTranscribeRequest,
) -> AppResult<Value> {
    let audio_base64 = normalize_audio_base64(&request.audio_base64)?;
    let mime_type = normalize_mime_type(&request.mime_type)?;
    validate_base64_audio(audio_base64)?;

    let language = request
        .language
        .as_ref()
        .or(settings.language.as_ref())
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let enable_itn = request.enable_itn.unwrap_or(settings.enable_itn);

    let mut asr_options = Map::new();
    asr_options.insert("enable_itn".to_string(), Value::Bool(enable_itn));
    if let Some(language) = language {
        asr_options.insert("language".to_string(), Value::String(language.to_string()));
    }

    Ok(json!({
        "model": settings.model.trim(),
        "messages": [{
            "role": "user",
            "content": [{
                "type": "input_audio",
                "input_audio": {
                    "data": format!("data:{};base64,{}", mime_type, audio_base64)
                }
            }]
        }],
        "stream": false,
        "asr_options": Value::Object(asr_options)
    }))
}

fn build_mimo_request(
    settings: &VoiceSettings,
    request: &VoiceTranscribeRequest,
) -> AppResult<Value> {
    let audio_base64 = normalize_audio_base64(&request.audio_base64)?;
    let mime_type = normalize_mime_type(&request.mime_type)?;
    validate_base64_audio(audio_base64)?;

    let language = request
        .language
        .as_ref()
        .or(settings.language.as_ref())
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let prompt = mimo_transcribe_prompt(language);

    Ok(json!({
        "model": settings.mimo_model.trim(),
        "messages": [
            {
                "role": "system",
                "content": "You are a precise speech transcription engine. Return only the transcript text."
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_audio",
                        "input_audio": {
                            "data": format!("data:{};base64,{}", mime_type, audio_base64)
                        }
                    },
                    {
                        "type": "text",
                        "text": prompt
                    }
                ]
            }
        ],
        "stream": false,
        "max_completion_tokens": 2048
    }))
}

fn mimo_transcribe_prompt(language: Option<&str>) -> &'static str {
    match language {
        Some("zh") => "请把这段中文语音逐字转写成文本，只输出转写结果，不要解释。",
        Some("yue") => "请把这段粤语语音逐字转写成文本，只输出转写结果，不要解释。",
        Some("en") => "Transcribe this English audio exactly. Return only the transcript text.",
        Some("ja") => {
            "この日本語音声を正確に文字起こししてください。文字起こし結果のみを返してください。"
        }
        Some("ko") => "이 한국어 음성을 정확히 받아쓰기하세요. 받아쓰기 결과만 반환하세요.",
        _ => "请逐字转写这段音频，只输出转写文本，不要解释、不要总结。",
    }
}

fn normalize_audio_base64(input: &str) -> AppResult<&str> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Audio data is empty".into());
    }
    if let Some((_, data)) = trimmed.split_once(",") {
        if trimmed.starts_with("data:") {
            return Ok(data.trim());
        }
    }
    Ok(trimmed)
}

fn normalize_mime_type(input: &str) -> AppResult<&str> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Ok("audio/webm");
    }
    let base_type = trimmed.split(';').next().unwrap_or(trimmed);
    if !base_type.starts_with("audio/") {
        return Err(format!("Unsupported voice input MIME type: {}", trimmed).into());
    }
    Ok(trimmed)
}

/// 校验并解码音频 base64；custom 分支消费解码后的字节，JSON 分支丢弃返回值即可
fn validate_base64_audio(audio_base64: &str) -> AppResult<Vec<u8>> {
    if audio_base64.len() > MAX_COMPATIBLE_AUDIO_PAYLOAD_BYTES {
        return Err(format!(
            "Audio payload is too large: {} bytes, maximum is {} bytes",
            audio_base64.len(),
            MAX_COMPATIBLE_AUDIO_PAYLOAD_BYTES
        )
        .into());
    }
    STANDARD
        .decode(audio_base64)
        .map_err(|err| format!("Invalid audio base64 data: {}", err).into())
}

fn parse_transcribe_response(value: &Value) -> AppResult<VoiceTranscribeResponse> {
    let text = extract_transcript(value)
        .ok_or_else(|| "Voice provider returned an empty transcript".to_string())?;
    let audio_info = extract_audio_info(value);
    Ok(VoiceTranscribeResponse {
        text,
        language: audio_info.language,
        emotion: audio_info.emotion,
        duration: audio_info.duration,
    })
}

#[derive(Default)]
struct AudioInfo {
    language: Option<String>,
    emotion: Option<String>,
    duration: Option<f64>,
}

fn extract_transcript(value: &Value) -> Option<String> {
    let message = value.pointer("/choices/0/message")?;
    let text = message
        .get("content")
        .map(extract_content_text)
        .unwrap_or_default();
    if let Some(trimmed) = non_empty_text(text) {
        return Some(trimmed);
    }

    ["reasoning_content", "transcript", "text"]
        .iter()
        .find_map(|key| {
            message
                .get(*key)
                .and_then(Value::as_str)
                .and_then(|text| non_empty_text(text.to_string()))
        })
}

fn extract_content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(extract_text_fragment)
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn non_empty_text(text: String) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn extract_text_fragment(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    value
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| value.get("transcript").and_then(Value::as_str))
        .or_else(|| value.get("content").and_then(Value::as_str))
        .map(ToString::to_string)
}

fn extract_audio_info(value: &Value) -> AudioInfo {
    let Some(annotations) = value
        .pointer("/choices/0/message/annotations")
        .and_then(Value::as_array)
    else {
        return AudioInfo::default();
    };

    let selected = annotations
        .iter()
        .find(|item| item.get("type").and_then(Value::as_str) == Some("audio_info"))
        .or_else(|| annotations.first());
    let Some(selected) = selected else {
        return AudioInfo::default();
    };

    AudioInfo {
        language: selected
            .get("language")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        emotion: selected
            .get("emotion")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        duration: selected.get("duration").and_then(Value::as_f64),
    }
}

fn extract_error_message(body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        if let Some(message) = value.pointer("/error/message").and_then(Value::as_str) {
            return message.to_string();
        }
        if let Some(message) = value.get("message").and_then(Value::as_str) {
            return message.to_string();
        }
    }
    body.chars().take(500).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::settings::VoiceSettings;

    #[test]
    fn builds_dashscope_request_with_data_url() {
        let settings = VoiceSettings {
            enabled: true,
            dashscope_api_key: "sk-test".to_string(),
            region: "cn".to_string(),
            model: "qwen3-asr-flash".to_string(),
            language: Some("zh".to_string()),
            enable_itn: false,
            max_record_seconds: 60,
            ..VoiceSettings::default()
        };
        let request = VoiceTranscribeRequest {
            audio_base64: STANDARD.encode(b"audio"),
            mime_type: "audio/webm;codecs=opus".to_string(),
            language: None,
            enable_itn: Some(true),
        };

        let body = build_dashscope_request(&settings, &request).unwrap();

        assert_eq!(body["model"], "qwen3-asr-flash");
        assert_eq!(body["stream"], false);
        assert_eq!(body["asr_options"]["language"], "zh");
        assert_eq!(body["asr_options"]["enable_itn"], true);
        assert!(body["messages"][0]["content"][0]["input_audio"]["data"]
            .as_str()
            .unwrap()
            .starts_with("data:audio/webm;codecs=opus;base64,"));
    }

    #[test]
    fn builds_mimo_request_with_audio_and_prompt() {
        let settings = VoiceSettings {
            provider: "mimo".to_string(),
            enabled: true,
            mimo_api_key: "mimo-test".to_string(),
            mimo_model: "mimo-v2.5".to_string(),
            language: Some("en".to_string()),
            ..VoiceSettings::default()
        };
        let request = VoiceTranscribeRequest {
            audio_base64: STANDARD.encode(b"audio"),
            mime_type: "audio/wav".to_string(),
            language: None,
            enable_itn: None,
        };

        let body = build_mimo_request(&settings, &request).unwrap();

        assert_eq!(body["model"], "mimo-v2.5");
        assert_eq!(body["stream"], false);
        assert_eq!(body["max_completion_tokens"], 2048);
        assert_eq!(
            body["messages"][1]["content"][1]["text"],
            "Transcribe this English audio exactly. Return only the transcript text."
        );
        assert!(body["messages"][1]["content"][0]["input_audio"]["data"]
            .as_str()
            .unwrap()
            .starts_with("data:audio/wav;base64,"));
    }

    #[test]
    fn parses_string_content_response() {
        let response = json!({
            "choices": [{
                "message": {
                    "content": "你好 CC-Panes",
                    "annotations": [{ "type": "audio_info", "language": "zh", "emotion": "neutral" }]
                }
            }]
        });

        let parsed = parse_transcribe_response(&response).unwrap();

        assert_eq!(parsed.text, "你好 CC-Panes");
        assert_eq!(parsed.language.as_deref(), Some("zh"));
        assert_eq!(parsed.emotion.as_deref(), Some("neutral"));
    }

    #[test]
    fn parses_reasoning_content_response() {
        let response = json!({
            "choices": [{
                "message": {
                    "content": "",
                    "reasoning_content": "Good morning."
                }
            }]
        });

        let parsed = parse_transcribe_response(&response).unwrap();

        assert_eq!(parsed.text, "Good morning.");
    }

    #[test]
    fn parses_array_content_response() {
        let response = json!({
            "choices": [{
                "message": {
                    "content": [{ "type": "text", "text": "hello " }, { "text": "world" }]
                }
            }]
        });

        let parsed = parse_transcribe_response(&response).unwrap();

        assert_eq!(parsed.text, "hello world");
    }

    #[test]
    fn rejects_non_audio_mime_type() {
        let err = normalize_mime_type("video/webm").unwrap_err();
        assert!(err
            .to_string()
            .contains("Unsupported voice input MIME type"));
    }

    #[test]
    fn builds_custom_endpoint_variants() {
        assert_eq!(
            custom_endpoint("http://127.0.0.1:8080/v1"),
            "http://127.0.0.1:8080/v1/audio/transcriptions"
        );
        assert_eq!(
            custom_endpoint("http://127.0.0.1:8080/v1/"),
            "http://127.0.0.1:8080/v1/audio/transcriptions"
        );
        assert_eq!(
            custom_endpoint("https://api.groq.com/openai/v1/audio/transcriptions"),
            "https://api.groq.com/openai/v1/audio/transcriptions"
        );
    }

    #[test]
    fn builds_custom_form_with_empty_api_key() {
        let settings = VoiceSettings {
            provider: "custom".to_string(),
            enabled: true,
            custom_api_key: String::new(),
            custom_model: "whisper-1".to_string(),
            language: Some("zh".to_string()),
            ..VoiceSettings::default()
        };
        let request = VoiceTranscribeRequest {
            audio_base64: STANDARD.encode(b"audio"),
            mime_type: "audio/webm;codecs=opus".to_string(),
            language: None,
            enable_itn: None,
        };

        // 空 apiKey 不报错——multipart Form 不可内省，构造成功即视为通过
        build_custom_form(&settings, &request).unwrap();
    }

    #[test]
    fn maps_mime_to_file_name() {
        assert_eq!(file_name_for_mime("audio/webm"), "audio.webm");
        assert_eq!(file_name_for_mime("audio/wav"), "audio.wav");
        assert_eq!(file_name_for_mime("audio/mp4"), "audio.mp4");
        assert_eq!(file_name_for_mime("audio/ogg"), "audio.ogg");
        assert_eq!(file_name_for_mime("audio/mpeg"), "audio.mp3");
    }

    #[test]
    fn parses_custom_json_response() {
        let parsed = parse_custom_response(&json!({ "text": "hello whisper" })).unwrap();
        assert_eq!(parsed.text, "hello whisper");
        assert_eq!(parsed.language, None);
    }

    #[test]
    fn parses_custom_verbose_json_response() {
        let parsed = parse_custom_response(&json!({
            "task": "transcribe",
            "text": "你好",
            "language": "zh",
            "duration": 1.5
        }))
        .unwrap();
        assert_eq!(parsed.text, "你好");
        assert_eq!(parsed.language.as_deref(), Some("zh"));
        assert_eq!(parsed.duration, Some(1.5));
    }

    #[test]
    fn rejects_empty_custom_transcript() {
        let err = parse_custom_response(&json!({ "text": "  " })).unwrap_err();
        assert!(err.to_string().contains("empty transcript"));
    }

    #[test]
    fn rejects_oversized_encoded_audio_payload() {
        let audio_base64 = "a".repeat(MAX_COMPATIBLE_AUDIO_PAYLOAD_BYTES + 1);

        let err = validate_base64_audio(&audio_base64).unwrap_err();

        assert!(err.to_string().contains("Audio payload is too large"));
    }
}
