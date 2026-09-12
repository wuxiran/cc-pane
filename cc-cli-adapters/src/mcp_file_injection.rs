//! 项目级 MCP 配置文件注入（docs/104）。
//!
//! omp / jcode 没有 per-launch 的 MCP 注入参数，唯一注入面是它们原生读取的
//! Claude 同形项目配置文件（`<项目>/.omp/mcp.json`、`<项目>/.jcode/mcp.json`，
//! 顶层 `{"mcpServers": {...}}`）。本模块把「本次启动的有效 MCP 集合」同步进
//! 该文件，契约：
//!
//! - **收据驱动的所有权**：只 upsert/移除 CC-Panes 自己写过的条目（收据在
//!   `<项目>/.ccpanes/.cache/mcp-injected-<cli>.json`，机器本地、永不进库）。
//!   用户自己的条目一律不碰；与 desired 同名时跳过并上报（foreign collision）。
//! - **幂等**：语义（解析后的 JSON 值）没变化就零写入，不刷 mtime、不产生 .bak。
//! - **原子写 + 备份**：目标文件已存在时先覆盖式备份 `<target>.bak`，再走
//!   [`crate::fs_atomic::write_atomic`]（temp + fsync + 重试 rename）。
//! - **gitignore 守卫**：ccpanes 条目 URL 带 token，注入文件绝不能进库。工具目录
//!   （`.omp/`、`.jcode/`）落一份守卫 `.gitignore`；用户已写过覆盖规则的不碰。
//! - **损坏即停**：目标文件解析失败时原样保留（warn 后 no-op），绝不覆盖用户数据。
//! - skip_mcp / 策略关闭 = 用空集合调 [`sync_project_mcp_file`] → 收据内条目全部
//!   移除。omp/jcode 实时读文件，残留 = 继续注入，必须清。
//!
//! 收据路径与 `.ccpanes/` 布局是跨 crate 契约，镜像 cc-panes-core 的
//! `utils/project_dirs.rs`（依赖方向 core → adapters，此处只能复制约定，两边
//! 改动必须同步）。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde_json::{json, Value};
use tracing::{info, warn};

use crate::CliAdapterContext;

/// ccpanes 内置编排器 MCP 的保留 server 名（与 claude.rs / codex.rs 一致）。
pub const CCPANES_SERVER_NAME: &str = "ccpanes";

/// 注入收据文件名（`.ccpanes/.cache/` 下），按 CLI 区分。
fn receipt_file_name(cli_id: &str) -> String {
    format!("mcp-injected-{cli_id}.json")
}

/// `<项目>/.ccpanes/.cache/mcp-injected-<cli>.json`
pub fn receipt_path(project_path: &Path, cli_id: &str) -> PathBuf {
    project_path
        .join(".ccpanes")
        .join(".cache")
        .join(receipt_file_name(cli_id))
}

/// 与 cc-panes-core `project_dirs.rs` 的 GITIGNORE_CONTENT 保持一致（跨 crate 契约）。
const CCPANES_DIR_GITIGNORE: &str =
    "# Written by CC-Panes: machine-local caches never belong in the repository.\n.cache/\n";

const GUARD_MARKER: &str = "Written by CC-Panes";

/// [`sync_project_mcp_file`] 的结果摘要，供调用方打日志/上报。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct McpFileSyncOutcome {
    /// 目标文件是否发生了实际写入。
    pub written: bool,
    /// 本次新增/更新的托管条目数。
    pub injected: usize,
    /// 本次移除的托管条目数（策略收缩 / skip_mcp）。
    pub removed: usize,
    /// desired 里与用户自有条目同名而被跳过的 server 名。
    pub foreign_collisions: Vec<String>,
}

