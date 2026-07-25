use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Number, Value};

use crate::api::{path_with_segment, ApiClient};
use crate::cli::CliExit;
use crate::discovery::{
    data_dir_candidates, discover_daemon_endpoint, discover_orchestrator_endpoint,
    DataDirCandidate, DataDirMode, DiscoveryError, IdentityConfidence, InstanceKind,
    ServiceEndpoint,
};
use crate::mcp::{McpClient, ToolDefinition};
use crate::offline_db::{self, OfflineCloseRequest, OfflineDbError};

const MAX_SUBMIT_BYTES: usize = 256 * 1024;

pub(crate) struct CommandContext {
    pub mode: DataDirMode,
    pub json: bool,
    pub launch_id: Option<String>,
}

pub(crate) fn status(context: &CommandContext) -> Result<(), CliExit> {
    let mut instances = Vec::new();
    for candidate in candidates(context)? {
        let orchestrator = lifecycle_value(discover_orchestrator_endpoint(&candidate.path));
        let daemon = lifecycle_value(discover_daemon_endpoint(&candidate.path));
        instances.push(json!({
            "instance": instance_label(&candidate),
            "dataDir": candidate.path,
            "orchestrator": orchestrator,
            "daemon": daemon,
        }));
    }
    let value = json!({ "instances": instances });
    if context.json {
        print_json(&value)?;
    } else {
        for instance in value["instances"].as_array().expect("array") {
            println!(
                "{}  orchestrator={}  daemon={}",
                instance["instance"].as_str().unwrap_or("custom"),
                instance["orchestrator"]["lifecycle"]
                    .as_str()
                    .unwrap_or("failed"),
                instance["daemon"]["lifecycle"].as_str().unwrap_or("failed")
            );
            for service in ["orchestrator", "daemon"] {
                if let Some(error) = instance[service]["error"].as_str() {
                    println!("  {service}: {error}");
                }
                if let Some(warning) = instance[service]["warning"].as_str() {
                    println!("  {service}: 警告 — {warning}");
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn sessions_list(context: &CommandContext) -> Result<(), CliExit> {
    let mut sessions = Vec::new();
    let mut failures = Vec::new();
    let mut source_count = 0;
    for candidate in candidates(context)? {
        let label = instance_label(&candidate);
        let orchestrator_attempt = discover_orchestrator_endpoint(&candidate.path)
            .map_err(|error| error.to_string())
            .and_then(|endpoint| {
                ApiClient::new(endpoint)
                    .get_json("/api/sessions")
                    .map_err(|error| error.to_string())
            });
        match orchestrator_attempt {
            Ok(value) => {
                sessions.extend(normalize_sessions(value, &label, "orchestrator")?);
                source_count += 1;
                continue;
            }
            Err(error) => failures.push(format!("{label}/orchestrator: {error}")),
        }
        match discover_daemon_endpoint(&candidate.path)
            .map_err(|error| error.to_string())
            .and_then(|endpoint| {
                ApiClient::new(endpoint)
                    .get_json("/api/sessions")
                    .map_err(|error| error.to_string())
            }) {
            Ok(value) => {
                sessions.extend(normalize_sessions(value, &label, "daemon")?);
                source_count += 1;
            }
            Err(error) => failures.push(format!("{label}/daemon: {error}")),
        }
    }
    if source_count == 0 {
        return Err(CliExit::source(format!(
            "sessions list 无可用源；已尝试 {}",
            failures.join("; ")
        )));
    }
    emit_session_table(context, &Value::Array(sessions))
}

pub(crate) fn sessions_read(
    context: &CommandContext,
    id: &str,
    lines: usize,
) -> Result<(), CliExit> {
    let endpoint = select_endpoint(context, "daemon", discover_daemon_endpoint)?;
    let mut path = path_with_segment(&["api", "sessions"], id, &["output"]);
    path.push_str(&format!("?lines={lines}"));
    let output = ApiClient::new(endpoint)
        .get_json(&path)
        .map_err(|error| CliExit::source(format!("daemon read 失败: {error}")))?;
    let value = json!({
        "output": output,
        "bestEffort": true,
        "note": "仅返回 daemon 内存尾部；活会话上限 20000 行/20MiB，死会话仅保留约 5 分钟，服务端不提供 truncated/availableLines 元数据"
    });
    if context.json {
        print_json(&value)
    } else {
        println!("注意: {}", value["note"].as_str().unwrap_or("尽力而为"));
        for line in value["output"]["lines"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            println!("{line}");
        }
        Ok(())
    }
}

pub(crate) fn sessions_submit(
    context: &CommandContext,
    id: &str,
    text: &str,
) -> Result<(), CliExit> {
    if text.len() > MAX_SUBMIT_BYTES {
        return Err(CliExit::argument(format!(
            "submit 输入 {} bytes，超过 ctl 限制 {MAX_SUBMIT_BYTES} bytes；daemon 不具备 orchestrator 的长 prompt 外置",
            text.len()
        )));
    }
    let endpoint = select_endpoint(context, "daemon", discover_daemon_endpoint)?;
    let path = path_with_segment(&["api", "sessions"], id, &["submit"]);
    ApiClient::new(endpoint)
        .post_json(&path, &json!({ "text": text }))
        .map_err(|error| CliExit::source(format!("daemon submit 失败: {error}")))?;
    emit_simple(
        context,
        json!({
            "success": true,
            "sessionId": id,
            "warning": "daemon submit 无 orchestrator 限流与长 prompt 外置，不宣称完全等价"
        }),
    )
}

pub(crate) fn sessions_write(
    context: &CommandContext,
    id: &str,
    data: &str,
) -> Result<(), CliExit> {
    let endpoint = select_endpoint(context, "daemon", discover_daemon_endpoint)?;
    let path = path_with_segment(&["api", "sessions"], id, &["write"]);
    ApiClient::new(endpoint)
        .post_json(&path, &json!({ "data": data }))
        .map_err(|error| CliExit::source(format!("daemon write 失败: {error}")))?;
    emit_simple(context, json!({ "success": true, "sessionId": id }))
}

pub(crate) fn sessions_kill(context: &CommandContext, id: &str) -> Result<(), CliExit> {
    let endpoint = select_endpoint(context, "daemon", discover_daemon_endpoint)?;
    let mut path = path_with_segment(&["api", "sessions"], id, &[]);
    path.push_str("?reason=explicit");
    ApiClient::new(endpoint)
        .delete_json(&path)
        .map_err(|error| CliExit::source(format!("daemon kill 失败: {error}")))?;
    emit_simple(context, json!({ "success": true, "sessionId": id }))
}

pub(crate) fn bindings_list(context: &CommandContext, stale: bool) -> Result<(), CliExit> {
    let orchestrators = discovered_endpoints(context, discover_orchestrator_endpoint);
    let (mut value, data_dir) = match orchestrators.0.len() {
        1 => {
            let endpoint = orchestrators.0.into_iter().next().expect("one");
            let data_dir = endpoint.data_dir.clone();
            let mut client = McpClient::new(endpoint, context.launch_id.clone());
            let value = mcp_text_json(
                client
                    .call_tool("query_task_bindings", json!({ "limit": 1000 }))
                    .map_err(|error| CliExit::source(format!("bindings MCP 查询失败: {error}")))?,
            )?;
            (add_source(value, "mcp", false), data_dir)
        }
        0 => {
            let path = select_db_path(context)?;
            let value = offline_db::list_bindings(&path).map_err(offline_error)?;
            let data_dir = path.parent().unwrap_or(Path::new(".")).to_path_buf();
            (value, data_dir)
        }
        _ => {
            return Err(CliExit::argument(
                "dev 与 release orchestrator 都在线，请为 bindings 显式指定 --dev 或 --release",
            ));
        }
    };
    if stale {
        let live = live_session_ids(&data_dir)?;
        let items = value
            .get_mut("items")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| CliExit::source("bindings 响应缺少 items"))?;
        items.retain(|binding| binding_is_stale(binding, &live));
        let total = items.len();
        value["total"] = json!(total);
        value["staleFilter"] = json!(true);
    }
    emit_binding_table(context, &value)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn bindings_close(
    context: &CommandContext,
    id: &str,
    status: &str,
    progress: i32,
    summary: Option<String>,
    exit_code: Option<i32>,
    force_offline_db: bool,
) -> Result<(), CliExit> {
    let orchestrators = discovered_endpoints(context, discover_orchestrator_endpoint).0;
    if orchestrators.len() > 1 {
        return Err(CliExit::argument(
            "dev 与 release orchestrator 都在线，请显式指定 --dev 或 --release",
        ));
    }
    if let Some(endpoint) = orchestrators.into_iter().next() {
        if force_offline_db {
            return Err(CliExit::argument(
                "orchestrator 在线时禁止 --force-offline-db；请走 TaskBindingService",
            ));
        }
        let mut client = McpClient::new(endpoint, context.launch_id.clone());
        let value = mcp_text_json(
            client
                .call_tool(
                    "update_task_binding",
                    json!({
                        "id": id,
                        "status": status,
                        "progress": progress,
                        "completionSummary": summary,
                        "exitCode": exit_code,
                    }),
                )
                .map_err(|error| CliExit::source(format!("bindings close MCP 失败: {error}")))?,
        )?;
        return emit_simple(context, add_source(value, "mcp", false));
    }
    if !force_offline_db {
        return Err(CliExit::source(
            "orchestrator 不可达，bindings 写默认禁止；等待恢复或显式使用 --force-offline-db 紧急逃生阀",
        ));
    }
    let path = select_db_path(context)?;
    let value = offline_db::close_binding(
        &path,
        &OfflineCloseRequest {
            id: id.to_string(),
            status: status.to_string(),
            progress,
            completion_summary: summary,
            exit_code,
        },
    )
    .map_err(offline_error)?;
    emit_simple(context, value)
}

pub(crate) fn bindings_reconcile(
    context: &CommandContext,
    leader_id: Option<&str>,
    plan_path: Option<&str>,
    verbose: bool,
    force_offline_db: bool,
) -> Result<(), CliExit> {
    let orchestrators = discovered_endpoints(context, discover_orchestrator_endpoint).0;
    if orchestrators.len() > 1 {
        return Err(CliExit::argument(
            "dev 与 release orchestrator 都在线，请显式指定实例",
        ));
    }
    if let Some(endpoint) = orchestrators.into_iter().next() {
        if force_offline_db {
            return Err(CliExit::argument(
                "orchestrator 在线时禁止 --force-offline-db",
            ));
        }
        let mut client = McpClient::new(endpoint, context.launch_id.clone());
        let value = mcp_text_json(
            client
                .call_tool(
                    "reconcile_plan_collaboration",
                    json!({
                        "leaderId": leader_id,
                        "planPath": plan_path,
                        "verbose": verbose,
                    }),
                )
                .map_err(|error| {
                    CliExit::source(format!("bindings reconcile MCP 失败: {error}"))
                })?,
        )?;
        return emit_simple(context, add_source(value, "mcp", false));
    }
    if !force_offline_db {
        return Err(CliExit::source(
            "orchestrator 不可达，完整 reconcile 默认禁止；可显式使用 --force-offline-db 做有限校准",
        ));
    }
    let path = select_db_path(context)?;
    let data_dir = path.parent().unwrap_or(Path::new("."));
    let live = live_session_ids(data_dir)?;
    let value = offline_db::reconcile_bindings(&path, leader_id, plan_path, &live)
        .map_err(offline_error)?;
    emit_simple(context, value)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn launch(
    context: &CommandContext,
    project: &str,
    prompt: Option<String>,
    resume: Option<String>,
    cli: Option<String>,
    runtime: Option<String>,
    title: Option<String>,
) -> Result<(), CliExit> {
    let endpoint = select_endpoint(context, "orchestrator", discover_orchestrator_endpoint)?;
    let value = ApiClient::new(endpoint)
        .post_json(
            "/api/launch-task",
            &json!({
                "projectPath": project,
                "prompt": prompt,
                "resumeId": resume,
                "cliTool": cli,
                "runtimeKind": runtime,
                "title": title,
            }),
        )
        .map_err(|error| {
            CliExit::source(format!(
                "launch 需要 orchestrator，且不提供 daemon 降级: {error}"
            ))
        })?;
    emit_simple(context, value)
}

pub(crate) fn tools(context: &CommandContext, schema: Option<&str>) -> Result<(), CliExit> {
    let endpoint = select_endpoint(context, "orchestrator", discover_orchestrator_endpoint)?;
    let mut client = McpClient::new(endpoint, context.launch_id.clone());
    let tools = client.list_tools().map_err(|error| {
        CliExit::source(format!(
            "tools/list 失败: {error}；可用 status/sessions 检查 daemon"
        ))
    })?;
    print_tools(&tools, schema, context.json)
}

pub(crate) fn call(
    context: &CommandContext,
    tool: &str,
    raw_json: Option<&str>,
    args: &[String],
) -> Result<(), CliExit> {
    let endpoint = select_endpoint(context, "orchestrator", discover_orchestrator_endpoint)?;
    let mut client = McpClient::new(endpoint, context.launch_id.clone());
    let tools = client
        .list_tools()
        .map_err(|error| CliExit::source(format!("tools/list 失败: {error}")))?;
    let definition = tools
        .iter()
        .find(|definition| definition.name == tool)
        .ok_or_else(|| CliExit::argument(format!("运行时 tools/list 中不存在工具 '{tool}'")))?;
    let arguments = parse_arguments(raw_json, args, definition)?;
    let result = client
        .call_tool(tool, arguments)
        .map_err(|error| CliExit::source(format!("tools/call 失败: {error}")))?;
    if context.json {
        print_json(&result)
    } else {
        print_content_blocks(&result)
    }
}

fn candidates(context: &CommandContext) -> Result<Vec<DataDirCandidate>, CliExit> {
    data_dir_candidates(&context.mode).map_err(|error| CliExit::argument(error.to_string()))
}

fn discovered_endpoints(
    context: &CommandContext,
    discover: fn(&Path) -> Result<ServiceEndpoint, DiscoveryError>,
) -> (Vec<ServiceEndpoint>, Vec<String>) {
    let mut endpoints = Vec::new();
    let mut failures = Vec::new();
    match candidates(context) {
        Ok(candidates) => {
            for candidate in candidates {
                match discover(&candidate.path) {
                    Ok(endpoint) => endpoints.push(endpoint),
                    Err(error) => failures.push(format!("{}: {error}", candidate.path.display())),
                }
            }
        }
        Err(error) => failures.push(error.message),
    }
    (endpoints, failures)
}

fn select_endpoint(
    context: &CommandContext,
    service: &str,
    discover: fn(&Path) -> Result<ServiceEndpoint, DiscoveryError>,
) -> Result<ServiceEndpoint, CliExit> {
    let (mut endpoints, failures) = discovered_endpoints(context, discover);
    match endpoints.len() {
        1 => Ok(endpoints.remove(0)),
        0 => Err(CliExit::source(format!(
            "{service} 不可达；已尝试 {}",
            failures.join("; ")
        ))),
        _ => Err(CliExit::argument(format!(
            "dev 与 release {service} 都在线，写操作必须显式指定 --dev 或 --release"
        ))),
    }
}

fn select_db_path(context: &CommandContext) -> Result<PathBuf, CliExit> {
    let paths = candidates(context)?
        .into_iter()
        .map(|candidate| candidate.path.join("data.db"))
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    match paths.len() {
        1 => Ok(paths.into_iter().next().expect("one")),
        0 => Err(CliExit::source("未找到可用 data.db")),
        _ => Err(CliExit::argument(
            "dev 与 release data.db 都存在，请显式指定 --dev 或 --release",
        )),
    }
}

fn lifecycle_value(result: Result<ServiceEndpoint, DiscoveryError>) -> Value {
    match result {
        Ok(endpoint) => {
            let legacy = endpoint.identity == IdentityConfidence::Legacy;
            json!({
                "lifecycle": "ready",
                "service": endpoint.kind.name(),
                "baseUrl": endpoint.base_url,
                "pid": endpoint.pid,
                "startedAt": endpoint.started_at,
                "identity": if legacy { "legacy" } else { "verified" },
                // 降级必须可见：旧版服务未上报身份字段，仅 token 认证通过。
                "warning": legacy.then(|| format!(
                    "{} 未上报身份字段（旧版二进制），仅 token 认证；重启该实例后可完整核对",
                    endpoint.kind.name()
                )),
            })
        }
        Err(error) => json!({ "lifecycle": "failed", "error": error.to_string() }),
    }
}

fn normalize_sessions(value: Value, instance: &str, source: &str) -> Result<Vec<Value>, CliExit> {
    let values = if source == "orchestrator" {
        value
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| CliExit::source("orchestrator sessions 响应缺少 sessions"))?
    } else {
        value
            .as_array()
            .cloned()
            .ok_or_else(|| CliExit::source("daemon sessions 响应不是数组"))?
    };
    Ok(values
        .into_iter()
        .map(|mut session| {
            session["instance"] = json!(instance);
            session["source"] = json!(source);
            session
        })
        .collect())
}

fn live_session_ids(data_dir: &Path) -> Result<HashSet<String>, CliExit> {
    let endpoint = discover_daemon_endpoint(data_dir)
        .map_err(|error| CliExit::source(format!("--stale/reconcile 需要 daemon: {error}")))?;
    let value = ApiClient::new(endpoint)
        .get_json("/api/sessions")
        .map_err(|error| CliExit::source(format!("读取 daemon 活会话失败: {error}")))?;
    let sessions = value
        .as_array()
        .ok_or_else(|| CliExit::source("daemon sessions 响应不是数组"))?;
    Ok(sessions
        .iter()
        .filter_map(|session| session.get("sessionId").and_then(Value::as_str))
        .map(str::to_string)
        .collect())
}

fn binding_is_stale(binding: &Value, live: &HashSet<String>) -> bool {
    let terminal = matches!(
        binding.get("status").and_then(Value::as_str),
        Some("completed" | "failed")
    );
    !terminal
        && binding
            .get("sessionId")
            .and_then(Value::as_str)
            .is_none_or(|session_id| !live.contains(session_id))
}

fn mcp_text_json(result: Value) -> Result<Value, CliExit> {
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        return Err(CliExit::source(format!("MCP tool error: {result}")));
    }
    let text = result
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .and_then(|block| block.get("text"))
        .and_then(Value::as_str)
        .ok_or_else(|| CliExit::source("MCP tool 响应缺少 text content"))?;
    if text.starts_with("错误:") {
        return Err(CliExit::source(text.to_string()));
    }
    serde_json::from_str(text).map_err(|error| {
        CliExit::source(format!("MCP tool text 不是预期 JSON: {error}; text={text}"))
    })
}

fn add_source(mut value: Value, source: &str, incomplete: bool) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.insert("source".to_string(), json!(source));
        object.insert("incomplete".to_string(), json!(incomplete));
    }
    value
}

fn instance_label(candidate: &DataDirCandidate) -> String {
    match candidate.kind {
        InstanceKind::Dev => "dev".to_string(),
        InstanceKind::Release => "release".to_string(),
        InstanceKind::Custom => candidate.path.display().to_string(),
    }
}

fn parse_arguments(
    raw_json: Option<&str>,
    args: &[String],
    tool: &ToolDefinition,
) -> Result<Value, CliExit> {
    if let Some(raw) = raw_json {
        let value: Value = serde_json::from_str(raw)
            .map_err(|error| CliExit::argument(format!("--json 不是有效 JSON: {error}")))?;
        return value
            .is_object()
            .then_some(value)
            .ok_or_else(|| CliExit::argument("--json 必须是 JSON object"));
    }
    let properties = tool
        .input_schema
        .get("properties")
        .and_then(Value::as_object);
    let mut result = Map::new();
    for raw in args {
        let (key, value) = raw
            .split_once('=')
            .ok_or_else(|| CliExit::argument(format!("--arg '{raw}' 缺少 '='")))?;
        if key.is_empty() {
            return Err(CliExit::argument("--arg 的 key 不能为空"));
        }
        let schema = properties.and_then(|properties| properties.get(key));
        result.insert(key.to_string(), convert_arg_value(value, schema)?);
    }
    Ok(Value::Object(result))
}

fn convert_arg_value(raw: &str, schema: Option<&Value>) -> Result<Value, CliExit> {
    let schema_type = schema
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("string");
    match schema_type {
        "string" => Ok(Value::String(raw.to_string())),
        "boolean" => raw
            .parse::<bool>()
            .map(Value::Bool)
            .map_err(|_| CliExit::argument(format!("'{raw}' 不是 boolean"))),
        "integer" => raw
            .parse::<i64>()
            .map(Number::from)
            .map(Value::Number)
            .map_err(|_| CliExit::argument(format!("'{raw}' 不是 integer"))),
        "number" => raw
            .parse::<f64>()
            .ok()
            .and_then(Number::from_f64)
            .map(Value::Number)
            .ok_or_else(|| CliExit::argument(format!("'{raw}' 不是有限 number"))),
        "object" | "array" => serde_json::from_str(raw)
            .map_err(|error| CliExit::argument(format!("'{raw}' 不是有效 {schema_type}: {error}"))),
        "null" if raw == "null" => Ok(Value::Null),
        other => Err(CliExit::argument(format!(
            "暂不支持 schema type '{other}'，请使用 call --json"
        ))),
    }
}

fn print_tools(
    tools: &[ToolDefinition],
    schema: Option<&str>,
    json_output: bool,
) -> Result<(), CliExit> {
    if let Some(name) = schema {
        let tool = tools
            .iter()
            .find(|tool| tool.name == name)
            .ok_or_else(|| CliExit::argument(format!("运行时不存在工具 '{name}'")))?;
        return print_json(&json!({
            "name": tool.name,
            "description": tool.description,
            "inputSchema": tool.input_schema,
        }));
    }
    if json_output {
        return print_json(&Value::Array(
            tools
                .iter()
                .map(|tool| {
                    json!({
                        "name": tool.name,
                        "description": tool.description,
                        "inputSchema": tool.input_schema,
                    })
                })
                .collect(),
        ));
    }
    for tool in tools {
        println!(
            "{:<36} {}",
            tool.name,
            tool.description
                .as_deref()
                .unwrap_or("")
                .lines()
                .next()
                .unwrap_or("")
        );
    }
    Ok(())
}

fn print_content_blocks(result: &Value) -> Result<(), CliExit> {
    if let Some(content) = result.get("content").and_then(Value::as_array) {
        for block in content {
            if block.get("type").and_then(Value::as_str) == Some("text") {
                println!(
                    "{}",
                    block.get("text").and_then(Value::as_str).unwrap_or("")
                );
            } else {
                print_json(block)?;
            }
        }
        Ok(())
    } else {
        print_json(result)
    }
}

fn emit_session_table(context: &CommandContext, value: &Value) -> Result<(), CliExit> {
    if context.json {
        return print_json(value);
    }
    println!(
        "{:<10} {:<13} {:<38} STATUS",
        "INSTANCE", "SOURCE", "SESSION"
    );
    for item in value.as_array().into_iter().flatten() {
        println!(
            "{:<10} {:<13} {:<38} {}",
            item["instance"].as_str().unwrap_or(""),
            item["source"].as_str().unwrap_or(""),
            item["sessionId"].as_str().unwrap_or(""),
            item["status"].as_str().unwrap_or("")
        );
    }
    Ok(())
}

fn emit_binding_table(context: &CommandContext, value: &Value) -> Result<(), CliExit> {
    if context.json {
        return print_json(value);
    }
    if let Some(warning) = value.get("warning").and_then(Value::as_str) {
        println!("注意: {warning}");
    }
    println!("{:<38} {:<10} {:<10} TITLE", "ID", "ROLE", "STATUS");
    for item in value["items"].as_array().into_iter().flatten() {
        println!(
            "{:<38} {:<10} {:<10} {}",
            item["id"].as_str().unwrap_or(""),
            item["role"].as_str().unwrap_or(""),
            item["status"].as_str().unwrap_or(""),
            item["title"].as_str().unwrap_or("")
        );
    }
    Ok(())
}

fn emit_simple(context: &CommandContext, value: Value) -> Result<(), CliExit> {
    if !context.json {
        if let Some(warning) = value.get("warning").and_then(Value::as_str) {
            println!("注意: {warning}");
        }
    }
    print_json(&value)
}

fn print_json(value: &Value) -> Result<(), CliExit> {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .map_err(|error| CliExit::source(format!("序列化输出失败: {error}")))?
    );
    Ok(())
}

fn offline_error(error: OfflineDbError) -> CliExit {
    match error {
        OfflineDbError::Conflict(message) => CliExit::conflict(message),
        OfflineDbError::Invalid(message) => CliExit::argument(message),
        OfflineDbError::Database(message) => CliExit::source(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_arg_values_follow_runtime_schema() {
        let tool = ToolDefinition {
            name: "demo".to_string(),
            description: None,
            input_schema: json!({
                "properties": {
                    "count": { "type": "integer" },
                    "enabled": { "type": "boolean" },
                    "label": { "type": "string" }
                }
            }),
        };
        let value = parse_arguments(
            None,
            &[
                "count=3".to_string(),
                "enabled=true".to_string(),
                "label=003".to_string(),
            ],
            &tool,
        )
        .unwrap();
        assert_eq!(value["count"], 3);
        assert_eq!(value["enabled"], true);
        assert_eq!(value["label"], "003");
    }

    #[test]
    fn stale_filter_ignores_terminal_bindings() {
        let live = HashSet::new();
        assert!(!binding_is_stale(
            &json!({ "status": "completed", "sessionId": "gone" }),
            &live
        ));
        assert!(binding_is_stale(
            &json!({ "status": "running", "sessionId": "gone" }),
            &live
        ));
    }

    #[test]
    fn offline_conflict_maps_to_exit_code_four() {
        let exit = offline_error(OfflineDbError::Conflict("changed".to_string()));
        assert_eq!(exit.code, 4);
    }
}
