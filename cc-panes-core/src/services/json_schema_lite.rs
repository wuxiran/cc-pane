//! Minimal JSON Schema subset for structured worker results (docs/114 §7).
//!
//! Supported: `type` (string or array), `properties`, `required`,
//! `additionalProperties: false`, `items`, `enum`, `const`, `minLength`,
//! `maxLength`, `minimum`, `maximum`, `minItems`, `maxItems`.
//! Unknown keywords are ignored on purpose: lenient beats rejecting a valid result.

use serde_json::Value;

const MAX_ERRORS: usize = 8;

/// A schema must be a JSON object (or `true`). Checked when the schema is stored.
pub fn check_schema(schema: &Value) -> Result<(), String> {
    match schema {
        Value::Object(_) | Value::Bool(true) => Ok(()),
        _ => Err("resultSchema must be a JSON Schema object".to_string()),
    }
}

/// Validate `value` against `schema`. Errors carry a JSON pointer.
pub fn validate(schema: &Value, value: &Value) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();
    validate_at(schema, value, "", &mut errors);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

fn push(errors: &mut Vec<String>, path: &str, message: String) {
    if errors.len() < MAX_ERRORS {
        let at = if path.is_empty() { "/" } else { path };
        errors.push(format!("{at}: {message}"));
    }
}

fn type_matches(expected: &str, value: &Value) -> bool {
    match expected {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        "number" => value.is_number(),
        "integer" => value
            .as_f64()
            .is_some_and(|n| n.fract() == 0.0 && value.is_number()),
        _ => true,
    }
}