/// 把 desired 集合同步进 `<project_path>/<target_rel...>`（Claude 同形 mcp.json）。
///
/// `target_rel` 形如 `&[".omp", "mcp.json"]`。desired 为空 + 无收据 + 目标不存在时
/// 完全 no-op（不凭空建文件）。任何用户数据都不覆盖：解析失败 no-op、同名外部
/// 条目跳过。
pub fn sync_project_mcp_file(
    cli_id: &str,
    project_path: &Path,
    target_rel: &[&str],
    desired: &BTreeMap<String, Value>,
) -> Result<McpFileSyncOutcome> {
    if project_path.as_os_str().is_empty() || target_rel.is_empty() {
        anyhow::bail!("mcp file injection requires a non-empty project path and target");
    }
    let target = target_rel
        .iter()
        .fold(project_path.to_path_buf(), |acc, part| acc.join(part));
    let receipt = receipt_path(project_path, cli_id);
    let owned = read_receipt(&receipt);

    let original_text = if target.exists() {
        Some(
            fs::read_to_string(&target)
                .with_context(|| format!("failed to read {}", target.display()))?,
        )
    } else {
        None
    };

    let parsed_original: Option<Value> = match original_text.as_deref() {
        None => None,
        Some(text) => match serde_json::from_str::<Value>(text) {
            Ok(value @ Value::Object(_)) => Some(value),
            Ok(_) => {
                warn!(
                    target = %target.display(),
                    "{cli_id}: MCP config root is not a JSON object, leaving it untouched"
                );
                return Ok(McpFileSyncOutcome::default());
            }
            Err(error) => {
                warn!(
                    target = %target.display(),
                    %error,
                    "{cli_id}: MCP config is not valid JSON, leaving it untouched"
                );
                return Ok(McpFileSyncOutcome::default());
            }
        },
    };

    let mut doc = parsed_original.clone().unwrap_or_else(|| json!({}));
    if parsed_original.is_none() && desired.is_empty() && owned.is_empty() {
        // nothing to inject and nothing stale to remove: never create a stray file
        return Ok(McpFileSyncOutcome::default());
    }

    let outcome = apply_desired(&mut doc, desired, &owned);

    let servers_empty = doc
        .get("mcpServers")
        .and_then(Value::as_object)
        .is_some_and(|map| map.is_empty());
    if parsed_original.is_none() && servers_empty {
        // Target never existed and there is nothing to write; only drop a stale receipt.
        if !owned.is_empty() {
            write_receipt(&receipt, &BTreeSet::new(), project_path)?;
        }
        return Ok(outcome);
    }

    let next_owned = owned_names_after_sync(&owned, desired, &outcome.foreign_collisions);
    let semantically_unchanged = parsed_original.as_ref() == Some(&doc);
    let receipt_changed = next_owned != owned;
    if semantically_unchanged && !receipt_changed {
        return Ok(outcome);
    }

    if original_text.is_some() {
        let backup = target.with_extension("json.bak");
        if let Err(error) = fs::copy(&target, &backup) {
            warn!(
                backup = %backup.display(),
                %error,
                "{cli_id}: failed to back up MCP config before rewrite (continuing)"
            );
        }
    }
    if let Some(tool_dir) = target.parent() {
        ensure_tool_dir_guard(cli_id, tool_dir);
    }
    let mut serialized = serde_json::to_string_pretty(&doc)
        .with_context(|| format!("failed to serialize {}", target.display()))?;
    serialized.push('\n');
    crate::fs_atomic::write_atomic(&target, serialized)
        .with_context(|| format!("failed to write {}", target.display()))?;
    write_receipt(&receipt, &next_owned, project_path)?;

    info!(
        target = %target.display(),
        injected = outcome.injected,
        removed = outcome.removed,
        collisions = ?outcome.foreign_collisions,
        "{cli_id}: project MCP config synced"
    );
    Ok(McpFileSyncOutcome {
        written: true,
        ..outcome
    })
}

/// 收据 ∩ desired = 保留；收据 − desired = 移除；desired − 收据 − 已存在 = 新增。
fn owned_names_after_sync(
    owned: &BTreeSet<String>,
    desired: &BTreeMap<String, Value>,
    foreign_collisions: &[String],
) -> BTreeSet<String> {
    let mut next = BTreeSet::new();
    for name in owned {
        if desired.contains_key(name) {
            next.insert(name.clone());
        }
    }
    for name in desired.keys() {
        if !foreign_collisions.contains(name) {
            next.insert(name.clone());
        }
    }
    next
}

