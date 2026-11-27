//! `search_tools` 的检索：关键词命中 + 名字上的模糊（子序列）命中。纯函数，无 IO。
//!
//! 打分：名字整词等于查询 +10；名字含关键词 +3；服务器名含关键词 +2；描述含关键词 +1；
//! 关键词不在名字里、但按顺序散落在名字里（子序列，≥3 字符）+1。
//! 多关键词时至少命中一半才算匹配，避免「send email」把只含 send 的工具全拉出来。

use serde::Serialize;
use serde_json::Value;

/// 缓存里的一条工具（所属服务器 + 原样的定义）。
#[derive(Debug, Clone, PartialEq)]
pub struct HubTool {
    pub server: String,
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// `search_tools` 返回给模型的一条结果。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubToolMatch {
    pub server: String,
    pub tool: String,
    pub summary: String,
    pub input_schema: Value,
}

pub const DEFAULT_LIMIT: usize = 10;
pub const MAX_LIMIT: usize = 50;
const SUMMARY_MAX_CHARS: usize = 160;

/// 把查询切成小写关键词。CJK 没有空格，整段保留做子串匹配。
pub fn keywords(query: &str) -> Vec<String> {
    let mut out: Vec<String> = query
        .split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '-'))
        .flat_map(|word| word.split(['_', '-']))
        .map(|word| word.trim().to_lowercase())
        .filter(|word| !word.is_empty())
        .filter(|word| word.chars().count() > 1 || !word.is_ascii())
        .collect();
    out.dedup();
    out
}

fn is_subsequence(needle: &str, haystack: &str) -> bool {
    let mut chars = haystack.chars();
    needle.chars().all(|n| chars.any(|h| h == n))
}

fn score(tool: &HubTool, query: &str, words: &[String]) -> Option<u32> {
    let name = tool.name.to_lowercase();
    let server = tool.server.to_lowercase();
    let description = tool.description.to_lowercase();
    let trimmed = query.trim().to_lowercase();
    let mut total = 0u32;
    if !trimmed.is_empty() && (name == trimmed || format!("{server}/{name}") == trimmed) {
        total += 10;
    }
    let mut hits = 0usize;
    for word in words {
        let mut word_score = 0;
        if name.contains(word.as_str()) {
            word_score += 3;
        } else if word.chars().count() >= 3 && is_subsequence(word, &name) {
            word_score += 1;
        }
        if server.contains(word.as_str()) {
            word_score += 2;
        }
        if description.contains(word.as_str()) {
            word_score += 1;
        }
        if word_score > 0 {
            hits += 1;
            total += word_score;
        }
    }
    let enough_words = words.is_empty() || hits * 2 >= words.len();
    (total > 0 && enough_words).then_some(total)
}

/// 描述的第一句，最长 160 字符。
pub fn summarize(description: &str) -> String {
    let first_line = description.trim().lines().next().unwrap_or("").trim();
    let mut end = first_line.len();
    for (idx, ch) in first_line.char_indices() {
        if ch == '。' || ((ch == '.' || ch == '!' || ch == '?') && is_sentence_end(first_line, idx))
        {
            end = idx + ch.len_utf8();
            break;
        }
    }
    let sentence = &first_line[..end];
    if sentence.chars().count() <= SUMMARY_MAX_CHARS {
        return sentence.to_string();
    }
    let cut: String = sentence.chars().take(SUMMARY_MAX_CHARS - 1).collect();
    format!("{cut}…")
}

/// `.` 后面是空白或行尾才算句末（避免把 `v1.2`、`a.b` 切断）。
fn is_sentence_end(text: &str, idx: usize) -> bool {
    text[idx + 1..]
        .chars()
        .next()
        .is_none_or(char::is_whitespace)
}

/// 在缓存的工具里检索。空查询按服务器、名字顺序列出全部（仍受 limit 限制）。
pub fn search(tools: &[HubTool], query: &str, limit: Option<usize>) -> Vec<HubToolMatch> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let words = keywords(query);
    let mut ranked: Vec<(u32, &HubTool)> = if words.is_empty() && query.trim().is_empty() {
        tools.iter().map(|tool| (0, tool)).collect()
    } else {
        tools
            .iter()
            .filter_map(|tool| score(tool, query, &words).map(|s| (s, tool)))
            .collect()
    };
    ranked.sort_by(|(sa, a), (sb, b)| {
        sb.cmp(sa)
            .then_with(|| a.server.cmp(&b.server))
            .then_with(|| a.name.cmp(&b.name))
    });
    ranked
        .into_iter()
        .take(limit)
        .map(|(_, tool)| HubToolMatch {
            server: tool.server.clone(),
            tool: tool.name.clone(),
            summary: summarize(&tool.description),
            input_schema: tool.input_schema.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool(server: &str, name: &str, description: &str) -> HubTool {
        HubTool {
            server: server.to_string(),
            name: name.to_string(),
            description: description.to_string(),
            input_schema: json!({"type": "object"}),
        }
    }

    fn catalog() -> Vec<HubTool> {
        vec![
            tool(
                "chrome-devtools",
                "take_screenshot",
                "Take a screenshot of the page. Long text.",
            ),
            tool(
                "chrome-devtools",
                "navigate_page",
                "Navigate the selected page to a URL.",
            ),
            tool(
                "github",
                "create_issue",
                "Create a new issue in a repository.",
            ),
            tool("github", "list_issues", "List issues in a repository."),
            tool("memory", "recall", "从记忆库检索相关条目。"),
        ]
    }

    #[test]
    fn exact_name_ranks_first() {
        let found = search(&catalog(), "create_issue", None);
        assert_eq!(found[0].tool, "create_issue");
        assert_eq!(found[0].server, "github");
    }

    #[test]
    fn keyword_matches_name_and_description() {
        let found = search(&catalog(), "screenshot", None);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].tool, "take_screenshot");
        assert_eq!(found[0].summary, "Take a screenshot of the page.");
    }

    #[test]
    fn server_name_matches() {
        let found = search(&catalog(), "github", None);
        let names: Vec<_> = found.iter().map(|m| m.tool.as_str()).collect();
        assert_eq!(names, vec!["create_issue", "list_issues"]);
    }

    #[test]
    fn fuzzy_subsequence_on_name() {
        let found = search(&catalog(), "navpg", None);
        assert_eq!(found[0].tool, "navigate_page");
    }

    #[test]
    fn multi_word_needs_half_the_words() {
        // "send email" 一个都不命中 → 空，而不是返回所有工具
        assert!(search(&catalog(), "send email", None).is_empty());
        // "issue repository" 两个都命中 github 工具
        assert_eq!(search(&catalog(), "issue repository", None).len(), 2);
    }

    #[test]
    fn cjk_substring_matches() {
        let found = search(&catalog(), "记忆", None);
        assert_eq!(found[0].tool, "recall");
    }

    #[test]
    fn empty_query_lists_all_with_limit() {
        assert_eq!(search(&catalog(), "", None).len(), 5);
        assert_eq!(search(&catalog(), "  ", Some(2)).len(), 2);
        assert_eq!(search(&catalog(), "", Some(0)).len(), 1);
    }

    #[test]
    fn summarize_cuts_first_sentence_and_length() {
        assert_eq!(summarize("Uses v1.2 now. Then more."), "Uses v1.2 now.");
        assert_eq!(summarize("第一句。第二句"), "第一句。");
        assert_eq!(summarize("line one\nline two"), "line one");
        let long = "a".repeat(400);
        assert_eq!(summarize(&long).chars().count(), SUMMARY_MAX_CHARS);
    }
}
