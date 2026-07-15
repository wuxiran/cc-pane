//! 一键导入命令：解析 URL（供前端确认弹窗）+ 确认后执行落盘。

use crate::import::{parse_import_url as parse_url, ImportRequest, McpImport, ProviderImport};
use crate::services::{ProviderService, SkillMarketService};
use crate::utils::AppResult;
use cc_panes_core::models::provider::{Provider, ProviderType};
use cc_panes_core::services::SharedMcpService;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;
use tracing::debug;

/// 解析导入 URL（不落盘，供前端确认弹窗展示）。
#[tauri::command]
pub fn parse_import_url(url: String) -> AppResult<ImportRequest> {
    parse_url(&url).map_err(Into::into)
}

/// 前端挂载后领取冷启动时暂存的导入请求（覆盖「应用关着时点链接」的场景）。
#[tauri::command]
pub fn take_pending_import(
    pending: State<'_, crate::import::PendingImportStore>,
) -> AppResult<Option<ImportRequest>> {
    Ok(pending.take())
}

/// 执行导入（用户确认后调用）。返回一句人类可读的结果说明。
#[tauri::command]
pub async fn execute_import(
    request: ImportRequest,
    provider_service: State<'_, Arc<ProviderService>>,
    skill_market: State<'_, Arc<SkillMarketService>>,
    shared_mcp: State<'_, Arc<SharedMcpService>>,
) -> AppResult<String> {
    match request {
        ImportRequest::Provider(p) => import_provider(&provider_service, p),
        ImportRequest::Skill(s) => {
            let id =
                s.id.ok_or("暂只支持按市场 id 导入 skill（repo 克隆后续支持）")?;
            let installed = skill_market.install_market_skill(&id).await?;
            Ok(format!("已安装 skill：{}", installed.name))
        }
        ImportRequest::Mcp(m) => import_mcp(&shared_mcp, m),
    }
}

fn import_provider(service: &ProviderService, p: ProviderImport) -> AppResult<String> {
    let provider_type = match p.app.as_str() {
        "codex" => ProviderType::OpenAI,
        "gemini" => ProviderType::Gemini,
        "kimi" => ProviderType::Kimi,
        "glm" => ProviderType::Glm,
        "cursor" => ProviderType::Cursor,
        "opencode" => ProviderType::OpenCode,
        _ => ProviderType::Anthropic, // claude 及默认
    };
    let base_url = p.endpoints.first().cloned();
    let provider = Provider {
        id: format!("{}-{}", sanitize(&p.name), uuid::Uuid::new_v4().simple()),
        name: p.name.clone(),
        provider_type,
        api_key: p.api_key,
        base_url,
        region: None,
        project_id: None,
        aws_profile: None,
        config_dir: None,
        is_default: false,
    };
    // 原子去重 + 插入（同一把锁），避免并发导入堆重复项。
    service.add_provider_unique(provider)?;
    debug!(name = %p.name, "cmd::execute_import provider");
    Ok(format!("已导入 provider：{}", p.name))
}

fn import_mcp(service: &SharedMcpService, m: McpImport) -> AppResult<String> {
    let command = m
        .config
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let args: Vec<String> = m
        .config
        .get("args")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let env: HashMap<String, String> = m
        .config
        .get("env")
        .and_then(|v| v.as_object())
        .map(|o| {
            o.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();

    // 原子：同一把锁内校验重名 + 端口范围内找空位 + 插入（避免并发导入撞端口/覆盖）。
    let port = service.add_imported_server(&m.name, command, args, env)?;
    Ok(format!("已导入共享 MCP：{}（端口 {}）", m.name, port))
}

/// 生成 provider id 用的名字清洗：仅留字母数字与连字符。
fn sanitize(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = s.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "provider".to_string()
    } else {
        trimmed
    }
}
