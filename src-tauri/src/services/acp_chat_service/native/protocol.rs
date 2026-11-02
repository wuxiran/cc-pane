//! The App Server wire format is translated at this boundary, never treated as ACP.
use super::*;
use base64::Engine;

pub(super) fn input(blocks: &[Value]) -> AppResult<Vec<Value>> {
    if blocks.is_empty() {
        return Err(AppError::from("A prompt is required"));
    }
    blocks.iter().map(|block| match block["type"].as_str() {
        Some("text") => block["text"].as_str().map(|text| json!({"type":"text","text":text}))
            .ok_or_else(|| AppError::from("Prompt text is invalid")),
        Some("image") => {
            let mime = block["mimeType"].as_str().filter(|mime| ["image/png", "image/jpeg", "image/webp", "image/gif"].contains(mime))
                .ok_or_else(|| AppError::from("Unsupported prompt image type"))?;
            let data = block["data"].as_str().ok_or_else(|| AppError::from("Prompt image data is missing"))?;
            if data.len() > 16 * 1024 * 1024 { return Err(AppError::from("Prompt image is too large")); }
            Ok(json!({"type":"image","url":format!("data:{mime};base64,{data}")}))
        }
        Some("resource_link") => Ok(json!({"type":"text","text":format!("{}: {}",block["name"].as_str().unwrap_or("File"), block["uri"].as_str().ok_or_else(|| AppError::from("File reference is missing"))?)})),
        _ => Err(AppError::from("This prompt content type is not supported by Codex App Server")),
    }).collect()
}

