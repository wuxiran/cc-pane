//! 分层原生 CLI 配置：预览 / 片段校验 / 从外部来源补充原生配置。
use crate::models::launch_profile::LaunchProfileDraft;
use crate::services::ProviderService;
use crate::utils::AppResult;
use cc_panes_core::services::native_config::{
    preview_native_config, set_native_override_key, validate_fragment, NativeConfigIssue,
    NativeConfigPreview,
};
use cc_panes_core::services::ExternalProviderSource;
use std::sync::Arc;
use tauri::State;

/// 运行配置草稿（可未保存）+ CLI → 生效配置（每个键带来源层）、各运行位置是否生效、校验问题。
#[tauri::command]
pub fn preview_launch_profile_native_config(
    draft: LaunchProfileDraft,
    cli_tool: String,
    provider_service: State<'_, Arc<ProviderService>>,
) -> AppResult<NativeConfigPreview> {
    let tool = cli_tool.trim().to_ascii_lowercase();
    let providers = provider_service.list_providers();
    let default_provider_id = provider_service.get_default_provider_id(&tool);
    Ok(preview_native_config(
        &draft,
        &tool,
        &providers,
        default_provider_id.as_deref(),
    ))
}

/// 只校验一个片段（编辑时即时提示用）。空列表 = 可以保存。
#[tauri::command]
pub fn validate_native_config_fragment(
    cli_tool: String,
    text: String,
) -> AppResult<Vec<NativeConfigIssue>> {
    Ok(validate_fragment(
        &cli_tool.trim().to_ascii_lowercase(),
        &text,
    ))
}

/// 快捷开关：在片段原文里设置（`value` 非空）或删除（`value` 为空）一个点分键，返回新原文。
///
/// 只改文本、不落盘：前端拿结果写回草稿，随运行配置一起保存。片段本身有语法错误时报错，不覆盖原文。
#[tauri::command]
pub fn set_native_config_key(
    cli_tool: String,
    fragment: String,
    key: String,
    value: Option<serde_json::Value>,
) -> AppResult<String> {
    set_native_override_key(&cli_tool, &fragment, &key, value.as_ref())
}

/// 「补充原生配置」：只填已存在中转站里空着的片段与模型上下文窗口。返回改动的中转站数。
#[tauri::command]
pub async fn supplement_external_providers(
    service: State<'_, Arc<ProviderService>>,
    source: ExternalProviderSource,
    keys: Vec<String>,
) -> AppResult<usize> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.supplement_external_providers(source, &keys, None)
    })
    .await
    .map_err(|error| {
        crate::utils::AppError::from(format!("Provider supplement task failed: {error}"))
    })?
    .map_err(Into::into)
}