fn validate_at(schema: &Value, value: &Value, path: &str, errors: &mut Vec<String>) {
    let Some(schema) = schema.as_object() else {
        if schema == &Value::Bool(false) {
            push(errors, path, "not allowed".into());
        }
        return;
    };
    if let Some(expected) = schema.get("type") {
        let names: Vec<&str> = match expected {
            Value::String(name) => vec![name.as_str()],
            Value::Array(items) => items.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        if !names.is_empty() && !names.iter().any(|name| type_matches(name, value)) {
            push(errors, path, format!("expected type {}", names.join("|")));
            return;
        }
    }
    if let Some(constant) = schema.get("const") {
        if constant != value {
            push(errors, path, format!("must equal {constant}"));
        }
    }
    if let Some(Value::Array(options)) = schema.get("enum") {
        if !options.contains(value) {
            push(errors, path, "not one of the allowed values".into());
        }
    }
    match value {
        Value::Object(map) => validate_object(schema, map, path, errors),
        Value::Array(items) => validate_array(schema, items, path, errors),
        Value::String(text) => validate_string(schema, text, path, errors),
        Value::Number(number) => validate_number(schema, number.as_f64(), path, errors),
        _ => {}
    }
}

fn validate_object(
    schema: &serde_json::Map<String, Value>,
    map: &serde_json::Map<String, Value>,
    path: &str,
    errors: &mut Vec<String>,
) {
    if let Some(Value::Array(required)) = schema.get("required") {
        for key in required.iter().filter_map(Value::as_str) {
            if !map.contains_key(key) {
                push(errors, path, format!("missing required property '{key}'"));
            }
        }
    }
    let properties = schema.get("properties").and_then(Value::as_object);
    for (key, child) in map {
        let child_path = format!("{path}/{key}");
        match properties.and_then(|props| props.get(key)) {
            Some(child_schema) => validate_at(child_schema, child, &child_path, errors),
            None => match schema.get("additionalProperties") {
                Some(Value::Bool(false)) => {
                    push(errors, path, format!("unexpected property '{key}'"))
                }
                Some(extra @ Value::Object(_)) => validate_at(extra, child, &child_path, errors),
                _ => {}
            },
        }
    }
}

fn validate_array(
    schema: &serde_json::Map<String, Value>,
    items: &[Value],
    path: &str,
    errors: &mut Vec<String>,
) {
    if let Some(min) = schema.get("minItems").and_then(Value::as_u64) {
        if (items.len() as u64) < min {
            push(errors, path, format!("needs at least {min} items"));
        }
    }
    if let Some(max) = schema.get("maxItems").and_then(Value::as_u64) {
        if (items.len() as u64) > max {
            push(errors, path, format!("allows at most {max} items"));
        }
    }
    if let Some(item_schema) = schema.get("items") {
        for (index, item) in items.iter().enumerate() {
            validate_at(item_schema, item, &format!("{path}/{index}"), errors);
        }
    }
}

fn validate_string(
    schema: &serde_json::Map<String, Value>,
    text: &str,
    path: &str,
    errors: &mut Vec<String>,
) {
    let length = text.chars().count() as u64;
    if let Some(min) = schema.get("minLength").and_then(Value::as_u64) {
        if length < min {
            push(errors, path, format!("shorter than {min} characters"));
        }
    }
    if let Some(max) = schema.get("maxLength").and_then(Value::as_u64) {
        if length > max {
            push(errors, path, format!("longer than {max} characters"));
        }
    }
}

fn validate_number(
    schema: &serde_json::Map<String, Value>,
    number: Option<f64>,
    path: &str,
    errors: &mut Vec<String>,
) {
    let Some(number) = number else { return };
    if let Some(min) = schema.get("minimum").and_then(Value::as_f64) {
        if number < min {
            push(errors, path, format!("less than minimum {min}"));
        }
    }
    if let Some(max) = schema.get("maximum").and_then(Value::as_f64) {
        if number > max {
            push(errors, path, format!("greater than maximum {max}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schema() -> Value {
        json!({
            "type": "object",
            "required": ["files", "passed"],
            "additionalProperties": false,
            "properties": {
                "files": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                "passed": {"type": "boolean"},
                "pr": {"type": ["integer", "null"], "minimum": 1},
                "verdict": {"enum": ["approve", "reject"]}
            }
        })
    }

    #[test]
    fn accepts_a_conforming_result() {
        let value = json!({"files": ["a.rs"], "passed": true, "pr": 12, "verdict": "approve"});
        assert!(validate(&schema(), &value).is_ok());
        assert!(validate(
            &schema(),
            &json!({"files": ["a"], "passed": false, "pr": null})
        )
        .is_ok());
    }

    #[test]
    fn reports_missing_wrong_type_and_extra_properties_with_pointers() {
        let errors =
            validate(&schema(), &json!({"files": [1], "pr": 1.5, "extra": 1})).unwrap_err();
        let joined = errors.join("\n");
        assert!(
            joined.contains("missing required property 'passed'"),
            "{joined}"
        );
        assert!(
            joined.contains("/files/0: expected type string"),
            "{joined}"
        );
        assert!(
            joined.contains("/pr: expected type integer|null"),
            "{joined}"
        );
        assert!(joined.contains("unexpected property 'extra'"), "{joined}");
    }

    #[test]
    fn checks_enum_bounds_and_lengths() {
        let errors = validate(
            &schema(),
            &json!({"files": [], "passed": true, "pr": 0, "verdict": "maybe"}),
        )
        .unwrap_err()
        .join("\n");
        assert!(errors.contains("at least 1 items"));
        assert!(errors.contains("less than minimum"));
        assert!(errors.contains("not one of the allowed values"));
        let text = json!({"type": "string", "minLength": 2, "maxLength": 3});
        assert!(validate(&text, &json!("a")).is_err());
        assert!(validate(&text, &json!("abcd")).is_err());
        assert!(validate(&text, &json!("ab")).is_ok());
    }

    #[test]
    fn unknown_keywords_are_ignored_and_schema_shape_is_checked() {
        let lenient = json!({"type": "string", "format": "uri", "pattern": "^x"});
        assert!(validate(&lenient, &json!("anything")).is_ok());
        assert!(check_schema(&json!({})).is_ok());
        assert!(check_schema(&json!("string")).is_err());
        assert!(check_schema(&json!([])).is_err());
    }
}