pub(super) fn update(thread: &str, value: Value) -> Value {
    json!({"sessionId":thread,"update":value})
}
pub(super) fn text_update(kind: &str, text: &str) -> Value {
    json!({"sessionUpdate":kind,"content":{"type":"text","text":text}})
}
pub(super) fn item_update(item: &Value, completed: bool) -> Option<Value> {
    let kind = item["type"].as_str()?;
    let id = item["id"].as_str()?;
    let (tool_kind, title) = match kind {
        "commandExecution" => ("execute", item["command"].as_str().unwrap_or("Command")),
        "fileChange" => ("edit", "File changes"),
        "mcpToolCall" | "dynamicToolCall" => ("other", item["tool"].as_str().unwrap_or("Tool")),
        "webSearch" => ("fetch", item["query"].as_str().unwrap_or("Web search")),
        "collabAgentToolCall" => ("other", item["tool"].as_str().unwrap_or("Agent")),
        "imageView" | "imageGeneration" => ("other", "Image"),
        "contextCompaction" => ("other", "Context compaction"),
        "sleep" => ("other", "Waiting"),
        _ => return None,
    };
    let status = match item["status"].as_str() {
        Some("failed" | "declined" | "errored") => "failed",
        _ if completed => "completed",
        _ => "in_progress",
    };
    let content = if kind == "commandExecution"
        && (!completed || item["aggregatedOutput"].as_str().is_none())
    {
        // A completion without aggregatedOutput must not erase streamed output.
        vec![json!({"type":"terminal","terminalId":id})]
    } else if kind == "fileChange" {
        item["changes"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|change| {
                content_text(&format!(
                    "{}\n{}",
                    change["path"].as_str().unwrap_or(""),
                    change["diff"].as_str().unwrap_or("")
                ))
            })
            .collect::<Vec<_>>()
    } else {
        tool_contents(item)
    };
    let locations = item["changes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|change| change["path"].as_str())
        .map(|path| json!({"path":path}))
        .collect::<Vec<_>>();
    Some(
        json!({"sessionUpdate":if completed {"tool_call_update"}else{"tool_call"},"toolCallId":id,"title":title,"kind":tool_kind,"status":status,"content":content,"locations":locations,"rawInput":display_raw(item),"rawOutput":if completed{display_raw(item)}else{Value::Null}}),
    )
}

fn content_text(text: &str) -> Value {
    json!({"type":"content","content":{"type":"text","text":text}})
}

fn inline_image(mime: &str, data: &str) -> Option<Value> {
    if ![
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "image/bmp",
        "image/avif",
    ]
    .contains(&mime)
        || data.is_empty()
        || data.len() > 16 * 1024 * 1024
    {
        return None;
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(data)
        .ok()?;
    if decoded.len() > 10 * 1024 * 1024 {
        return None;
    }
    Some(json!({"type":"image","mimeType":mime,"data":data}))
}

fn image_url_block(url: &str) -> Value {
    if let Some((mime, data)) = url
        .strip_prefix("data:")
        .and_then(|value| value.split_once(";base64,"))
    {
        return inline_image(mime, data)
            .unwrap_or_else(|| json!({"type":"text","text":"[Image data unavailable]"}));
    }
    // Preserve references without fetching remote URLs or reading arbitrary local files.
    json!({"type":"text","text":format!("[Image reference: {}]", display_raw(&json!(url)).as_str().unwrap_or("unavailable"))})
}

fn output_block(block: &Value) -> Value {
    let content = match block["type"].as_str() {
        Some("text" | "inputText") => {
            json!({"type":"text","text":block["text"].as_str().unwrap_or("")})
        }
        Some("image") => inline_image(
            block["mimeType"].as_str().unwrap_or(""),
            block["data"].as_str().unwrap_or(""),
        )
        .unwrap_or_else(|| json!({"type":"text","text":"[Image data unavailable]"})),
        Some("inputImage") => image_url_block(block["imageUrl"].as_str().unwrap_or("")),
        Some("inputAudio") => json!({"type":"text","text":"[Audio output reference]"}),
        Some("resource") if block["resource"]["text"].is_string() => {
            json!({"type":"text","text":block["resource"]["text"]})
        }
        _ => json!({"type":"text","text":display_raw(block).to_string()}),
    };
    json!({"type":"content","content":content})
}

fn tool_contents(item: &Value) -> Vec<Value> {
    let kind = item["type"].as_str().unwrap_or("");
    let blocks = match kind {
        "mcpToolCall" => item.pointer("/result/content").and_then(Value::as_array),
        "dynamicToolCall" => item["contentItems"].as_array(),
        _ => None,
    };
    let mut result: Vec<Value> = blocks.into_iter().flatten().map(output_block).collect();
    if let Some(structured) = item
        .pointer("/result/structuredContent")
        .filter(|value| !value.is_null())
    {
        result.push(content_text(&display_raw(structured).to_string()));
    }
    if let Some(output) = item["aggregatedOutput"].as_str() {
        result.push(content_text(output));
    }
    if let Some(error) = item.get("error").filter(|value| !value.is_null()) {
        result.push(content_text(&display_raw(error).to_string()));
    }
    if result.is_empty() {
        if let Some(output) = item.get("result").filter(|value| !value.is_null()) {
            result.push(content_text(&display_raw(output).to_string()));
        }
    }
    result
}

/// Tool cards show raw metadata too; never duplicate image bytes into those JSON panels.
fn display_raw(value: &Value) -> Value {
    match value {
        Value::Object(fields) => {
            let image = fields
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| matches!(kind, "image" | "inputImage"))
                || fields
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .is_some_and(|mime| mime.starts_with("image/"));
            Value::Object(
                fields
                    .iter()
                    .map(|(key, value)| {
                        let shown = if image && matches!(key.as_str(), "data" | "blob" | "base64") {
                            json!("[image bytes shown in preview]")
                        } else {
                            display_raw(value)
                        };
                        (key.clone(), shown)
                    })
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(display_raw).collect()),
        Value::String(text) if text.starts_with("data:") => {
            json!("[media data omitted from raw view]")
        }
        Value::String(text) if text.len() > 64 * 1024 => {
            let mut end = 64 * 1024;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            json!(format!("{}… [truncated]", &text[..end]))
        }
        _ => value.clone(),
    }
}

pub(super) fn history_user_updates(item: &Value) -> Vec<Value> {
    item["content"].as_array().into_iter().flatten().map(|block| {
        let content = match block["type"].as_str() {
            Some("text") => json!({"type":"text","text":block["text"].as_str().unwrap_or("")}),
            Some("image") if block["url"].is_string() => image_url_block(block["url"].as_str().unwrap_or("")),
            Some("image") => json!({"type":"text","text":format!("[Image reference: {}]",block["fileId"].as_str().unwrap_or("unavailable"))}),
            Some("localImage") => json!({"type":"text","text":format!("[Local image reference: {}]",block["path"].as_str().unwrap_or("unavailable"))}),
            _ => json!({"type":"text","text":format!("[History input: {}]",display_raw(block))}),
        };
        json!({"sessionUpdate":"user_message_chunk","content":content})
    }).collect()
}

pub(super) fn config_options(models: &[Value], model: &str, effort: &str, mode: &str) -> Value {
    let model_options: Vec<_> = models.iter().filter_map(|entry| Some(json!({"value":entry["model"].as_str()?,"name":entry["displayName"].as_str().unwrap_or("Codex")}))).collect();
    let efforts: Vec<_> = models.iter().find(|entry| entry["model"] == model).and_then(|entry| entry["supportedReasoningEfforts"].as_array()).into_iter().flatten()
        .filter_map(|entry| Some(json!({"value":entry["reasoningEffort"].as_str()?,"name":entry["reasoningEffort"],"description":entry["description"]}))).collect();
    json!([
        {"configId":"model","name":"Model","category":"model","type":"select","currentValue":model,"options":model_options},
        {"configId":"mode","name":"Access","category":"mode","type":"select","currentValue":mode,"options":[
            {"value":"read-only","name":"Read only"},{"value":"workspace-write","name":"Workspace write"},{"value":"danger-full-access","name":"Full access"}]},
        {"configId":"reasoning_effort","name":"Reasoning effort","type":"select","currentValue":effort,"options":efforts}
    ])
}

pub(super) fn mode_policy(mode: &str) -> AppResult<Value> {
    Ok(match mode {
        "read-only" => json!({"type":"readOnly"}),
        "workspace-write" => json!({"type":"workspaceWrite"}),
        "danger-full-access" => json!({"type":"dangerFullAccess"}),
        _ => return Err(AppError::from("Unsupported Codex access mode")),
    })
}

pub(super) fn mcp_config(servers: &[Value]) -> Value {
    let mut config = serde_json::Map::new();
    for server in servers {
        if server["type"] != "http" {
            continue;
        }
        if let (Some(name), Some(url)) = (server["name"].as_str(), server["url"].as_str()) {
            config.insert(
                format!("mcp_servers.{name}"),
                json!({"url":url,"enabled":true}),
            );
        }
    }
    Value::Object(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_inputs_and_tools_are_not_acp_wire_messages() {
        assert_eq!(
            input(&[json!({"type":"image","mimeType":"image/png","data":"abc"})]).unwrap()[0]
                ["url"],
            "data:image/png;base64,abc"
        );
        assert!(input(&[json!({"type":"unknown"})]).is_err());
        let file = item_update(&json!({"type":"fileChange","id":"f","status":"completed","changes":[{"path":"a","diff":"@@ -1 +1 @@"}]}),true).unwrap();
        assert_eq!(file["kind"], "edit");
        assert_eq!(file["content"][0]["type"], "content"); // A patch is not a complete undo authority.
        assert!(file["content"][0].get("oldText").is_none());
        assert_eq!(
            mode_policy("workspace-write").unwrap()["type"],
            "workspaceWrite"
        );
        assert!(mode_policy("yolo-by-default").is_err());
    }

    #[test]
    fn mcp_and_dynamic_images_render_once_without_raw_base64_dump() {
        let data = "c2NyZWVuc2hvdC1ieXRlcw==";
        let mcp = item_update(&json!({"type":"mcpToolCall","id":"shot","tool":"screenshot","status":"completed",
            "result":{"content":[{"type":"text","text":"Screenshot ready"},{"type":"image","mimeType":"image/png","data":data}]}}), true).unwrap();
        assert_eq!(mcp["content"][0]["content"]["text"], "Screenshot ready");
        assert_eq!(mcp["content"][1]["content"]["type"], "image");
        assert_eq!(mcp["content"][1]["content"]["data"], data);
        assert!(!mcp["rawInput"].to_string().contains(data));
        assert!(!mcp["rawOutput"].to_string().contains(data));
        let dynamic = item_update(&json!({"type":"dynamicToolCall","id":"dynamic","tool":"image","status":"completed",
            "contentItems":[{"type":"inputText","text":"Result"},{"type":"inputImage","imageUrl":format!("data:image/png;base64,{data}")}] }), true).unwrap();
        assert_eq!(dynamic["content"][0]["content"]["text"], "Result");
        assert_eq!(dynamic["content"][1]["content"]["data"], data);
        assert!(!dynamic["rawOutput"].to_string().contains(data));
    }

    #[test]
    fn streamed_terminal_reference_survives_missing_aggregate_on_completion() {
        let item = json!({"type":"commandExecution","id":"command","command":"build","status":"completed","aggregatedOutput":null});
        let started = item_update(&item, false).unwrap();
        let completed = item_update(&item, true).unwrap();
        assert_eq!(started["content"], completed["content"]);
        assert_eq!(completed["content"][0]["terminalId"], "command");
        assert_eq!(completed["status"], "completed");
    }

    #[test]
    fn image_only_history_keeps_user_blocks_and_never_reads_image_paths() {
        let temp = tempfile::tempdir().unwrap();
        let private = temp.path().join("secret.png");
        std::fs::write(&private, "private file content").unwrap();
        let updates = history_user_updates(&json!({"type":"userMessage","content":[
            {"type":"image","url":"data:image/png;base64,c2NyZWVuc2hvdA=="},
            {"type":"localImage","path":private},
            {"type":"image","fileId":"file-id"}
        ]}));
        assert_eq!(updates.len(), 3);
        assert!(updates
            .iter()
            .all(|update| update["sessionUpdate"] == "user_message_chunk"));
        assert_eq!(updates[0]["content"]["type"], "image");
        assert!(updates[1]["content"]["text"]
            .as_str()
            .unwrap()
            .contains("secret.png"));
        assert!(updates[2]["content"]["text"]
            .as_str()
            .unwrap()
            .contains("file-id"));
        assert!(!serde_json::to_string(&updates)
            .unwrap()
            .contains("private file content"));
    }

    #[test]
    fn untrusted_image_references_are_visible_without_fetching_or_active_markup() {
        let output =
            output_block(&json!({"type":"inputImage","imageUrl":"https://example.com/image.png"}));
        assert_eq!(output["content"]["type"], "text");
        assert!(output["content"]["text"]
            .as_str()
            .unwrap()
            .contains("https://example.com/image.png"));
        let svg =
            output_block(&json!({"type":"image","mimeType":"image/svg+xml","data":"PHN2Zy8+"}));
        assert_eq!(svg["content"]["type"], "text");
        assert!(!svg.to_string().contains("PHN2Zy8+"));
    }
}
