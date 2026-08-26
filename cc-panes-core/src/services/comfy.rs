//! ComfyUI API protocol helpers.
//!
//! ComfyUI deliberately keeps the inference graph in Python.  CC-Panes only
//! owns the boundary around that graph: validate API-format prompts, normalize
//! history outputs, and turn WebSocket messages into durable media events.

use crate::models::{MediaKind, MediaRunStatus};
use crate::utils::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};

const MAX_WORKFLOW_NODES: usize = 4096;
const MAX_NODE_ID_BYTES: usize = 128;
const MAX_CLASS_TYPE_BYTES: usize = 256;
const MAX_WORKFLOW_BYTES: usize = 16 * 1024 * 1024;

/// Version of the schema contract returned by ComfyUI's `/object_info`.
pub const COMFY_OBJECT_INFO_SCHEMA_VERSION: &str = "comfy-object-info-v1";

/// Version of the API-format workflow contract accepted by `/prompt`.
pub const COMFY_WORKFLOW_SCHEMA_VERSION: &str = "comfy-api-v1";

/// Cross-runtime response envelope for ComfyUI capability discovery.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComfyObjectInfoResponse {
    pub provider_id: String,
    pub schema_fingerprint: String,
    pub schema_version: String,
    pub schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<Value>,
}

/// One node in ComfyUI's API prompt format.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct ComfyPromptNode {
    pub class_type: String,
    #[serde(default)]
    pub inputs: Value,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// API-format prompt graph (`node_id -> { class_type, inputs }`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ComfyWorkflow {
    #[serde(flatten)]
    pub nodes: BTreeMap<String, ComfyPromptNode>,
}

