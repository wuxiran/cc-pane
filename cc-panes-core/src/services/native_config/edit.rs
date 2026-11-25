//! 片段里单个键的读写（运行配置「原生配置」段的快捷开关用）。
//!
//! - Codex（TOML）走 `toml_edit`：只改目标键，其余内容（注释、空行、键顺序、表）原样保留；
//!   覆盖已有键时沿用它原来的行内注释。
//! - Claude（JSON）走 `serde_json`：内容不丢，但会重新排版（JSON 本身不带注释）。
//! - `value = None` 表示删除该键；键不存在时原文不变。
//! - 与保存同一套规则：托管键 / 像密钥的键一律拒绝写入。

use super::{
    fragment_format, is_forbidden_path, looks_like_secret, FragmentFormat, MAX_FRAGMENT_BYTES,
};
use crate::utils::error::AppError;
use serde_json::{Map, Value};

/// 在片段 `fragment` 里设置（`Some`）或删除（`None`）点分键 `key`，返回新的片段原文。
pub fn set_native_override_key(
    tool: &str,
    fragment: &str,
    key: &str,
    value: Option<&Value>,
) -> Result<String, AppError> {
    let tool = tool.trim().to_ascii_lowercase();
    let format = fragment_format(&tool)
        .ok_or_else(|| AppError::from(format!("{tool}: native config overrides unsupported")))?;
    let path = split_key(key)?;
    if is_forbidden_path(&tool, &path) || path.iter().any(|segment| looks_like_secret(segment)) {
        return Err(AppError::from(format!(
            "{tool}: '{key}' cannot be set from a native config fragment"
        )));
    }
    let next = match format {
        FragmentFormat::Toml => set_toml_key(fragment, &path, value)?,
        FragmentFormat::Json => set_json_key(fragment, &path, value)?,
    };
    if next.len() > MAX_FRAGMENT_BYTES {
        return Err(AppError::from(format!(
            "{tool}: fragment exceeds {MAX_FRAGMENT_BYTES} bytes"
        )));
    }
    Ok(next)
}

fn split_key(key: &str) -> Result<Vec<String>, AppError> {
    let path: Vec<String> = key.split('.').map(|s| s.trim().to_string()).collect();
    if path.iter().any(String::is_empty) {
        return Err(AppError::from(format!("invalid native config key '{key}'")));
    }
    Ok(path)
}

fn to_toml_value(value: &Value) -> Result<toml_edit::Value, AppError> {
    Ok(match value {
        Value::String(text) => toml_edit::Value::from(text.as_str()),
        Value::Bool(flag) => toml_edit::Value::from(*flag),
        Value::Number(number) => match number.as_i64() {
            Some(int) => toml_edit::Value::from(int),
            None => toml_edit::Value::from(number.as_f64().unwrap_or_default()),
        },
        _ => {
            return Err(AppError::from(
                "quick native config keys only accept strings, numbers and booleans",
            ))
        }
    })
}

fn set_toml_key(
    fragment: &str,
    path: &[String],
    value: Option<&Value>,
) -> Result<String, AppError> {
    let mut doc: toml_edit::DocumentMut =
        fragment.parse().map_err(|error: toml_edit::TomlError| {
            AppError::from(format!(
                "fix the TOML syntax error before using quick toggles: {}",
                error.message()
            ))
        })?;
    let (last, parents) = path.split_last().expect("split_key never returns empty");
    let mut table: &mut dyn toml_edit::TableLike = doc.as_table_mut();
    for segment in parents {
        let item = if value.is_some() {
            table.entry(segment).or_insert_with(|| {
                let mut child = toml_edit::Table::new();
                child.set_implicit(true);
                toml_edit::Item::Table(child)
            })
        } else {
            match table.get_mut(segment) {
                Some(item) => item,
                None => return Ok(fragment.to_string()),
            }
        };
        table = item
            .as_table_like_mut()
            .ok_or_else(|| AppError::from(format!("'{segment}' is not a table in the fragment")))?;
    }
    match value {
        None => {
            if table.remove(last).is_none() {
                return Ok(fragment.to_string());
            }
        }
        Some(value) => {
            let mut next = to_toml_value(value)?;
            if let Some(old) = table.get(last).and_then(toml_edit::Item::as_value) {
                *next.decor_mut() = old.decor().clone();
            }
            table.insert(last, toml_edit::Item::Value(next));
        }
    }
    Ok(doc.to_string())
}

