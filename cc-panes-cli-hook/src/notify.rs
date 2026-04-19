use clap::Args;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Args)]
pub struct NotifyArgs {
    #[arg(long, default_value = "custom")]
    kind: String,
    #[arg(long)]
    title: String,
    #[arg(long)]
    body: Option<String>,
    #[arg(long, default_value = "cli")]
    source: String,
    #[arg(long)]
    scope: Option<String>,
    #[arg(long = "dedupe-key")]
    dedupe_key: Option<String>,
    #[arg(long)]
    only_when_unfocused: bool,
    #[arg(long = "metadata-json")]
    metadata_json: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotifyRequest {
    kind: String,
    title: String,
    body: Option<String>,
    source: Option<String>,
    scope: Option<String>,
    dedupe_key: Option<String>,
    only_when_unfocused: Option<bool>,
    metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct OrchestratorConfig {
    #[serde(rename = "mcpServers")]
    mcp_servers: HashMap<String, OrchestratorServerEntry>,
}

#[derive(Debug, Deserialize)]
struct OrchestratorServerEntry {
    url: String,
    headers: Option<HashMap<String, String>>,
}

pub fn run(args: NotifyArgs) {
    match send_notification(args) {
        Ok(response) => {
            println!("{}", response);
        }
        Err(error) => {
            eprintln!("[cc-panes-cli-hook] notify failed: {}", error);
            std::process::exit(1);
        }
    }
}

fn send_notification(args: NotifyArgs) -> Result<String, String> {
    let (api_url, auth_header) = load_orchestrator_endpoint()?;
    let metadata = match args.metadata_json {
        Some(raw) => {
            Some(serde_json::from_str(&raw).map_err(|e| format!("Invalid metadata JSON: {}", e))?)
        }
        None => None,
    };

    let request = NotifyRequest {
        kind: args.kind,
        title: args.title,
        body: args.body,
        source: Some(args.source),
        scope: args.scope,
        dedupe_key: args.dedupe_key,
        only_when_unfocused: Some(args.only_when_unfocused),
        metadata,
    };

    let payload =
        serde_json::to_string(&request).map_err(|e| format!("Failed to encode request: {}", e))?;

    ureq::post(&api_url)
        .header("Authorization", &auth_header)
        .header("Content-Type", "application/json")
        .send(payload.as_bytes())
        .map_err(|e| format!("Notification API request failed: {}", e))?
        .body_mut()
        .read_to_string()
        .map_err(|e| format!("Failed to read notification API response: {}", e))
}

fn load_orchestrator_endpoint() -> Result<(String, String), String> {
    let config_path = find_orchestrator_config().ok_or_else(|| {
        "mcp-orchestrator.json not found in known CC-Panes data directories".to_string()
    })?;
    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read {}: {}", config_path.display(), e))?;
    let config: OrchestratorConfig = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid orchestrator config: {}", e))?;
    let server = config
        .mcp_servers
        .get("ccpanes")
        .ok_or_else(|| "Missing mcpServers.ccpanes entry".to_string())?;

    let auth_header = server
        .headers
        .as_ref()
        .and_then(|headers| headers.get("Authorization").cloned())
        .or_else(|| extract_bearer_from_query(&server.url).map(|token| format!("Bearer {}", token)))
        .ok_or_else(|| "Missing Authorization header in orchestrator config".to_string())?;

    let mcp_url = url::Url::parse(&server.url)
        .map_err(|e| format!("Invalid orchestrator URL '{}': {}", server.url, e))?;
    let mut api_url = mcp_url.clone();
    api_url.set_query(None);
    api_url.set_path("/api/notifications/trigger");

    Ok((api_url.to_string(), auth_header))
}

fn find_orchestrator_config() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CC_PANES_DATA_DIR") {
        let path = PathBuf::from(dir).join("mcp-orchestrator.json");
        if path.exists() {
            return Some(path);
        }
    }

    let home = dirs::home_dir()?;
    for dir_name in [".cc-panes", ".cc-panes-dev"] {
        let path = home.join(dir_name).join("mcp-orchestrator.json");
        if path.exists() {
            return Some(path);
        }
    }
    None
}

fn extract_bearer_from_query(raw_url: &str) -> Option<String> {
    let url = url::Url::parse(raw_url).ok()?;
    url.query_pairs()
        .find_map(|(key, value)| (key == "token").then(|| value.into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_bearer_token_from_query() {
        let token = extract_bearer_from_query("http://127.0.0.1:48080/mcp?token=abc123");
        assert_eq!(token.as_deref(), Some("abc123"));
    }
}
