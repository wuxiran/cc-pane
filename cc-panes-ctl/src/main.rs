use std::path::PathBuf;

use cc_panes_ctl::discovery::{
    data_dir_candidates, discover_orchestrator_endpoint, DataDirMode, ServiceEndpoint,
};
use cc_panes_ctl::mcp::{McpClient, ToolDefinition};
use clap::{Parser, Subcommand};
use serde_json::{Map, Number, Value};

#[derive(Debug, Parser)]
#[command(name = "cc-panes-ctl", about = "CC-Panes control-plane CLI")]
struct Cli {
    #[arg(long, conflicts_with_all = ["release", "data_dir"])]
    dev: bool,
    #[arg(long, conflicts_with_all = ["dev", "data_dir"])]
    release: bool,
    #[arg(long, value_name = "PATH", conflicts_with_all = ["dev", "release"])]
    data_dir: Option<PathBuf>,
    /// Emit machine-readable output. Place before the subcommand.
    #[arg(long)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// List MCP tools discovered at runtime.
    Tools {
        #[arg(long, value_name = "NAME")]
        schema: Option<String>,
    },
    /// Call any MCP tool.
    Call {
        tool: String,
        #[arg(long = "json", value_name = "OBJECT", conflicts_with = "arg")]
        arguments_json: Option<String>,
        #[arg(long = "arg", value_name = "KEY=VALUE")]
        arg: Vec<String>,
    },
}

fn main() {
    let cli = Cli::parse();
    if let Err(error) = run(cli) {
        eprintln!("错误: {error}");
        std::process::exit(2);
    }
}

fn run(cli: Cli) -> Result<(), String> {
    let endpoint = discover_single_orchestrator(data_mode(&cli))?;
    let mut client = McpClient::new(endpoint, std::env::var("CC_PANES_LAUNCH_ID").ok());
    match cli.command {
        Command::Tools { schema } => {
            let tools = client.list_tools().map_err(mcp_error)?;
            print_tools(&tools, schema.as_deref(), cli.json)
        }
        Command::Call {
            tool,
            arguments_json,
            arg,
        } => {
            let tools = client.list_tools().map_err(mcp_error)?;
            let definition = tools
                .iter()
                .find(|definition| definition.name == tool)
                .ok_or_else(|| format!("运行时 tools/list 中不存在工具 '{tool}'"))?;
            let arguments = parse_arguments(arguments_json.as_deref(), &arg, definition)?;
            let result = client.call_tool(&tool, arguments).map_err(mcp_error)?;
            print_call_result(&result, cli.json)
        }
    }
}

fn data_mode(cli: &Cli) -> DataDirMode {
    if let Some(path) = cli.data_dir.as_ref() {
        DataDirMode::Custom(path.clone())
    } else if cli.dev {
        DataDirMode::Dev
    } else if cli.release {
        DataDirMode::Release
    } else {
        DataDirMode::Auto
    }
}

fn discover_single_orchestrator(mode: DataDirMode) -> Result<ServiceEndpoint, String> {
    let mut found = Vec::new();
    let mut failures = Vec::new();
    for candidate in data_dir_candidates(&mode).map_err(|error| error.to_string())? {
        match discover_orchestrator_endpoint(&candidate.path) {
            Ok(endpoint) => found.push(endpoint),
            Err(error) => failures.push(format!("{}: {error}", candidate.path.display())),
        }
    }
    match found.len() {
        1 => Ok(found.remove(0)),
        0 => Err(format!(
            "orchestrator 不可用。已尝试: {}。可改用 status/sessions 的 daemon 降级命令检查会话",
            failures.join("; ")
        )),
        _ => Err("dev 与 release orchestrator 都在线，请显式指定 --dev 或 --release".to_string()),
    }
}

