//! `cc-panes-ctl machines …`：「设备」视图里的 SSH 机器（list / check / open）。
//!
//! 只是 MCP 工具 list_ssh_machines / check_ssh_machine / open_terminal_tab(machineId) 的人类友好外壳；
//! 机器既可用 id 也可用名称（不区分大小写）指定。
use serde_json::{json, Value};

use super::{full_surface_client, mcp_text_json, print_json, CommandContext};
use crate::cli::CliExit;
use crate::mcp::McpClient;

fn call_json(client: &mut McpClient, tool: &str, arguments: Value) -> Result<Value, CliExit> {
    mcp_text_json(
        client
            .call_tool(tool, arguments)
            .map_err(|error| CliExit::source(format!("{tool} 调用失败: {error}")))?,
    )
}

fn list_machines(client: &mut McpClient) -> Result<Vec<Value>, CliExit> {
    let value = call_json(client, "list_ssh_machines", json!({}))?;
    Ok(value["machines"].as_array().cloned().unwrap_or_default())
}

/// id 精确匹配优先，其次名称（不区分大小写）；名称重名时要求改用 id。
pub(crate) fn resolve_machine_id(machines: &[Value], key: &str) -> Result<String, CliExit> {
    let key = key.trim();
    if let Some(machine) = machines.iter().find(|m| m["id"].as_str() == Some(key)) {
        return Ok(machine["id"].as_str().unwrap_or_default().to_string());
    }
    let lower = key.to_lowercase();
    let matches: Vec<&Value> = machines
        .iter()
        .filter(|m| m["name"].as_str().map(str::to_lowercase).as_deref() == Some(&lower))
        .collect();
    match matches.as_slice() {
        [one] => Ok(one["id"].as_str().unwrap_or_default().to_string()),
        [] => Err(CliExit::argument(format!(
            "找不到机器 '{key}'；用 `cc-panes-ctl machines list` 查看"
        ))),
        _ => Err(CliExit::argument(format!(
            "有多台机器叫 '{key}'，请改用 id"
        ))),
    }
}

pub(crate) fn list(context: &CommandContext) -> Result<(), CliExit> {
    let mut client = full_surface_client(context)?;
    let machines = list_machines(&mut client)?;
    if context.json {
        return print_json(&json!({ "machines": machines }));
    }
    println!("{:<38} {:<28} {:<32} TAGS", "ID", "NAME", "TARGET");
    for machine in &machines {
        println!(
            "{:<38} {:<28} {:<32} {}",
            machine["id"].as_str().unwrap_or(""),
            machine["name"].as_str().unwrap_or(""),
            target_label(machine),
            tags_label(machine)
        );
    }
    Ok(())
}

pub(crate) fn check(context: &CommandContext, key: &str) -> Result<(), CliExit> {
    let mut client = full_surface_client(context)?;
    let id = resolve_machine_id(&list_machines(&mut client)?, key)?;
    let value = call_json(&mut client, "check_ssh_machine", json!({ "machineId": id }))?;
    if context.json {
        return print_json(&value);
    }
    let reachable = value["reachable"].as_bool() == Some(true);
    println!(
        "{}: {}",
        value["name"].as_str().unwrap_or(&id),
        if reachable { "可连接" } else { "连不上" }
    );
    println!("  {}", value["message"].as_str().unwrap_or(""));
    if let Some(os) = value["os"].as_str() {
        println!("  系统: {os}");
    }
    match value.get("ccPanes").filter(|v| !v.is_null()) {
        Some(cc) => println!(
            "  CC-Panes: {}{}",
            cc["baseUrl"].as_str().unwrap_or(""),
            if cc["pairingSupported"].as_bool() == Some(true) {
                ""
            } else {
                "（版本过旧，需 0.12.22+ 才能配对）"
            }
        ),
        None if reachable => println!("  CC-Panes: 未检测到"),
        None => {}
    }
    if value["canDeploy"].as_bool() == Some(true) {
        println!("  可在「设备」视图里一键部署 CC-Panes");
    }
    Ok(())
}

pub(crate) fn open(
    context: &CommandContext,
    key: &str,
    cwd: Option<String>,
    command: Option<String>,
    title: Option<String>,
) -> Result<(), CliExit> {
    let mut client = full_surface_client(context)?;
    let id = resolve_machine_id(&list_machines(&mut client)?, key)?;
    let value = call_json(
        &mut client,
        "open_terminal_tab",
        json!({ "machineId": id, "cwd": cwd, "command": command, "title": title }),
    )?;
    if context.json {
        return print_json(&value);
    }
    println!(
        "已打开终端「{}」 sessionId={}",
        value["title"].as_str().unwrap_or(""),
        value["sessionId"].as_str().unwrap_or("")
    );
    if let Some(error) = value["commandError"].as_str() {
        println!("注意: 命令未发送: {error}");
    }
    Ok(())
}

fn target_label(machine: &Value) -> String {
    let user = machine["user"]
        .as_str()
        .map(|user| format!("{user}@"))
        .unwrap_or_default();
    let port = machine["port"].as_u64().filter(|port| *port != 22);
    format!(
        "{user}{}{}",
        machine["host"].as_str().unwrap_or(""),
        port.map(|port| format!(":{port}")).unwrap_or_default()
    )
}

fn tags_label(machine: &Value) -> String {
    machine["tags"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn machines() -> Vec<Value> {
        vec![
            json!({"id": "a1", "name": "RTX 5090", "host": "192.168.2.9", "port": 22, "user": "a", "tags": ["gpu"]}),
            json!({"id": "b2", "name": "dup", "host": "h", "port": 2222}),
            json!({"id": "c3", "name": "Dup", "host": "h2", "port": 22}),
        ]
    }

    #[test]
    fn resolves_by_id_then_case_insensitive_name() {
        assert_eq!(resolve_machine_id(&machines(), "a1").unwrap(), "a1");
        assert_eq!(resolve_machine_id(&machines(), "rtx 5090").unwrap(), "a1");
        assert!(resolve_machine_id(&machines(), "dup").is_err());
        assert!(resolve_machine_id(&machines(), "nope").is_err());
    }

    #[test]
    fn labels() {
        let list = machines();
        assert_eq!(target_label(&list[0]), "a@192.168.2.9");
        assert_eq!(target_label(&list[1]), "h:2222");
        assert_eq!(tags_label(&list[0]), "gpu");
    }
}
