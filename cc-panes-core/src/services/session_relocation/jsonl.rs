//! JSONL 逐行改写：只改指定位置的路径字段，其余字节尽量原样保留。

use super::remap_path;
use serde_json::Value;

/// 单行要改写的字段位置，如 `["cwd"]`、`["payload", "cwd"]`。
pub(super) type FieldPath<'a> = &'a [&'a str];

pub(super) struct Rewritten {
    pub text: String,
    /// 改写了多少个字段。
    pub changed: usize,
}

/// 行不是合法 JSON 对象时返回 `Err(行号)`（从 1 开始）。
pub(super) fn rewrite_jsonl(
    text: &str,
    from: &str,
    to: &str,
    pick: impl Fn(&Value) -> Vec<FieldPath<'static>>,
) -> Result<Rewritten, usize> {
    let mut out = String::with_capacity(text.len() + 64);
    let mut changed = 0;
    for (index, segment) in text.split_inclusive('\n').enumerate() {
        let (line, ending) = match segment.strip_suffix('\n') {
            Some(line) => match line.strip_suffix('\r') {
                Some(line) => (line, "\r\n"),
                None => (line, "\n"),
            },
            None => (segment, ""),
        };
        if line.trim().is_empty() {
            out.push_str(segment);
            continue;
        }
        let value: Value = serde_json::from_str(line).map_err(|_| index + 1)?;
        if !value.is_object() {
            return Err(index + 1);
        }
        let mut next = line.to_string();
        let mut row = value.clone();
        let mut needs_reserialize = false;
        for field in pick(&value) {
            let Some(Value::String(current)) = get(&value, field) else {
                continue;
            };
            let Some(replacement) = remap_path(current, from, to) else {
                continue;
            };
            changed += 1;
            set(&mut row, field, Value::String(replacement.clone()));
            if !needs_reserialize {
                match replace_once(&next, field, current, &replacement) {
                    Some(replaced) => next = replaced,
                    None => needs_reserialize = true,
                }
            }
        }
        if needs_reserialize {
            next = serde_json::to_string(&row).map_err(|_| index + 1)?;
        }
        out.push_str(&next);
        out.push_str(ending);
    }
    Ok(Rewritten { text: out, changed })
}

fn get<'a>(value: &'a Value, field: FieldPath<'_>) -> Option<&'a Value> {
    field.iter().try_fold(value, |node, key| node.get(*key))
}

fn set(value: &mut Value, field: FieldPath<'_>, replacement: Value) {
    let mut node = value;
    for key in &field[..field.len() - 1] {
        match node.get_mut(*key) {
            Some(child) => node = child,
            None => return,
        }
    }
    if let Some(slot) = node.get_mut(field[field.len() - 1]) {
        *slot = replacement;
    }
}

/// 原文里 `"key":"<旧值>"` 恰好出现一次时做字节级替换；出现 0 次或多次（嵌套对象里也有同值）
/// 返回 `None`，由调用方整行重新序列化。
fn replace_once(
    line: &str,
    field: FieldPath<'_>,
    current: &str,
    replacement: &str,
) -> Option<String> {
    let key = serde_json::to_string(field.last()?).ok()?;
    let old_value = serde_json::to_string(current).ok()?;
    let new_value = serde_json::to_string(replacement).ok()?;
    let mut hits = Vec::new();
    for separator in [":", ": "] {
        let needle = format!("{key}{separator}{old_value}");
        let mut start = 0;
        while let Some(found) = line[start..].find(&needle) {
            hits.push((start + found, needle.clone()));
            start += found + needle.len();
        }
    }
    if hits.len() != 1 {
        return None;
    }
    let (at, needle) = &hits[0];
    let separator = &needle[key.len()..needle.len() - old_value.len()];
    let mut next = String::with_capacity(line.len() + new_value.len());
    next.push_str(&line[..*at]);
    next.push_str(&key);
    next.push_str(separator);
    next.push_str(&new_value);
    next.push_str(&line[at + needle.len()..]);
    Some(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn top_cwd(_: &Value) -> Vec<FieldPath<'static>> {
        vec![&["cwd"]]
    }

    #[test]
    fn rewrites_only_matching_prefix_and_keeps_other_bytes() {
        let text = concat!(
            "{\"z\":1,\"cwd\":\"/old/proj\",\"message\":{\"text\":\"/old/proj/a.rs\"}}\n",
            "{\"cwd\":\"/old/proj/sub\"}\r\n",
            "{\"cwd\":\"/old/project-other\"}\n",
            "\n",
            "{\"cwd\":\"/elsewhere\"}"
        );
        let out = rewrite_jsonl(text, "/old/proj", "/new/p", top_cwd).unwrap();
        assert_eq!(out.changed, 2);
        assert_eq!(
            out.text,
            concat!(
                "{\"z\":1,\"cwd\":\"/new/p\",\"message\":{\"text\":\"/old/proj/a.rs\"}}\n",
                "{\"cwd\":\"/new/p/sub\"}\r\n",
                "{\"cwd\":\"/old/project-other\"}\n",
                "\n",
                "{\"cwd\":\"/elsewhere\"}"
            )
        );
    }

    #[test]
    fn nested_duplicate_falls_back_to_reserialize_top_level_only() {
        let text = "{\"cwd\":\"/old\",\"tool\":{\"cwd\":\"/old\"}}\n";
        let out = rewrite_jsonl(text, "/old", "/new", top_cwd).unwrap();
        let value: Value = serde_json::from_str(out.text.trim()).unwrap();
        assert_eq!(value["cwd"], "/new");
        assert_eq!(value["tool"]["cwd"], "/old");
    }

    #[test]
    fn invalid_line_reports_line_number() {
        assert_eq!(
            rewrite_jsonl("{\"cwd\":\"/old\"}\nnot json\n", "/old", "/new", top_cwd).err(),
            Some(2)
        );
    }
}
