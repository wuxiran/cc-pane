//! Cursor Bridge prompt 契约：CCE 证据形状 + bounded do。
//!
//! 这些字符串是给 `cursor-agent` 的，不是 OS 隔离。主 agent 必须自己核 diff。

pub const CCE_RESULT_MARKER: &str = "CCE_SEARCH_RESULT";

pub fn build_context_prompt(query: &str) -> String {
    let query = query.trim();
    [
        "You are a read-only, evidence-driven project-understanding engine running inside Cursor Agent CLI.",
        "Resolve natural-language intent into verifiable code context. Do not guess locations, repeat framework conventions, or propose an implementation.",
        "Search before answering. Choose depth from the question shape: converge quickly for a simple location; trace call chains, data flow, registrations, or cross-module relationships until the minimum sufficient evidence is reached.",
        "Support every claimed relationship with actual search, references, or source reading. Semantic similarity is not a proven call edge.",
        "Do not modify, create, or delete files, and do not run commands that change workspace state.",
        "When evidence is missing, write NOT_FOUND and list the terms, symbols, references, or scopes actually searched under gaps. Never answer without searching.",
        "Write narrative output in the language of the user query unless the query explicitly requests another language. Never translate paths, symbols, identifiers, keys, enum values, or evidence-source markers.",
        "",
        "Return only the minimum sufficient evidence set, ordered by evidence strength.",
        "Output format:",
        CCE_RESULT_MARKER,
        "intent: <one-sentence restatement of the retrieval intent>",
        "coverage: <focused|extended> | <why this search depth was sufficient>",
        "evidence:",
        "- <workspace-relative-path>:<start>-<end> | <symbol or anchor> | <relevance or verified relationship> | <semantic|exact|reference|source-read>",
        "gaps: <anything not confirmed; write none when empty>",
        "confidence: <high|medium|low> (rate retrieval evidence only, not code correctness)",
        "",
        &format!("Retrieval intent: {query}"),
    ]
    .join("\n")
}

pub fn build_do_prompt(task: &str, read_only: bool, allowed_paths: &[String]) -> String {
    let mut parts = vec![
        "Work directly in the workspace currently open. Do not push to a remote.".to_string(),
        "Before finishing, inspect the actual changes and run verification proportional to risk."
            .to_string(),
        "The final reply must list completed work, changed files, verification results, and remaining risks or blockers."
            .to_string(),
        "Reply in the language of the user task unless it explicitly requests another language."
            .to_string(),
        "Never translate paths, commands, identifiers, keys, enum values, exact options, or error/status codes."
            .to_string(),
    ];
    if read_only {
        parts.push(
            "Read-only turn: do not modify, create, or delete files, and do not run commands that change workspace state."
                .to_string(),
        );
    }
    if !allowed_paths.is_empty() {
        parts.push(format!(
            "Hard path boundary (do not read or write outside these paths): {}",
            allowed_paths.join(", ")
        ));
    }
    parts.push(String::new());
    parts.push(format!("Task: {}", task.trim()));
    parts.join("\n")
}

pub fn normalize_cce_search_result(value: &str) -> String {
    let text = value.trim();
    let Some(marker) = text.find(CCE_RESULT_MARKER) else {
        return text.to_string();
    };
    let mut sliced = text[marker..].to_string();
    if let Some(rest) = sliced.strip_prefix(CCE_RESULT_MARKER) {
        if rest.starts_with(" intent:") {
            sliced = format!("{CCE_RESULT_MARKER}\n{}", rest.trim_start());
        }
    }
    sliced
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_prompt_locks_readonly_and_result_shape() {
        let prompt = build_context_prompt("Who owns pane state?");
        assert!(prompt.contains(CCE_RESULT_MARKER));
        assert!(prompt.contains("Do not modify, create, or delete files"));
        assert!(prompt.contains("Who owns pane state?"));
    }

    #[test]
    fn do_prompt_includes_allowed_paths_and_readonly() {
        let prompt = build_do_prompt("fix the bug", true, &["web/stores".into()]);
        assert!(prompt.contains("Read-only turn"));
        assert!(prompt.contains("web/stores"));
        assert!(prompt.contains("fix the bug"));
        assert!(prompt.contains("Do not push to a remote"));
    }

    #[test]
    fn normalize_drops_preamble() {
        let raw = "Sure, I looked around.\n\nCCE_SEARCH_RESULT\nintent: pane state\ngaps: none";
        let normalized = normalize_cce_search_result(raw);
        assert!(normalized.starts_with(CCE_RESULT_MARKER));
        assert!(!normalized.contains("Sure, I looked"));
    }
}