impl ComfyWorkflow {
    /// Parse an API prompt. UI blueprints (`nodes`/`links` arrays) are rejected
    /// explicitly because ComfyUI's `/prompt` endpoint accepts a different
    /// representation.
    pub fn from_value(value: &Value) -> AppResult<Self> {
        let value = unwrap_prompt_wrapper(value);
        let object = value.as_object().ok_or_else(|| {
            AppError::coded(
                "COMFY_WORKFLOW_INVALID",
                "ComfyUI workflow must be an API-format JSON object",
            )
        })?;
        if object.contains_key("nodes") || object.contains_key("links") {
            return Err(AppError::coded(
                "COMFY_WORKFLOW_UI_FORMAT",
                "ComfyUI UI blueprint must be converted to API prompt format before submission",
            ));
        }
        let encoded = serde_json::to_vec(value).map_err(|_| {
            AppError::coded(
                "COMFY_WORKFLOW_INVALID",
                "ComfyUI workflow is not serializable",
            )
        })?;
        if encoded.len() > MAX_WORKFLOW_BYTES {
            return Err(AppError::coded(
                "COMFY_WORKFLOW_TOO_LARGE",
                "ComfyUI workflow exceeds the size limit",
            ));
        }
        if object.is_empty() || object.len() > MAX_WORKFLOW_NODES {
            return Err(AppError::coded(
                "COMFY_WORKFLOW_INVALID",
                "ComfyUI workflow must contain between one and 4096 nodes",
            ));
        }

        let mut nodes = BTreeMap::new();
        for (node_id, raw_node) in object {
            validate_node_id(node_id)?;
            let node_object = raw_node.as_object().ok_or_else(|| {
                AppError::coded(
                    "COMFY_NODE_INVALID",
                    "each ComfyUI prompt node must be an object",
                )
            })?;
            let class_type = node_object
                .get("class_type")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppError::coded(
                        "COMFY_NODE_TYPE_REQUIRED",
                        "each ComfyUI prompt node requires class_type",
                    )
                })?;
            if class_type.is_empty()
                || class_type.len() > MAX_CLASS_TYPE_BYTES
                || class_type.chars().any(char::is_control)
            {
                return Err(AppError::coded(
                    "COMFY_NODE_TYPE_INVALID",
                    "ComfyUI node class_type is invalid",
                ));
            }
            let inputs = node_object
                .get("inputs")
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()));
            if !inputs.is_object() {
                return Err(AppError::coded(
                    "COMFY_NODE_INPUTS_INVALID",
                    "ComfyUI node inputs must be a JSON object",
                ));
            }
            let mut extra = BTreeMap::new();
            for (key, child) in node_object {
                if key != "class_type" && key != "inputs" {
                    extra.insert(key.clone(), child.clone());
                }
            }
            nodes.insert(
                node_id.clone(),
                ComfyPromptNode {
                    class_type: class_type.to_string(),
                    inputs,
                    extra,
                },
            );
        }

        let workflow = Self { nodes };
        workflow.validate_links_and_cycles()?;
        Ok(workflow)
    }

    pub fn to_value(&self) -> Value {
        let mut object = Map::new();
        for (node_id, node) in &self.nodes {
            let mut node_object = Map::new();
            node_object.insert(
                "class_type".to_string(),
                Value::String(node.class_type.clone()),
            );
            node_object.insert("inputs".to_string(), node.inputs.clone());
            for (key, value) in &node.extra {
                node_object.insert(key.clone(), value.clone());
            }
            object.insert(node_id.clone(), Value::Object(node_object));
        }
        Value::Object(object)
    }

    /// Return a stable SHA-256 fingerprint for the API workflow. Object keys
    /// are sorted recursively, while array order remains significant.
    pub fn fingerprint(&self) -> AppResult<String> {
        json_fingerprint(&self.to_value())
    }

    pub fn validate_links_and_cycles(&self) -> AppResult<()> {
        let mut edges: HashMap<&str, Vec<&str>> = HashMap::new();
        for (node_id, node) in &self.nodes {
            let inputs = node.inputs.as_object().ok_or_else(|| {
                AppError::coded(
                    "COMFY_NODE_INPUTS_INVALID",
                    "ComfyUI node inputs must be an object",
                )
            })?;
            for value in inputs.values() {
                let Some(link) = value.as_array() else {
                    continue;
                };
                // API prompts use `[node_id, output_index]` for links, but
                // custom nodes may also use ordinary JSON arrays as inputs.
                // Only inspect the unambiguous two-item shape and leave other
                // arrays untouched.
                if link.len() != 2 {
                    continue;
                }
                let Some(output_index) = link[1].as_i64() else {
                    continue;
                };
                let source = match &link[0] {
                    Value::String(source) => Some(source.clone()),
                    Value::Number(source) => source.as_i64().and_then(|source| {
                        let candidate = source.to_string();
                        self.nodes.contains_key(&candidate).then_some(candidate)
                    }),
                    _ => None,
                };
                let Some(source) = source else {
                    continue;
                };
                if source.is_empty() || source.chars().any(char::is_control) {
                    return Err(AppError::coded(
                        "COMFY_LINK_INVALID",
                        "ComfyUI link source id is invalid",
                    ));
                }
                if output_index < 0 {
                    return Err(AppError::coded(
                        "COMFY_LINK_INVALID",
                        "ComfyUI output index cannot be negative",
                    ));
                }
                if !self.nodes.contains_key(&source) {
                    return Err(AppError::coded(
                        "COMFY_LINK_TARGET_MISSING",
                        format!("ComfyUI link references missing node {source}"),
                    ));
                }
                let source_id = self
                    .nodes
                    .get_key_value(&source)
                    .map(|(id, _)| id.as_str())
                    .expect("validated ComfyUI link source must exist");
                edges.entry(source_id).or_default().push(node_id);
            }
        }

        let mut visiting = BTreeSet::new();
        let mut visited = BTreeSet::new();
        for node_id in self.nodes.keys() {
            detect_cycle(node_id, &edges, &mut visiting, &mut visited)?;
        }
        Ok(())
    }

    pub fn output_nodes(&self) -> Vec<String> {
        self.nodes
            .iter()
            .filter_map(|(id, node)| {
                let class = node.class_type.to_ascii_lowercase();
                (class.starts_with("save") || class.contains("output") || class.contains("preview"))
                    .then(|| id.clone())
            })
            .collect()
    }
}

/// Canonicalize a JSON value for fingerprints shared by Rust and the web UI.
/// Object insertion order is not semantically meaningful in a ComfyUI
/// workflow, while array order is meaningful and remains unchanged.
pub fn canonical_json(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| (key.clone(), canonical_json(value)))
                .collect::<BTreeMap<_, _>>()
                .into_iter()
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(canonical_json).collect()),
        other => other.clone(),
    }
}

