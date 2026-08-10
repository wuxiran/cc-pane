//! Claude Code 上下文窗口「`[1m]` 后缀」三件套。
//!
//! 镜像 ccpanel `src-tauri/src/config.rs::context_size_*`：用户在 Provider 模型
//! 设置里填 `contextSize`（字符串如 `"1m"` / `"200k"`），managed_settings 注入
//! `ANTHROPIC_MODEL` 时按 [`apply_context_size_suffix`] 拼上 `[<size>]`；后端
//! context usage 服务再通过 [`parse_context_window_from_model`] 反解得到 token 数。
//!
//! 规则：
//! - 空 / `"200k"` / `"custom"` → `apply_context_size_suffix` 不拼后缀（让 Claude
//!   Code 用自己的默认窗口；`"custom"` 表示用户自行管 env）
//! - 其它（如 `"1m"` / `"500k"` / `"100000"`）→ 拼 `model[<size>]`
//! - `parse_context_size_tokens` 把字符串反解成 token 数；`"1m"` → 1_000_000，
//!   `"500k"` → 500_000，`"custom"` / 解析失败 → 0 表示「未知」

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

/// `contextSize` 字符串反解为 token 数。空 / `"custom"` / 解析失败 → 0。
pub fn parse_context_size_tokens(context_size: &str) -> u64 {
    let s = context_size.trim().to_ascii_lowercase();
    if s.is_empty() || s == "custom" {
        return 0;
    }
    if let Some(rest) = s.strip_suffix('m') {
        rest.parse::<u64>()
            .ok()
            .filter(|n| *n > 0 && *n <= 100)
            .map(|n| n * 1_000_000)
            .unwrap_or(0)
    } else if let Some(rest) = s.strip_suffix('k') {
        rest.parse::<u64>()
            .ok()
            .map(|n| n * 1_000)
            .unwrap_or(0)
    } else {
        s.parse::<u64>().unwrap_or(0)
    }
}

/// 从带 `[...]` 后缀的 model 字符串反解 token 数。无后缀 / 不可解析 → 0。
pub fn parse_context_window_from_model(model: &str) -> u64 {
    if let Some(start) = model.rfind('[') {
        if let Some(end) = model[start..].find(']') {
            let inner = &model[start + 1..start + end];
            if !inner.is_empty() {
                return parse_context_size_tokens(inner);
            }
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suffix_200k_and_empty_return_unchanged() {
        // 200k / 空 / "custom" 是「不拼」的语义；其它（包括 100k / 500k / 1m）都拼。
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
        // 已有不同后缀时仍会再拼（不防这种情况——保持简单，与 ccpanel 一致）
    }

    #[test]
    fn suffix_trims_input() {
        assert_eq!(apply_context_size_suffix("model", "  1m  "), "model[1m]");
    }

    #[test]
    fn parse_size_recognises_k_and_m_suffixes() {
        assert_eq!(parse_context_size_tokens("1m"), 1_000_000);
        assert_eq!(parse_context_size_tokens("500k"), 500_000);
        assert_eq!(parse_context_size_tokens("200k"), 200_000);
        assert_eq!(parse_context_size_tokens("100000"), 100_000);
        assert_eq!(parse_context_size_tokens("2M"), 2_000_000);
    }

    #[test]
    fn parse_size_returns_zero_for_unknown() {
        assert_eq!(parse_context_size_tokens(""), 0);
        assert_eq!(parse_context_size_tokens("custom"), 0);
        assert_eq!(parse_context_size_tokens("garbage"), 0);
        assert_eq!(parse_context_size_tokens("1000000m"), 0); // 上限 100m 防误配
    }

    #[test]
    fn parse_from_model_extracts_suffix() {
        assert_eq!(parse_context_window_from_model("claude-opus-4-7[1m]"), 1_000_000);
        assert_eq!(parse_context_window_from_model("MiniMax-M3-highspeed[500k]"), 500_000);
        assert_eq!(parse_context_window_from_model("plain"), 0);
        assert_eq!(parse_context_window_from_model("trailing["), 0);
    }
}
