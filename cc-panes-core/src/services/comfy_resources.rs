//! Safe, versioned projections of ComfyUI runtime resource responses.

use crate::utils::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const COMFY_SYSTEM_STATS_SCHEMA_VERSION: &str = "comfy-system-stats-v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComfySystemStats {
    pub provider_id: String,
    pub schema_version: String,
    pub system: ComfySystemInfo,
    pub devices: Vec<ComfyDeviceInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ComfySystemInfo {
    pub os: Option<String>,
    pub ram_total: Option<u64>,
    pub ram_free: Option<u64>,
    pub comfyui_version: Option<String>,
    pub python_version: Option<String>,
    pub pytorch_version: Option<String>,
    pub embedded_python: Option<bool>,
    pub deploy_environment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ComfyDeviceInfo {
    pub name: Option<String>,
    pub device_type: Option<String>,
    pub index: Option<u32>,
    pub vram_total: Option<u64>,
    pub vram_free: Option<u64>,
    pub torch_vram_total: Option<u64>,
    pub torch_vram_free: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComfyMemoryReleaseResult {
    pub provider_id: String,
    pub unload_models: bool,
    pub free_memory: bool,
    pub accepted: bool,
}

impl ComfySystemStats {
    pub fn from_value(provider_id: impl Into<String>, value: &Value) -> AppResult<Self> {
        let root = value.as_object().ok_or_else(|| {
            AppError::coded(
                "COMFY_SYSTEM_STATS_INVALID",
                "ComfyUI system_stats response must be an object",
            )
        })?;
        let system = root
            .get("system")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                AppError::coded(
                    "COMFY_SYSTEM_STATS_INVALID",
                    "ComfyUI system_stats response has no system object",
                )
            })?;
        let devices = match root.get("devices") {
            None => Vec::new(),
            Some(Value::Array(values)) => {
                values.iter().map(parse_device).collect::<AppResult<_>>()?
            }
            Some(_) => {
                return Err(AppError::coded(
                    "COMFY_SYSTEM_STATS_INVALID",
                    "ComfyUI system_stats devices must be an array",
                ))
            }
        };
        Ok(Self {
            provider_id: provider_id.into(),
            schema_version: COMFY_SYSTEM_STATS_SCHEMA_VERSION.to_string(),
            system: ComfySystemInfo {
                os: safe_string(system.get("os")),
                ram_total: numeric(system.get("ram_total")),
                ram_free: numeric(system.get("ram_free")),
                comfyui_version: safe_string(system.get("comfyui_version")),
                python_version: safe_string(system.get("python_version")),
                pytorch_version: safe_string(system.get("pytorch_version")),
                embedded_python: system.get("embedded_python").and_then(Value::as_bool),
                deploy_environment: safe_string(system.get("deploy_environment")),
            },
            devices,
        })
    }
}

fn parse_device(value: &Value) -> AppResult<ComfyDeviceInfo> {
    let device = value.as_object().ok_or_else(|| {
        AppError::coded(
            "COMFY_SYSTEM_STATS_INVALID",
            "ComfyUI system_stats device must be an object",
        )
    })?;
    Ok(ComfyDeviceInfo {
        name: safe_string(device.get("name")),
        device_type: safe_string(device.get("type")),
        index: numeric(device.get("index")).and_then(|value| u32::try_from(value).ok()),
        vram_total: numeric(device.get("vram_total")),
        vram_free: numeric(device.get("vram_free")),
        torch_vram_total: numeric(device.get("torch_vram_total")),
        torch_vram_free: numeric(device.get("torch_vram_free")),
    })
}

fn numeric(value: Option<&Value>) -> Option<u64> {
    value.and_then(|value| match value {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => text.trim().parse::<u64>().ok(),
        _ => None,
    })
}

fn safe_string(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    if text.is_empty() || text.len() > 256 || text.chars().any(char::is_control) {
        return None;
    }
    Some(text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn projects_comfy_stats_without_forwarding_sensitive_argv() {
        let stats = ComfySystemStats::from_value(
            "provider-1",
            &json!({
                "system": {
                    "os": "Windows",
                    "ram_total": 16_000,
                    "ram_free": "8",
                    "comfyui_version": "0.3.0",
                    "python_version": "3.12",
                    "pytorch_version": "2.6",
                    "embedded_python": true,
                    "deploy_environment": "portable",
                    "argv": ["--listen", "secret"]
                },
                "devices": [{
                    "name": "NVIDIA Test",
                    "type": "cuda",
                    "index": 0,
                    "vram_total": 12_000,
                    "vram_free": 9_000,
                    "torch_vram_total": 11_000,
                    "torch_vram_free": 8_000
                }]
            }),
        )
        .unwrap();
        assert_eq!(stats.provider_id, "provider-1");
        assert_eq!(stats.schema_version, COMFY_SYSTEM_STATS_SCHEMA_VERSION);
        assert_eq!(stats.system.ram_free, Some(8));
        assert_eq!(stats.devices[0].vram_free, Some(9_000));
        assert!(!serde_json::to_string(&stats).unwrap().contains("argv"));
    }

    #[test]
    fn rejects_missing_system_or_invalid_devices() {
        let error = ComfySystemStats::from_value("provider", &json!({})).unwrap_err();
        assert_eq!(error.code(), Some("COMFY_SYSTEM_STATS_INVALID"));
        let error = ComfySystemStats::from_value("provider", &json!({"system": {}, "devices": {}}))
            .unwrap_err();
        assert_eq!(error.code(), Some("COMFY_SYSTEM_STATS_INVALID"));
        let error = ComfySystemStats::from_value(
            "provider",
            &json!({"system": {}, "devices": ["not-a-device"]}),
        )
        .unwrap_err();
        assert_eq!(error.code(), Some("COMFY_SYSTEM_STATS_INVALID"));
    }
}