fn apply_desired(
    doc: &mut Value,
    desired: &BTreeMap<String, Value>,
    owned: &BTreeSet<String>,
) -> McpFileSyncOutcome {
    let mut outcome = McpFileSyncOutcome::default();
    let root = doc.as_object_mut().expect("doc root checked by caller");
    let servers = root
        .entry("mcpServers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .expect("mcpServers replaced with object when malformed below");

    // 1) 收据内条目：desired 里还有 → upsert；没了 → 移除。
    for name in owned {
        match desired.get(name) {
            Some(value) => {
                if servers.get(name) != Some(value) {
                    outcome.injected += 1;
                }
                servers.insert(name.clone(), value.clone());
            }
            None => {
                if servers.remove(name).is_some() {
                    outcome.removed += 1;
                }
            }
        }
    }
    // 2) desired 新条目：与用户自有条目同名 → 跳过并上报。
    for (name, value) in desired {
        if owned.contains(name) {
            continue;
        }
        if servers.contains_key(name) {
            warn!(
                server = %name,
                "mcp file injection: server name collides with a user-owned entry, leaving it untouched"
            );
            outcome.foreign_collisions.push(name.clone());
            continue;
        }
        servers.insert(name.clone(), value.clone());
        outcome.injected += 1;
    }
    outcome
}

fn read_receipt(path: &Path) -> BTreeSet<String> {
    let Ok(text) = fs::read_to_string(path) else {
        return BTreeSet::new();
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(value) => value
            .get("servers")
            .and_then(Value::as_array)
            .map(|names| {
                names
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        Err(error) => {
            // 收据损坏 → 视为空：目标文件里的既有条目全部按用户所有处理（保守，
            // 宁可不更新自己写过的条目，也绝不覆盖可能是用户的数据）。
            warn!(
                receipt = %path.display(),
                %error,
                "mcp file injection: receipt is corrupt, treating all existing entries as user-owned"
            );
            BTreeSet::new()
        }
    }
}

fn write_receipt(path: &Path, names: &BTreeSet<String>, project_path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    // `.ccpanes/.gitignore` 守卫（与 core 的 ensure_ccpanes_dir 同款，不覆盖已有文件）
    let ccpanes_gitignore = project_path.join(".ccpanes").join(".gitignore");
    if !ccpanes_gitignore.exists() {
        if let Err(error) = fs::write(&ccpanes_gitignore, CCPANES_DIR_GITIGNORE) {
            warn!(%error, "mcp file injection: failed to write .ccpanes/.gitignore guard");
        }
    }
    let body = json!({ "servers": names.iter().cloned().collect::<Vec<_>>() });
    crate::fs_atomic::write_atomic(path, serde_json::to_string_pretty(&body)?)
        .with_context(|| format!("failed to write receipt {}", path.display()))?;
    Ok(())
}

/// 工具目录（`.omp/`、`.jcode/`）的 gitignore 守卫：注入文件可能含 token，
/// 绝不能被提交。已有守卫标记或用户自己写过 `mcp.json` 规则的不碰；
/// 否则追加（保留用户内容）。best-effort：失败只 warn。
fn ensure_tool_dir_guard(cli_id: &str, tool_dir: &Path) {
    let guard = tool_dir.join(".gitignore");
    const GUARD_BODY: &str =
        "# Written by CC-Panes: the injected MCP config may contain tokens.\nmcp.json\nmcp.json.bak\n";
    match fs::read_to_string(&guard) {
        Ok(existing) => {
            if existing.contains(GUARD_MARKER) || existing.lines().any(ignores_mcp_json) {
                return;
            }
            let mut merged = existing;
            if !merged.ends_with('\n') {
                merged.push('\n');
            }
            merged.push('\n');
            merged.push_str(GUARD_BODY);
            if let Err(error) = fs::write(&guard, merged) {
                warn!(%error, "{cli_id}: failed to extend {} with the token guard", guard.display());
            }
        }
        Err(_) => {
            if guard.exists() {
                return; // 读不出来的既有文件不碰
            }
            // 工具目录可能还不存在（write_atomic 稍后才建），守卫先确保目录
            if let Err(error) = fs::create_dir_all(tool_dir) {
                warn!(%error, "{cli_id}: failed to create {}", tool_dir.display());
                return;
            }
            if let Err(error) = fs::write(&guard, GUARD_BODY) {
                warn!(%error, "{cli_id}: failed to write {}", guard.display());
            }
        }
    }
}

fn ignores_mcp_json(line: &str) -> bool {
    let trimmed = line.trim().trim_start_matches('!').trim_start_matches('/');
    trimmed == "mcp.json"
        || trimmed == "mcp.json.bak"
        || trimmed.starts_with("mcp.json*")
        || trimmed == ".omp/"
        || trimmed == ".jcode/"
        || trimmed.ends_with("/.omp/")
        || trimmed.ends_with("/.jcode/")
        || trimmed == "*"
        || trimmed == ".*"
}

// ---------------------------------------------------------------------------
// desired 集合构建（适配器共享）
// ---------------------------------------------------------------------------

/// 适配器统一入口：收集本次启动的有效集合，best-effort 同步进项目级配置文件。
/// 任何失败只 warn 不阻断启动（MCP 缺失不致命，与 grok 模块同语义）；
/// 跳过名单与隔离降级都在这里统一上报。
pub fn sync_adapter_project_mcp(
    cli_id: &str,
    target_rel: &[&str],
    ctx: &CliAdapterContext,
    options: &CollectOptions,
) {
    let project_path = Path::new(ctx.project_path.trim());
    if project_path.as_os_str().is_empty() {
        return;
    }
    let collected = collect_mcp_servers(ctx, options);
    for name in collected
        .skipped_http_layer_entries
        .iter()
        .chain(&collected.skipped_shared_without_stdio)
    {
        warn!(
            cli_id,
            server = %name,
            "mcp file injection: server needs a transport this CLI cannot consume, skipped"
        );
    }
    if !collected.skipped_invalid_names.is_empty() {
        warn!(
            cli_id,
            servers = ?collected.skipped_invalid_names,
            "mcp file injection: invalid server names skipped"
        );
    }
    if ctx.disable_unlisted_mcp_servers {
        warn!(
            cli_id,
            "{cli_id}: MCP isolation requested but this CLI has no per-launch disable channel; \
             user-configured MCP servers are left untouched"
        );
    }
    match sync_project_mcp_file(cli_id, project_path, target_rel, &collected.servers) {
        Ok(outcome) if outcome.written => info!(
            cli_id,
            injected = outcome.injected,
            removed = outcome.removed,
            collisions = ?outcome.foreign_collisions,
            "mcp file injection: project config synced"
        ),
        Ok(_) => {}
        Err(error) => warn!(
            cli_id,
            %error,
            "mcp file injection: failed to sync project MCP config (continuing without injection)"
        ),
    }
}

/// [`collect_mcp_servers`] 的选项。
pub struct CollectOptions {
    /// jcode 只认 stdio：http/sse 层条目跳过、共享服务器改取原始 stdio 定义。
    pub stdio_only: bool,
    /// ccpanes 内置编排器条目（最高优先级）。None = 本次不注入（orchestrator
    /// 未就绪 / jcode 缺 ctl 代理 / stdio-only 下无 http 通道）。
    pub ccpanes_entry: Option<Value>,
}

/// 收集结果 + 因传输类型被跳过的名单（供调用方 warn/上报 UI）。
#[derive(Debug, Default)]
pub struct CollectedMcpServers {
    /// 合并优先级（低 → 高）：工作空间/项目层 < 共享 MCP < ccpanes，与 claude.rs
    /// 的 per-session 合并顺序一致。
    pub servers: BTreeMap<String, Value>,
    /// stdio_only 下被跳过的 http/sse 层条目。
    pub skipped_http_layer_entries: Vec<String>,
    /// stdio_only 下缺少原始 stdio 定义的共享服务器（HTTP 原生型无 stdio 源）。
    pub skipped_shared_without_stdio: Vec<String>,
    /// 名字不符合 CLI 通用 server 名约束而被丢弃的条目。
    pub skipped_invalid_names: Vec<String>,
}

/// 从 ctx 汇总本次启动应注入的 MCP 集合。skip_mcp 时返回空集合（调用方随后用
/// 空集合 sync 即可清掉历史注入）。名字统一按 `^[a-zA-Z0-9_.-]{1,100}$` 过滤
/// （omp 的 schema 约束，同时也是 Claude 的事实约束）。
pub fn collect_mcp_servers(
    ctx: &CliAdapterContext,
    options: &CollectOptions,
) -> CollectedMcpServers {
    let mut collected = CollectedMcpServers::default();
    if ctx.skip_mcp {
        return collected;
    }

    // 1) 工作空间层 + 项目覆盖层（策略过滤后）
    for (name, value) in ctx.allowed_workspace_mcp_servers() {
        if options.stdio_only && !is_stdio_entry(value) {
            collected.skipped_http_layer_entries.push(name.clone());
            continue;
        }
        if !is_valid_server_name(name) {
            warn!(server = %name, "mcp file injection: invalid server name, skipping");
            collected.skipped_invalid_names.push(name.clone());
            continue;
        }
        if name == CCPANES_SERVER_NAME {
            continue;
        }
        collected.servers.insert(name.clone(), value.clone());
    }

    // 2) 共享 MCP（stdio_only → 原始 stdio 定义；否则 HTTP 桥 URL）
    if options.stdio_only {
        for name in ctx.shared_mcp_urls.keys() {
            match ctx.shared_mcp_stdio.get(name) {
                Some(spec) if is_valid_server_name(name) => {
                    if name != CCPANES_SERVER_NAME {
                        collected.servers.insert(name.clone(), spec.clone());
                    }
                }
                Some(_) => {
                    collected.skipped_invalid_names.push(name.clone());
                }
                None => {
                    warn!(
                        server = %name,
                        "mcp file injection: shared server has no stdio spec, skipping for stdio-only CLI"
                    );
                    collected.skipped_shared_without_stdio.push(name.clone());
                }
            }
        }
    } else {
        for (name, url) in &ctx.shared_mcp_urls {
            if name == CCPANES_SERVER_NAME {
                continue;
            }
            if !is_valid_server_name(name) {
                collected.skipped_invalid_names.push(name.clone());
                continue;
            }
            collected
                .servers
                .insert(name.clone(), http_server_entry(url, None));
        }
    }

    // 3) ccpanes 内置（最高优先级）
    if let Some(entry) = options.ccpanes_entry.clone() {
        collected
            .servers
            .insert(CCPANES_SERVER_NAME.to_string(), entry);
    }

    collected
}

/// `{type:"http", url, headers?}` 条目（omp / pi 扩展桥原生支持 http）。
pub fn http_server_entry(url: &str, authorization: Option<&str>) -> Value {
    let mut entry = json!({ "type": "http", "url": url });
    if let Some(token_header) = authorization {
        entry["headers"] = json!({ "Authorization": token_header });
    }
    entry
}

/// ccpanes 编排器的 HTTP 条目。**不附 `&launchId=`**：项目级文件被同项目所有
/// 会话共享，附上只会让最后一次启动的 launchId 冒充所有会话的 caller 身份
/// （与 grok 模块头同一降级判断）。
pub fn ccpanes_http_entry(port: u16, token: &str) -> Value {
    http_server_entry(
        &format!("http://127.0.0.1:{port}/mcp?token={token}"),
        Some(&format!("Bearer {token}")),
    )
}

/// `{command, args, env}` stdio 条目。
pub fn stdio_server_entry(command: &str, args: &[String], env: &BTreeMap<String, String>) -> Value {
    json!({
        "command": command,
        "args": args,
        "env": env,
    })
}

/// 条目是否 stdio 型（有 command 即视为 stdio，与 Claude 形状一致）。
pub fn is_stdio_entry(value: &Value) -> bool {
    value.get("command").is_some()
}

/// server 名约束：omp schema 的 `^[a-zA-Z0-9_.-]{1,100}$`（也是 Claude 事实约束）。
pub fn is_valid_server_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn desired(entries: &[(&str, Value)]) -> BTreeMap<String, Value> {
        entries
            .iter()
            .map(|(name, value)| (name.to_string(), value.clone()))
            .collect()
    }

    fn stdio_entry(command: &str) -> Value {
        json!({ "command": command, "args": [], "env": {} })
    }

    fn read_servers(path: &Path) -> BTreeMap<String, Value> {
        let text = fs::read_to_string(path).expect("target exists");
        let value: Value = serde_json::from_str(&text).expect("valid json");
        value["mcpServers"]
            .as_object()
            .expect("mcpServers object")
            .clone()
            .into_iter()
            .collect()
    }

    #[test]
    fn no_op_when_nothing_to_inject() {
        let dir = tempfile::tempdir().unwrap();
        let outcome =
            sync_project_mcp_file("omp", dir.path(), &[".omp", "mcp.json"], &BTreeMap::new())
                .unwrap();
        assert!(!outcome.written);
        assert!(!dir.path().join(".omp").join("mcp.json").exists());
        assert!(
            !dir.path().join(".omp").exists(),
            "must not create stray dirs"
        );
    }

    #[test]
    fn injects_creates_guard_and_receipt() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join(".omp").join("mcp.json");
        let wanted = desired(&[("ctx7", stdio_entry("npx")), ("dash", stdio_entry("node"))]);

        let outcome =
            sync_project_mcp_file("omp", dir.path(), &[".omp", "mcp.json"], &wanted).unwrap();

        assert!(outcome.written);
        assert_eq!(outcome.injected, 2);
        let servers = read_servers(&target);
        assert_eq!(servers.keys().collect::<Vec<_>>(), vec!["ctx7", "dash"]);
        // token 守卫与收据
        let guard = fs::read_to_string(dir.path().join(".omp").join(".gitignore")).unwrap();
        assert!(guard.contains("mcp.json"));
        let receipt = fs::read_to_string(receipt_path(dir.path(), "omp")).unwrap();
        assert!(receipt.contains("ctx7") && receipt.contains("dash"));
        let ccpanes_guard = fs::read_to_string(dir.path().join(".ccpanes").join(".gitignore"))
            .expect(".ccpanes guard written");
        assert!(ccpanes_guard.contains(".cache/"));
    }

    #[test]
    fn idempotent_second_sync_does_not_write() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join(".omp").join("mcp.json");
        let wanted = desired(&[("ctx7", stdio_entry("npx"))]);
        sync_project_mcp_file("omp", dir.path(), &[".omp", "mcp.json"], &wanted).unwrap();
        let first = fs::read_to_string(&target).unwrap();

        let outcome =
            sync_project_mcp_file("omp", dir.path(), &[".omp", "mcp.json"], &wanted).unwrap();

        assert!(!outcome.written, "semantic no-change must skip the write");
        assert_eq!(fs::read_to_string(&target).unwrap(), first);
        assert!(!target.with_extension("json.bak").exists());
    }

    #[test]
    fn preserves_user_entries_and_other_top_level_keys() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join(".omp").join("mcp.json");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(
            &target,
            json!({
                "$schema": "https://example.com/schema.json",
                "mcpServers": {
                    "mine": { "command": "user-own-server" },
                    "ctx7": { "command": "user-version-of-ctx7" },
                }
            })
            .to_string(),
        )
        .unwrap();

        let wanted = desired(&[("ctx7", stdio_entry("npx")), ("dash", stdio_entry("node"))]);
        let outcome =
            sync_project_mcp_file("omp", dir.path(), &[".omp", "mcp.json"], &wanted).unwrap();

        assert!(outcome.written);
        assert_eq!(outcome.foreign_collisions, vec!["ctx7".to_string()]);
        let text = fs::read_to_string(&target).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["$schema"], "https://example.com/schema.json");
        // 用户同名条目原样保留，用户独有条目不受影响，新条目正常注入
        assert_eq!(
            value["mcpServers"]["ctx7"]["command"],
            "user-version-of-ctx7"
        );
        assert_eq!(value["mcpServers"]["mine"]["command"], "user-own-server");
        assert_eq!(value["mcpServers"]["dash"]["command"], "node");
        // 收据只含真正由我们写入的名字
        let receipt = fs::read_to_string(receipt_path(dir.path(), "omp")).unwrap();
        assert!(receipt.contains("dash") && !receipt.contains("ctx7"));
    }

    #[test]
    fn removes_stale_managed_entries_and_keeps_user_ones() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join(".jcode").join("mcp.json");
        let first = desired(&[("ctx7", stdio_entry("npx")), ("dash", stdio_entry("node"))]);
        sync_project_mcp_file("jcode", dir.path(), &[".jcode", "mcp.json"], &first).unwrap();

        // 第二次只剩 dash（策略收缩）：ctx7 被移除
        let second = desired(&[("dash", stdio_entry("node"))]);
        let outcome =
            sync_project_mcp_file("jcode", dir.path(), &[".jcode", "mcp.json"], &second).unwrap();

        assert!(outcome.written);
        assert_eq!(outcome.removed, 1);
        let servers = read_servers(&target);
        assert_eq!(servers.keys().collect::<Vec<_>>(), vec!["dash"]);
        assert!(
            target.with_extension("json.bak").exists(),
            "backup before rewrite"
        );
    }

    #[test]
    fn empty_sync_clears_everything_we_own() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join(".omp").join("mcp.json");
        let wanted = desired(&[("ctx7", stdio_entry("npx"))]);
        sync_project_mcp_file("omp", dir.path(), &[".omp", "mcp.json"], &wanted).unwrap();

        let outcome =
            sync_project_mcp_file("omp", dir.path(), &[".omp", "mcp.json"], &BTreeMap::new())
                .unwrap();

        assert!(outcome.written);
        assert_eq!(outcome.removed, 1);
        let servers = read_servers(&target);
        assert!(servers.is_empty());
        let receipt: Value =
            serde_json::from_str(&fs::read_to_string(receipt_path(dir.path(), "omp")).unwrap())
                .unwrap();
        assert_eq!(receipt["servers"], json!([]));
    }

    #[test]
    fn corrupt_target_is_left_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join(".omp").join("mcp.json");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, "{ not json").unwrap();

        let outcome = sync_project_mcp_file(
            "omp",
            dir.path(),
            &[".omp", "mcp.json"],
            &desired(&[("ctx7", stdio_entry("npx"))]),
        )
        .unwrap();

        assert!(!outcome.written);
        assert_eq!(fs::read_to_string(&target).unwrap(), "{ not json");
    }

    #[test]
    fn corrupt_receipt_downgrades_to_conservative_no_ownership() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join(".omp").join("mcp.json");
        sync_project_mcp_file(
            "omp",
            dir.path(),
            &[".omp", "mcp.json"],
            &desired(&[("ctx7", stdio_entry("npx"))]),
        )
        .unwrap();
        fs::write(receipt_path(dir.path(), "omp"), "garbage").unwrap();

        // 收据坏了：既有条目按用户所有处理 → 同名 desired 变 collision，不覆盖
        let outcome = sync_project_mcp_file(
            "omp",
            dir.path(),
            &[".omp", "mcp.json"],
            &desired(&[("ctx7", json!({ "command": "ccpanes-version" }))]),
        )
        .unwrap();

        assert!(!outcome.written);
        assert_eq!(outcome.foreign_collisions, vec!["ctx7".to_string()]);
        let servers = read_servers(&target);
        assert_eq!(servers["ctx7"]["command"], "npx", "user data must survive");
    }

    #[test]
    fn existing_user_gitignore_is_extended_not_clobbered() {
        let dir = tempfile::tempdir().unwrap();
        let tool_dir = dir.path().join(".omp");
        fs::create_dir_all(&tool_dir).unwrap();
        fs::write(tool_dir.join(".gitignore"), "*.log\n").unwrap();

        sync_project_mcp_file(
            "omp",
            dir.path(),
            &[".omp", "mcp.json"],
            &desired(&[("ctx7", stdio_entry("npx"))]),
        )
        .unwrap();

        let guard = fs::read_to_string(tool_dir.join(".gitignore")).unwrap();
        assert!(guard.starts_with("*.log"), "user content preserved");
        assert!(guard.contains("mcp.json"));
    }

    #[test]
    fn user_gitignore_already_covering_mcp_json_is_not_touched() {
        let dir = tempfile::tempdir().unwrap();
        let tool_dir = dir.path().join(".omp");
        fs::create_dir_all(&tool_dir).unwrap();
        fs::write(tool_dir.join(".gitignore"), "mcp.json\n").unwrap();
        let before = fs::read_to_string(tool_dir.join(".gitignore")).unwrap();

        sync_project_mcp_file(
            "omp",
            dir.path(),
            &[".omp", "mcp.json"],
            &desired(&[("ctx7", stdio_entry("npx"))]),
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(tool_dir.join(".gitignore")).unwrap(),
            before
        );
    }

    #[test]
    fn server_name_validation_matches_omp_schema() {
        assert!(is_valid_server_name("context-7"));
        assert!(is_valid_server_name("ctx_7.x"));
        assert!(!is_valid_server_name("has space"));
        assert!(!is_valid_server_name("slash/no"));
        assert!(!is_valid_server_name(""));
        assert!(!is_valid_server_name(&"x".repeat(101)));
    }

    fn ctx_fixture() -> CliAdapterContext {
        CliAdapterContext {
            session_id: "s1".to_string(),
            project_path: "/repo".to_string(),
            workspace_path: None,
            provider: None,
            executable_override: None,
            adapter_options: HashMap::new(),
            resume_id: None,
            issued_session_id: None,
            skip_mcp: false,
            yolo_mode: false,
            append_system_prompt: None,
            initial_prompt: None,
            orchestrator_port: Some(3100),
            orchestrator_token: Some("tok".to_string()),
            launch_id: None,
            data_dir: PathBuf::from("/tmp/data"),
            shared_mcp_urls: HashMap::new(),
            shared_mcp_stdio: BTreeMap::new(),
            allowed_mcp_server_ids: Vec::new(),
            disable_unlisted_mcp_servers: false,
            skill_mount_paths: Vec::new(),
            workspace_mcp_servers: BTreeMap::new(),
        }
    }

    #[test]
    fn collect_merges_layers_shared_and_ccpanes_in_priority_order() {
        let mut ctx = ctx_fixture();
        ctx.workspace_mcp_servers = BTreeMap::from([
            ("layer-stdio".to_string(), stdio_entry("layer-cmd")),
            ("cc7".to_string(), stdio_entry("shared-source")),
        ]);
        ctx.shared_mcp_urls =
            HashMap::from([("cc7".to_string(), "http://127.0.0.1:3101/mcp".to_string())]);

        let collected = collect_mcp_servers(
            &ctx,
            &CollectOptions {
                stdio_only: false,
                ccpanes_entry: Some(ccpanes_http_entry(3100, "tok")),
            },
        );

        // 共享 HTTP 覆盖同名层条目（与 claude.rs 合并顺序一致）
        assert_eq!(collected.servers["cc7"]["type"], "http");
        assert_eq!(collected.servers["cc7"]["url"], "http://127.0.0.1:3101/mcp");
        assert_eq!(collected.servers["layer-stdio"]["command"], "layer-cmd");
        assert_eq!(
            collected.servers["ccpanes"]["url"],
            "http://127.0.0.1:3100/mcp?token=tok"
        );
        assert!(collected.skipped_http_layer_entries.is_empty());
    }

    #[test]
    fn collect_stdio_only_skips_http_and_uses_shared_stdio_specs() {
        let mut ctx = ctx_fixture();
        ctx.workspace_mcp_servers = BTreeMap::from([
            ("layer-stdio".to_string(), stdio_entry("layer-cmd")),
            (
                "layer-http".to_string(),
                json!({ "type": "http", "url": "https://remote/mcp" }),
            ),
        ]);
        ctx.shared_mcp_urls = HashMap::from([
            ("cc7".to_string(), "http://127.0.0.1:3101/mcp".to_string()),
            (
                "remote-only".to_string(),
                "http://127.0.0.1:3102/mcp".to_string(),
            ),
        ]);
        ctx.shared_mcp_stdio = BTreeMap::from([(
            "cc7".to_string(),
            json!({ "command": "npx", "args": ["-y", "ctx7"], "env": {} }),
        )]);

        let collected = collect_mcp_servers(
            &ctx,
            &CollectOptions {
                stdio_only: true,
                ccpanes_entry: Some(json!({ "command": "cc-panes-ctl", "args": ["mcp-proxy"] })),
            },
        );

        assert_eq!(collected.servers["layer-stdio"]["command"], "layer-cmd");
        assert!(!collected.servers.contains_key("layer-http"));
        assert_eq!(
            collected.skipped_http_layer_entries,
            vec!["layer-http".to_string()]
        );
        assert_eq!(collected.servers["cc7"]["command"], "npx");
        assert!(!collected.servers.contains_key("remote-only"));
        assert_eq!(
            collected.skipped_shared_without_stdio,
            vec!["remote-only".to_string()]
        );
        assert_eq!(collected.servers["ccpanes"]["command"], "cc-panes-ctl");
    }

    #[test]
    fn collect_returns_empty_for_skip_mcp() {
        let mut ctx = ctx_fixture();
        ctx.skip_mcp = true;
        ctx.workspace_mcp_servers = BTreeMap::from([("a".to_string(), stdio_entry("x"))]);
        let collected = collect_mcp_servers(
            &ctx,
            &CollectOptions {
                stdio_only: false,
                ccpanes_entry: Some(ccpanes_http_entry(1, "t")),
            },
        );
        assert!(collected.servers.is_empty());
    }

    #[test]
    fn collect_honors_isolation_allowlist() {
        let mut ctx = ctx_fixture();
        ctx.workspace_mcp_servers = BTreeMap::from([
            ("kept".to_string(), stdio_entry("a")),
            ("dropped".to_string(), stdio_entry("b")),
        ]);
        ctx.disable_unlisted_mcp_servers = true;
        ctx.allowed_mcp_server_ids = vec!["kept".to_string()];

        let collected = collect_mcp_servers(
            &ctx,
            &CollectOptions {
                stdio_only: false,
                ccpanes_entry: None,
            },
        );

        assert!(collected.servers.contains_key("kept"));
        assert!(!collected.servers.contains_key("dropped"));
    }

    #[test]
    fn ccpanes_entry_has_no_launch_id_and_carries_auth_header() {
        let entry = ccpanes_http_entry(3100, "tok");
        assert_eq!(entry["url"], "http://127.0.0.1:3100/mcp?token=tok");
        assert_eq!(entry["headers"]["Authorization"], "Bearer tok");
    }
}