/// Compute a stable SHA-256 fingerprint for a JSON value.
pub fn json_fingerprint(value: &Value) -> AppResult<String> {
    let canonical = canonical_json(value);
    let encoded = serde_json::to_vec(&canonical).map_err(|_| {
        AppError::coded(
            "COMFY_FINGERPRINT_INVALID",
            "ComfyUI JSON value is not serializable",
        )
    })?;
    let mut digest = Sha256::new();
    digest.update(encoded);
    Ok(format!("{:x}", digest.finalize()))
}

fn unwrap_prompt_wrapper(value: &Value) -> &Value {
    let Some(object) = value.as_object() else {
        return value;
    };
    let Some(prompt) = object.get("prompt") else {
        return value;
    };
    let Some(prompt_object) = prompt.as_object() else {
        return value;
    };
    let looks_like_workflow = !prompt_object.is_empty()
        && prompt_object.values().all(|node| {
            node.as_object()
                .is_some_and(|node| node.get("class_type").and_then(Value::as_str).is_some())
        });
    if looks_like_workflow {
        prompt
    } else {
        value
    }
}

fn detect_cycle<'a>(
    node_id: &'a str,
    edges: &HashMap<&'a str, Vec<&'a str>>,
    visiting: &mut BTreeSet<&'a str>,
    visited: &mut BTreeSet<&'a str>,
) -> AppResult<()> {
    if visited.contains(node_id) {
        return Ok(());
    }
    if !visiting.insert(node_id) {
        return Err(AppError::coded(
            "COMFY_WORKFLOW_CYCLE",
            "ComfyUI workflow contains a dependency cycle",
        ));
    }
    if let Some(children) = edges.get(node_id) {
        for child in children {
            detect_cycle(child, edges, visiting, visited)?;
        }
    }
    visiting.remove(node_id);
    visited.insert(node_id);
    Ok(())
}

