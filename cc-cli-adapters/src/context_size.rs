//! Claude Code 上下文窗口「`[1m]` 后缀」工具。
//!
//! 与 `cc-panes-core::utils::context_size` 同源（避免反向依赖循环）。managed_settings
//! 注入 `ANTHROPIC_MODEL` 时按 [`apply_context_size_suffix`] 拼 `[<size>]` 后缀。
//!
//! 规则：
//! - 空 / `"200k"` / `"custom"` → 不拼后缀
//! - 其它（`"1m"` / `"500k"` / `"100000"` 等）→ 拼 `model[<size>]`

/// 把 model id 拼上 `[<context_size>]` 后缀。空 / `"200k"` / `"custom"` / 已带相同后缀 → 不变。
pub fn apply_context_size_suffix(model: &str, context_size: &str) -> String {
    let cs = context_size.trim();
    if cs.is_empty() || cs.eq_ignore_ascii_case("200k") || cs.eq_ignore_ascii_case("custom") {
        return model.to_string();
    }
    let suffix = format!("[{}]", cs);
    if model.contains(&suffix) {
        return model.to_string();
    }
    format!("{}{}", model, suffix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suffix_200k_and_empty_return_unchanged() {
        assert_eq!(apply_context_size_suffix("claude-sonnet", "200k"), "claude-sonnet");
        assert_eq!(apply_context_size_suffix("claude-sonnet", ""), "claude-sonnet");
        assert_eq!(apply_context_size_suffix("claude-sonnet", "custom"), "claude-sonnet");
        assert_eq!(apply_context_size_suffix("claude-sonnet", "  "), "claude-sonnet");
    }

    #[test]
    fn suffix_appends_brackets_for_other_sizes() {
        assert_eq!(apply_context_size_suffix("MiniMax-M3-highspeed", "1m"), "MiniMax-M3-highspeed[1m]");
        assert_eq!(apply_context_size_suffix("claude-opus-4-7", "500k"), "claude-opus-4-7[500k]");
        assert_eq!(apply_context_size_suffix("gpt-5.4", "100000"), "gpt-5.4[100000]");
    }

    #[test]
    fn suffix_is_idempotent_when_already_present() {
        assert_eq!(apply_context_size_suffix("claude-opus-4-7[1m]", "1m"), "claude-opus-4-7[1m]");
    }
}