fn set_json_key(
    fragment: &str,
    path: &[String],
    value: Option<&Value>,
) -> Result<String, AppError> {
    let mut root: Map<String, Value> = if fragment.trim().is_empty() {
        Map::new()
    } else {
        match serde_json::from_str::<Value>(fragment) {
            Ok(Value::Object(map)) => map,
            Ok(_) => return Err(AppError::from("the JSON fragment must be an object")),
            Err(error) => {
                return Err(AppError::from(format!(
                    "fix the JSON syntax error before using quick toggles: line {} column {}",
                    error.line(),
                    error.column()
                )))
            }
        }
    };
    let (last, parents) = path.split_last().expect("split_key never returns empty");
    let mut object = &mut root;
    for segment in parents {
        if value.is_none() && !object.contains_key(segment) {
            return Ok(fragment.to_string());
        }
        let child = object
            .entry(segment.clone())
            .or_insert_with(|| Value::Object(Map::new()));
        object = child.as_object_mut().ok_or_else(|| {
            AppError::from(format!("'{segment}' is not an object in the fragment"))
        })?;
    }
    match value {
        None => {
            if object.remove(last).is_none() {
                return Ok(fragment.to_string());
            }
        }
        Some(value) => {
            object.insert(last.clone(), value.clone());
        }
    }
    if root.is_empty() {
        return Ok(String::new());
    }
    serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|error| AppError::from(format!("failed to serialize JSON fragment: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn set(tool: &str, fragment: &str, key: &str, value: Option<Value>) -> String {
        set_native_override_key(tool, fragment, key, value.as_ref()).expect("edit should succeed")
    }

    #[test]
    fn codex_set_preserves_comments_and_other_content() {
        let fragment =
            "# my tweaks\nmodel_verbosity = \"low\" # keep\n\n[tui]\nnotifications = true\n";
        let next = set("codex", fragment, "service_tier", Some(json!("fast")));
        assert!(next.starts_with("# my tweaks\nmodel_verbosity = \"low\" # keep\n"));
        assert!(next.contains("service_tier = \"fast\""));
        assert!(next.contains("[tui]\nnotifications = true"));
        // 新键是根级键，必须落在第一个表头之前，否则会被当成 [tui] 的子键
        assert!(next.find("service_tier").unwrap() < next.find("[tui]").unwrap());
        let parsed: toml::Table = next.parse().unwrap();
        assert_eq!(parsed["service_tier"].as_str(), Some("fast"));
        assert_eq!(parsed["tui"]["notifications"].as_bool(), Some(true));
    }

    #[test]
    fn codex_overwrite_keeps_inline_comment_and_remove_round_trips() {
        let fragment = "model_reasoning_effort = \"low\" # tuned\nfoo = 1\n";
        let next = set(
            "codex",
            fragment,
            "model_reasoning_effort",
            Some(json!("high")),
        );
        assert_eq!(next, "model_reasoning_effort = \"high\" # tuned\nfoo = 1\n");
        let removed = set("codex", &next, "model_reasoning_effort", None);
        assert_eq!(removed, "foo = 1\n");
    }

    #[test]
    fn codex_numbers_and_empty_fragment() {
        let next = set(
            "codex",
            "",
            "model_auto_compact_token_limit",
            Some(json!(200000)),
        );
        assert_eq!(next.trim(), "model_auto_compact_token_limit = 200000");
        assert_eq!(
            set("codex", &next, "model_auto_compact_token_limit", None),
            ""
        );
    }

    #[test]
    fn removing_a_missing_key_returns_the_original_text() {
        let fragment = "# only a comment\n";
        assert_eq!(set("codex", fragment, "service_tier", None), fragment);
        assert_eq!(set("claude", "{ \"a\": 1 }", "env.X", None), "{ \"a\": 1 }");
    }

    #[test]
    fn invalid_fragment_is_an_error_not_a_clobber() {
        assert!(
            set_native_override_key("codex", "a = ", "service_tier", Some(&json!("fast"))).is_err()
        );
        assert!(set_native_override_key("claude", "{", "model", None).is_err());
    }

    #[test]
    fn forbidden_and_secret_keys_are_rejected() {
        assert!(set_native_override_key("codex", "", "model_provider", Some(&json!("x"))).is_err());
        assert!(set_native_override_key("codex", "", "api_key", Some(&json!("x"))).is_err());
        assert!(set_native_override_key("gemini", "", "a", Some(&json!(1))).is_err());
        assert!(set_native_override_key("codex", "", "a..b", Some(&json!(1))).is_err());
    }

    #[test]
    fn claude_json_set_and_remove_keep_other_keys() {
        let next = set(
            "claude",
            "{ \"env\": { \"FOO\": \"1\" } }",
            "alwaysThinkingEnabled",
            Some(json!(true)),
        );
        let parsed: Value = serde_json::from_str(&next).unwrap();
        assert_eq!(
            parsed,
            json!({ "env": { "FOO": "1" }, "alwaysThinkingEnabled": true })
        );
        let removed = set("claude", &next, "alwaysThinkingEnabled", None);
        let parsed: Value = serde_json::from_str(&removed).unwrap();
        assert_eq!(parsed, json!({ "env": { "FOO": "1" } }));
        assert_eq!(set("claude", "{\"a\":1}", "a", None), "");
    }
}