fn validate_node_id(value: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > MAX_NODE_ID_BYTES
        || value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
    {
        return Err(AppError::coded(
            "COMFY_NODE_ID_INVALID",
            "ComfyUI node id is invalid",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComfyPromptResponse {
    pub prompt_id: String,
    #[serde(default)]
    pub number: Option<f64>,
    #[serde(default)]
    pub node_errors: Value,
}

impl ComfyPromptResponse {
    pub fn parse(value: &Value) -> AppResult<Self> {
        let prompt_id = value
            .get("prompt_id")
            .or_else(|| value.get("promptId"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AppError::coded("COMFY_SUBMIT_INVALID", "ComfyUI response has no prompt_id")
            })?;
        if prompt_id.is_empty() || prompt_id.len() > 128 || prompt_id.chars().any(char::is_control)
        {
            return Err(AppError::coded(
                "COMFY_SUBMIT_INVALID",
                "ComfyUI prompt_id is invalid",
            ));
        }
        Ok(Self {
            prompt_id: prompt_id.to_string(),
            number: value.get("number").and_then(Value::as_f64),
            node_errors: value.get("node_errors").cloned().unwrap_or(Value::Null),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComfyOutputRef {
    pub node_id: String,
    pub filename: String,
    #[serde(default)]
    pub subfolder: String,
    #[serde(default = "default_output_type")]
    pub output_type: String,
    pub kind: MediaKind,
    #[serde(default)]
    pub metadata: Value,
}

fn default_output_type() -> String {
    "output".to_string()
}

impl ComfyOutputRef {
    pub fn view_query(&self) -> AppResult<String> {
        validate_relative_component(&self.filename, "filename")?;
        if !self.subfolder.is_empty() {
            validate_relative_component(&self.subfolder, "subfolder")?;
        }
        if !matches!(self.output_type.as_str(), "output" | "input" | "temp") {
            return Err(AppError::coded(
                "COMFY_OUTPUT_INVALID",
                "ComfyUI output type is invalid",
            ));
        }
        let mut query = format!("filename={}", urlencoding::encode(&self.filename));
        if !self.subfolder.is_empty() {
            query.push_str("&subfolder=");
            query.push_str(&urlencoding::encode(&self.subfolder));
        }
        query.push_str("&type=");
        query.push_str(self.output_type.as_str());
        Ok(query)
    }
}

fn validate_relative_component(value: &str, field: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > 512
        || value.starts_with('/')
        || value.starts_with('\\')
        || value.contains("..")
        || value.contains('\\')
        || value.chars().any(char::is_control)
    {
        return Err(AppError::coded(
            "COMFY_OUTPUT_INVALID",
            format!("ComfyUI {field} is unsafe"),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComfyHistoryResult {
    pub prompt_id: String,
    pub status: MediaRunStatus,
    #[serde(default)]
    pub outputs: Vec<ComfyOutputRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

impl ComfyHistoryResult {
    pub fn parse(value: &Value, prompt_id: &str, expected_kind: MediaKind) -> AppResult<Self> {
        let entry = value.get(prompt_id).unwrap_or(value);
        let object = entry.as_object().ok_or_else(|| {
            AppError::coded(
                "COMFY_HISTORY_INVALID",
                "ComfyUI history response is invalid",
            )
        })?;
        let status_object = object.get("status").and_then(Value::as_object);
        let status_text = status_object
            .and_then(|status| status.get("status_str"))
            .or_else(|| object.get("status"))
            .and_then(Value::as_str)
            .map(str::to_ascii_lowercase);
        let outputs = parse_history_outputs(object.get("outputs"), expected_kind)?;
        let error_message = status_object
            .and_then(|status| status.get("messages"))
            .and_then(Value::as_array)
            .and_then(|messages| {
                messages.iter().rev().find_map(|message| {
                    message
                        .as_array()
                        .and_then(|pair| pair.get(1))
                        .and_then(|data| {
                            data.get("exception_message")
                                .or_else(|| data.get("message"))
                        })
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
            })
            .or_else(|| {
                object
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
        let status = match status_text.as_deref() {
            Some("success") | Some("completed") | Some("complete") => MediaRunStatus::Succeeded,
            Some("error") | Some("execution_error") | Some("failed") => MediaRunStatus::Failed,
            Some("interrupted") | Some("execution_interrupted") | Some("canceled") => {
                MediaRunStatus::Canceled
            }
            _ if !outputs.is_empty() => MediaRunStatus::Succeeded,
            _ => MediaRunStatus::Processing,
        };
        Ok(Self {
            prompt_id: prompt_id.to_string(),
            status,
            outputs,
            error_message,
        })
    }
}

fn parse_history_outputs(
    value: Option<&Value>,
    expected_kind: MediaKind,
) -> AppResult<Vec<ComfyOutputRef>> {
    let Some(object) = value.and_then(Value::as_object) else {
        return Ok(Vec::new());
    };
    let mut outputs = Vec::new();
    for (node_id, node_output) in object {
        let Some(node_object) = node_output.as_object() else {
            continue;
        };
        for (output_name, values) in node_object {
            let Some(values) = values.as_array() else {
                continue;
            };
            for item in values {
                let Some(item) = item.as_object() else {
                    continue;
                };
                let Some(filename) = item.get("filename").and_then(Value::as_str) else {
                    continue;
                };
                let output_type = item
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("output")
                    .to_string();
                let kind = kind_for_output(
                    filename,
                    item.get("mime_type").and_then(Value::as_str),
                    expected_kind,
                );
                let mut metadata = item
                    .get("metadata")
                    .cloned()
                    .unwrap_or(Value::Object(Map::new()));
                if let Value::Object(metadata) = &mut metadata {
                    metadata.insert("outputName".to_string(), Value::String(output_name.clone()));
                }
                outputs.push(ComfyOutputRef {
                    node_id: node_id.clone(),
                    filename: filename.to_string(),
                    subfolder: item
                        .get("subfolder")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    output_type,
                    kind,
                    metadata,
                });
            }
        }
    }
    Ok(outputs)
}

fn kind_for_output(filename: &str, mime: Option<&str>, fallback: MediaKind) -> MediaKind {
    if mime.is_some_and(|value| value.to_ascii_lowercase().starts_with("video/")) {
        return MediaKind::Video;
    }
    match filename
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" | "webm" | "mov" | "mkv" | "avi" | "gif" => MediaKind::Video,
        _ => fallback,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ComfyEvent {
    Status {
        queue_remaining: Option<i64>,
    },
    ExecutionStart {
        prompt_id: String,
    },
    Executing {
        prompt_id: String,
        node: Option<String>,
        display_node: Option<String>,
    },
    Progress {
        prompt_id: Option<String>,
        node: Option<String>,
        value: f64,
        max: f64,
    },
    Executed {
        prompt_id: String,
        node: Option<String>,
        output: Value,
    },
    ExecutionCached {
        prompt_id: String,
        nodes: Vec<String>,
    },
    ExecutionError {
        prompt_id: String,
        node_id: Option<String>,
        message: Option<String>,
    },
    ExecutionSuccess {
        prompt_id: String,
    },
    ExecutionInterrupted {
        prompt_id: String,
    },
    ProgressState {
        prompt_id: String,
        nodes: Value,
    },
    Unknown {
        event_type: String,
        data: Value,
    },
}

impl ComfyEvent {
    pub fn parse(value: &Value) -> AppResult<Self> {
        let object = value.as_object().ok_or_else(|| {
            AppError::coded("COMFY_EVENT_INVALID", "ComfyUI event must be an object")
        })?;
        let event_type = object
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::coded("COMFY_EVENT_INVALID", "ComfyUI event has no type"))?;
        let data = object.get("data").cloned().unwrap_or(Value::Null);
        let data_object = data.as_object();
        let string = |name: &str| {
            data_object
                .and_then(|object| object.get(name))
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        let prompt_id = || string("prompt_id").unwrap_or_default();
        Ok(match event_type {
            "status" => ComfyEvent::Status {
                queue_remaining: data_object
                    .and_then(|object| object.get("status"))
                    .and_then(|status| status.get("exec_info"))
                    .and_then(|info| info.get("queue_remaining"))
                    .and_then(Value::as_i64),
            },
            "execution_start" => ComfyEvent::ExecutionStart {
                prompt_id: prompt_id(),
            },
            "executing" => ComfyEvent::Executing {
                prompt_id: prompt_id(),
                node: string("node"),
                display_node: string("display_node"),
            },
            "progress" => ComfyEvent::Progress {
                prompt_id: string("prompt_id"),
                node: string("node"),
                value: data_object
                    .and_then(|object| object.get("value"))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0),
                max: data_object
                    .and_then(|object| object.get("max"))
                    .and_then(Value::as_f64)
                    .unwrap_or(1.0),
            },
            "executed" => ComfyEvent::Executed {
                prompt_id: prompt_id(),
                node: string("node"),
                output: data_object
                    .and_then(|object| object.get("output"))
                    .cloned()
                    .unwrap_or(Value::Null),
            },
            "execution_cached" => ComfyEvent::ExecutionCached {
                prompt_id: prompt_id(),
                nodes: data_object
                    .and_then(|object| object.get("nodes"))
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(|value| value.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default(),
            },
            "execution_error" => ComfyEvent::ExecutionError {
                prompt_id: prompt_id(),
                node_id: string("node_id"),
                message: string("exception_message").or_else(|| string("message")),
            },
            "execution_success" => ComfyEvent::ExecutionSuccess {
                prompt_id: prompt_id(),
            },
            "execution_interrupted" => ComfyEvent::ExecutionInterrupted {
                prompt_id: prompt_id(),
            },
            "progress_state" => ComfyEvent::ProgressState {
                prompt_id: prompt_id(),
                nodes: data_object
                    .and_then(|object| object.get("nodes"))
                    .cloned()
                    .unwrap_or(Value::Null),
            },
            other => ComfyEvent::Unknown {
                event_type: other.to_string(),
                data,
            },
        })
    }

    pub fn progress_percent(&self) -> Option<i32> {
        match self {
            Self::Progress { value, max, .. } if *max > 0.0 => {
                Some((value / max * 100.0).round().clamp(0.0, 100.0) as i32)
            }
            Self::ExecutionSuccess { .. } => Some(100),
            Self::ProgressState { nodes, .. } => progress_state_percent(nodes),
            _ => None,
        }
    }

    pub fn prompt_id(&self) -> &str {
        match self {
            Self::ExecutionStart { prompt_id }
            | Self::Executing { prompt_id, .. }
            | Self::Executed { prompt_id, .. }
            | Self::ExecutionCached { prompt_id, .. }
            | Self::ExecutionError { prompt_id, .. }
            | Self::ExecutionSuccess { prompt_id }
            | Self::ExecutionInterrupted { prompt_id }
            | Self::ProgressState { prompt_id, .. } => prompt_id,
            Self::Progress { prompt_id, .. } => prompt_id.as_deref().unwrap_or_default(),
            Self::Status { .. } | Self::Unknown { .. } => "",
        }
    }
}

fn progress_state_percent(nodes: &Value) -> Option<i32> {
    let object = nodes.as_object()?;
    if object.is_empty() {
        return None;
    }
    let total = object.len() as f64;
    let completed = object
        .values()
        .filter(|value| {
            value
                .get("state")
                .and_then(Value::as_str)
                .is_some_and(|state| matches!(state, "finished" | "success" | "completed"))
                || value
                    .get("completed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
        })
        .count() as f64;
    Some((completed / total * 100.0).round().clamp(0.0, 100.0) as i32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_api_prompt_and_rejects_ui_blueprint() {
        let workflow = ComfyWorkflow::from_value(&json!({
            "1": { "class_type": "KSampler", "inputs": { "model": ["2", 0] } },
            "2": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "model.safetensors" } }
        })).unwrap();
        assert_eq!(workflow.nodes.len(), 2);
        assert!(ComfyWorkflow::from_value(&json!({"nodes": [], "links": []})).is_err());
    }

    #[test]
    fn unwraps_prompt_envelope_without_confusing_a_prompt_node() {
        let wrapped = ComfyWorkflow::from_value(&json!({
            "prompt": {
                "1": { "class_type": "SaveImage", "inputs": {} }
            },
            "client_id": "cc-panes"
        }))
        .unwrap();
        assert!(wrapped.nodes.contains_key("1"));

        let node_named_prompt = ComfyWorkflow::from_value(&json!({
            "prompt": { "class_type": "SaveImage", "inputs": {} }
        }))
        .unwrap();
        assert!(node_named_prompt.nodes.contains_key("prompt"));
    }

    #[test]
    fn preserves_regular_arrays_and_accepts_numeric_link_ids() {
        let workflow = ComfyWorkflow::from_value(&json!({
            "1": { "class_type": "Custom", "inputs": { "values": [1, 2, 3] } },
            "2": { "class_type": "Custom", "inputs": { "source": [1, 0] } }
        }))
        .unwrap();
        assert_eq!(workflow.nodes.len(), 2);
    }

    #[test]
    fn catches_missing_links_and_cycles() {
        assert!(ComfyWorkflow::from_value(&json!({
            "1": { "class_type": "A", "inputs": { "x": ["missing", 0] } }
        }))
        .is_err());
        assert!(ComfyWorkflow::from_value(&json!({
            "1": { "class_type": "A", "inputs": { "x": ["2", 0] } },
            "2": { "class_type": "B", "inputs": { "x": ["1", 0] } }
        }))
        .is_err());
    }

    #[test]
    fn event_progress_state_and_prompt_id_are_available_to_worker() {
        let event = ComfyEvent::parse(&json!({
            "type": "progress_state",
            "data": {
                "prompt_id": "p1",
                "nodes": {
                    "1": {"state": "finished"},
                    "2": {"state": "running"}
                }
            }
        }))
        .unwrap();
        assert_eq!(event.prompt_id(), "p1");
        assert_eq!(event.progress_percent(), Some(50));
    }

    #[test]
    fn parses_history_outputs_and_video_kind() {
        let history = ComfyHistoryResult::parse(&json!({
            "p1": {
                "status": {"status_str": "success"},
                "outputs": {"9": {"gifs": [{"filename": "clip.mp4", "subfolder": "renders", "type": "output"}]}}
            }
        }), "p1", MediaKind::Image).unwrap();
        assert_eq!(history.status, MediaRunStatus::Succeeded);
        assert_eq!(history.outputs[0].kind, MediaKind::Video);
        assert!(history.outputs[0]
            .view_query()
            .unwrap()
            .contains("clip.mp4"));
    }

    #[test]
    fn parses_progress_events() {
        let event = ComfyEvent::parse(
            &json!({"type":"progress","data":{"prompt_id":"p","node":"5","value":3,"max":10}}),
        )
        .unwrap();
        assert_eq!(event.progress_percent(), Some(30));
    }

    #[test]
    fn workflow_fingerprint_is_stable_across_object_key_order() {
        let first = ComfyWorkflow::from_value(&json!({
            "1": { "class_type": "Custom", "inputs": { "b": 2, "a": 1 } }
        }))
        .unwrap();
        let second = ComfyWorkflow::from_value(&json!({
            "1": { "inputs": { "a": 1, "b": 2 }, "class_type": "Custom" }
        }))
        .unwrap();
        assert_eq!(first.fingerprint().unwrap(), second.fingerprint().unwrap());
        assert_eq!(first.fingerprint().unwrap().len(), 64);
    }
}