fn print_tools(
    tools: &[ToolDefinition],
    schema: Option<&str>,
    json_output: bool,
) -> Result<(), String> {
    if let Some(name) = schema {
        let tool = tools
            .iter()
            .find(|tool| tool.name == name)
            .ok_or_else(|| format!("运行时 tools/list 中不存在工具 '{name}'"))?;
        let value = serde_json::json!({
            "name": tool.name,
            "description": tool.description,
            "inputSchema": tool.input_schema,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?
        );
        return Ok(());
    }
    if json_output {
        let values = tools
            .iter()
            .map(|tool| {
                serde_json::json!({
                    "name": tool.name,
                    "description": tool.description,
                    "inputSchema": tool.input_schema,
                })
            })
            .collect::<Vec<_>>();
        println!(
            "{}",
            serde_json::to_string_pretty(&values).map_err(|error| error.to_string())?
        );
    } else {
        for tool in tools {
            let description = tool.description.as_deref().unwrap_or("");
            println!(
                "{:<36} {}",
                tool.name,
                description.lines().next().unwrap_or("")
            );
        }
    }
    Ok(())
}

fn parse_arguments(
    raw_json: Option<&str>,
    args: &[String],
    tool: &ToolDefinition,
) -> Result<Value, String> {
    if let Some(raw) = raw_json {
        let value: Value =
            serde_json::from_str(raw).map_err(|error| format!("--json 不是有效 JSON: {error}"))?;
        return value
            .is_object()
            .then_some(value)
            .ok_or_else(|| "--json 必须是 JSON object".to_string());
    }

    let properties = tool
        .input_schema
        .get("properties")
        .and_then(Value::as_object);
    let mut result = Map::new();
    for raw in args {
        let (key, value) = raw
            .split_once('=')
            .ok_or_else(|| format!("--arg '{raw}' 缺少 '='"))?;
        if key.is_empty() {
            return Err("--arg 的 key 不能为空".to_string());
        }
        let schema = properties.and_then(|properties| properties.get(key));
        result.insert(key.to_string(), convert_arg_value(value, schema)?);
    }
    Ok(Value::Object(result))
}

fn convert_arg_value(raw: &str, schema: Option<&Value>) -> Result<Value, String> {
    let schema_type = schema
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("string");
    match schema_type {
        "string" => Ok(Value::String(raw.to_string())),
        "boolean" => raw
            .parse::<bool>()
            .map(Value::Bool)
            .map_err(|_| format!("'{raw}' 不是 boolean")),
        "integer" => raw
            .parse::<i64>()
            .map(Number::from)
            .map(Value::Number)
            .map_err(|_| format!("'{raw}' 不是 integer")),
        "number" => raw
            .parse::<f64>()
            .ok()
            .and_then(Number::from_f64)
            .map(Value::Number)
            .ok_or_else(|| format!("'{raw}' 不是有限 number")),
        "object" | "array" => serde_json::from_str(raw)
            .map_err(|error| format!("'{raw}' 不是有效 {schema_type}: {error}")),
        "null" if raw == "null" => Ok(Value::Null),
        other => Err(format!(
            "暂不支持 schema type '{other}' 的 --arg 转型，请使用 --json"
        )),
    }
}

fn print_call_result(result: &Value, json_output: bool) -> Result<(), String> {
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(result).map_err(|error| error.to_string())?
        );
        return Ok(());
    }
    if let Some(content) = result.get("content").and_then(Value::as_array) {
        for block in content {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => println!(
                    "{}",
                    block.get("text").and_then(Value::as_str).unwrap_or("")
                ),
                _ => println!(
                    "{}",
                    serde_json::to_string_pretty(block).map_err(|error| error.to_string())?
                ),
            }
        }
    } else {
        println!(
            "{}",
            serde_json::to_string_pretty(result).map_err(|error| error.to_string())?
        );
    }
    Ok(())
}

fn mcp_error(error: impl std::fmt::Display) -> String {
    format!("{error}；orchestrator 不可用时可改用 status/sessions 的 daemon 降级命令")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(schema: Value) -> ToolDefinition {
        ToolDefinition {
            name: "demo".to_string(),
            description: None,
            input_schema: schema,
        }
    }

    #[test]
    fn arg_values_follow_runtime_schema_types() {
        let definition = tool(serde_json::json!({
            "type": "object",
            "properties": {
                "count": { "type": "integer" },
                "enabled": { "type": "boolean" },
                "names": { "type": "array" },
                "label": { "type": "string" }
            }
        }));
        let value = parse_arguments(
            None,
            &[
                "count=3".to_string(),
                "enabled=true".to_string(),
                "names=[\"a\",\"b\"]".to_string(),
                "label=003".to_string(),
            ],
            &definition,
        )
        .unwrap();
        assert_eq!(value["count"], 3);
        assert_eq!(value["enabled"], true);
        assert_eq!(value["names"][1], "b");
        assert_eq!(value["label"], "003");
    }

    #[test]
    fn raw_json_requires_object() {
        let definition = tool(serde_json::json!({ "type": "object" }));
        assert!(parse_arguments(Some("[]"), &[], &definition).is_err());
        assert_eq!(
            parse_arguments(Some(r#"{"value":1}"#), &[], &definition).unwrap()["value"],
            1
        );
    }
}
