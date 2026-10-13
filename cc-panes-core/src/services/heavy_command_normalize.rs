//! 重负载命令的归一化与脱敏（纯函数，台账唯一允许落盘的两种形态）。
//!
//! 隐私红线同 `system_stats_service/diagnostics.rs`：**原始命令行绝不落盘**。
//! - [`normalize`]：聚合键。去掉前导 `cd … &&` / 环境赋值 / 包管理器前缀，取首段
//!   前两个 token（`cargo test -p x` → `cargo test`，`rg foo src` → `rg`）。
//! - [`redact`]：给人看的那一行。掩掉 token/key/secret/password/authorization
//!   的值、URL 里的凭据、≥32 位的 base64/hex 串，并截断到 [`REDACTED_MAX_CHARS`]。

/// 脱敏后命令的最大字符数（再长也只是识别用）。
pub const REDACTED_MAX_CHARS: usize = 240;
const MASK: &str = "***";

/// 只带一个动词的命令：第二个 token 多半是文件/模式，不该进聚合键。
const SINGLE_TOKEN_COMMANDS: &[&str] = &[
    "rg",
    "grep",
    "find",
    "fd",
    "ls",
    "cat",
    "cd",
    "echo",
    "node",
    "python",
    "python3",
    "bash",
    "sh",
    "pwsh",
    "powershell",
    "cmd",
    "tsc",
    "eslint",
    "prettier",
    "vitest",
    "jest",
    "pytest",
    "rustc",
    "gcc",
    "clang",
    "g++",
    "clang++",
    "cl",
    "link",
    "tar",
    "zip",
    "unzip",
    "curl",
    "wget",
    "ssh",
    "scp",
    "rsync",
    "ffmpeg",
    "code",
    "cursor",
];

/// 这些第一 token 只是"跑后面那个东西"，真正的命令在后面。
const RUNNER_PREFIXES: &[&str] = &[
    "npx", "pnpx", "bunx", "yarn", "pnpm", "npm", "bun", "uv", "uvx", "poetry", "pipx", "time",
    "nice", "sudo", "nohup", "env", "exec", "command", "timeout",
];

/// 归一化为聚合键。永不返回空串（兜底 `"(empty)"`）。
pub fn normalize(command: &str) -> String {
    let first_segment = split_first_segment(command);
    let tokens = tokenize(first_segment);
    let mut tokens = tokens.as_slice();

    // 去掉前导环境赋值 `FOO=bar cmd …`
    while let Some((head, rest)) = tokens.split_first() {
        if is_env_assignment(head) {
            tokens = rest;
        } else {
            break;
        }
    }
    // 去掉 runner 前缀及其短选项（`npm run build` → `run build` 不好看，特殊处理 run/exec）
    while let Some((head, rest)) = tokens.split_first() {
        let head_lower = base_name(head);
        if RUNNER_PREFIXES.contains(&head_lower.as_str()) {
            let mut rest = rest;
            while let Some((flag, tail)) = rest.split_first() {
                if flag.starts_with('-') || flag.contains('=') {
                    rest = tail;
                } else {
                    break;
                }
            }
            // `npm run build` / `pnpm exec vitest`：保留 `npm run build` 这种可读形态。
            if matches!(head_lower.as_str(), "npm" | "pnpm" | "yarn" | "bun")
                && rest
                    .first()
                    .is_some_and(|sub| matches!(sub.as_str(), "run" | "exec" | "test" | "start"))
            {
                let verb = rest[0].as_str();
                let script = rest.get(1).map(|s| s.as_str()).unwrap_or("");
                return if script.is_empty() || script.starts_with('-') {
                    format!("{head_lower} {verb}")
                } else {
                    format!("{head_lower} {verb} {script}")
                };
            }
            tokens = rest;
            continue;
        }
        break;
    }

    let Some((head, rest)) = tokens.split_first() else {
        return "(empty)".to_string();
    };
    let head = base_name(head);
    if head.is_empty() {
        return "(empty)".to_string();
    }
    if SINGLE_TOKEN_COMMANDS.contains(&head.as_str()) {
        return head;
    }
    match rest.first() {
        Some(sub) if !sub.starts_with('-') && !looks_like_path(sub) => {
            format!("{head} {}", sub.to_ascii_lowercase())
        }
        _ => head,
    }
}

/// 脱敏并截断。输出可安全落盘 / 回传前端。
pub fn redact(command: &str) -> String {
    let mut out = String::with_capacity(command.len());
    for (index, token) in command.split_whitespace().enumerate() {
        if index > 0 {
            out.push(' ');
        }
        out.push_str(&redact_token(token));
    }
    truncate_chars(&out, REDACTED_MAX_CHARS)
}

fn redact_token(token: &str) -> String {
    // URL 凭据：scheme://user:pass@host
    if let Some(scheme_end) = token.find("://") {
        let (scheme, rest) = token.split_at(scheme_end + 3);
        if let Some(at) = rest.find('@') {
            let (_, host) = rest.split_at(at);
            return format!("{scheme}{MASK}{host}");
        }
    }
    // key=value / key:value（key 含敏感词）
    for sep in ['=', ':'] {
        if let Some(pos) = token.find(sep) {
            let (key, value) = token.split_at(pos);
            if is_sensitive_key(key) && value.len() > 1 {
                return format!("{key}{sep}{MASK}");
            }
        }
    }
    // Bearer xxx 在上一轮处理不到（跨 token），这里只处理裸长串
    if is_long_opaque(token) {
        return MASK.to_string();
    }
    token.to_string()
}

fn is_sensitive_key(key: &str) -> bool {
    let key = key.trim_start_matches('-').to_ascii_lowercase();
    [
        "token",
        "key",
        "secret",
        "password",
        "passwd",
        "pwd",
        "authorization",
        "auth",
        "cookie",
    ]
    .iter()
    .any(|needle| key.contains(needle))
}

/// ≥32 位且只由 base64/hex 字符组成的串，视为凭据。
fn is_long_opaque(token: &str) -> bool {
    let body = token.trim_end_matches('=');
    body.len() >= 32
        && body
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '-' || c == '_')
        && body.chars().any(|c| c.is_ascii_digit())
        && body.chars().any(|c| c.is_ascii_alphabetic())
}

/// 取 `&&` / `;` / `||` / `|` 分隔的第一段；若首段是 `cd …`，跳到下一段。
fn split_first_segment(command: &str) -> &str {
    let mut rest = command.trim();
    loop {
        let (segment, tail) = split_once_any(rest, &["&&", "||", ";", "|"]);
        let segment = segment.trim();
        let is_cd = tokenize(segment)
            .first()
            .map(|head| base_name(head) == "cd")
            .unwrap_or(false);
        if is_cd || segment.is_empty() {
            match tail {
                Some(tail) if !tail.trim().is_empty() => {
                    rest = tail.trim();
                    continue;
                }
                _ => return segment,
            }
        }
        return segment;
    }
}

fn split_once_any<'a>(input: &'a str, separators: &[&str]) -> (&'a str, Option<&'a str>) {
    let mut best: Option<(usize, usize)> = None;
    for sep in separators {
        if let Some(pos) = input.find(sep) {
            if best.is_none_or(|(best_pos, _)| pos < best_pos) {
                best = Some((pos, sep.len()));
            }
        }
    }
    match best {
        Some((pos, len)) => (&input[..pos], Some(&input[pos + len..])),
        None => (input, None),
    }
}

fn tokenize(segment: &str) -> Vec<String> {
    segment
        .split_whitespace()
        .map(|token| token.trim_matches(|c| c == '"' || c == '\'').to_string())
        .filter(|token| !token.is_empty())
        .collect()
}

fn is_env_assignment(token: &str) -> bool {
    match token.split_once('=') {
        Some((key, _)) => {
            !key.is_empty()
                && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && !key.starts_with(|c: char| c.is_ascii_digit())
        }
        None => false,
    }
}

/// 去掉路径与 `.exe`，小写。`/usr/bin/cargo` / `C:\…\cargo.exe` → `cargo`。
fn base_name(token: &str) -> String {
    let name = token.rsplit(['/', '\\']).next().unwrap_or(token);
    let name = name.trim_end_matches(".exe").trim_end_matches(".EXE");
    name.to_ascii_lowercase()
}

fn looks_like_path(token: &str) -> bool {
    token.contains('/') || token.contains('\\') || token.starts_with('.') || token.contains(':')
}

fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let mut out: String = value.chars().take(limit).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_table() {
        let cases = [
            ("cargo test -p cc-panes-core", "cargo test"),
            ("cd D:/repo && cargo build --release", "cargo build"),
            ("cd /x; cd /y && npm run build", "npm run build"),
            ("rg foo src", "rg"),
            ("grep -rn pattern .", "grep"),
            ("/usr/bin/cargo clippy --all", "cargo clippy"),
            (r"C:\Users\me\.cargo\bin\cargo.exe check", "cargo check"),
            ("RUST_LOG=debug cargo run", "cargo run"),
            ("npx vitest run web/test", "vitest"),
            ("pnpm exec tsc --noEmit", "pnpm exec tsc"),
            ("npm test", "npm test"),
            ("git status --short", "git status"),
            ("python script.py", "python"),
            ("make -j8", "make"),
            ("docker compose up -d", "docker compose"),
            ("cargo test 2>&1 | tail -n 20", "cargo test"),
            ("", "(empty)"),
            ("cd /only", "cd"),
        ];
        for (input, expected) in cases {
            assert_eq!(normalize(input), expected, "input: {input:?}");
        }
    }

    #[test]
    fn redact_table() {
        let cases = [
            (
                "curl -H token=abc123 https://x",
                "curl -H token=*** https://x",
            ),
            ("API_KEY=sk-live-123456 cargo run", "API_KEY=*** cargo run"),
            ("--password=hunter2 ls", "--password=*** ls"),
            ("Authorization:Bearer-xyz ls", "Authorization:*** ls"),
            (
                "git clone https://user:pass@github.com/x/y.git",
                "git clone https://***@github.com/x/y.git",
            ),
            (
                "echo 0123456789abcdef0123456789abcdef0123456789abcdef",
                "echo ***",
            ),
            (
                "echo dGhpcyBpcyBhIHZlcnkgbG9uZyBiYXNlNjQgc3RyaW5nMTIz==",
                "echo ***",
            ),
            // 长但没有数字的词不是凭据（比如一个长标识符）
            (
                "cargo test nested_session_roots_use_nearest_owner_independent_of_input_order",
                "cargo test nested_session_roots_use_nearest_owner_independent_of_input_order",
            ),
            ("cargo build --release", "cargo build --release"),
            ("rg  foo   src", "rg foo src"),
            ("secret", "secret"),
            ("--key=", "--key="),
            ("COOKIE=a=b ls", "COOKIE=*** ls"),
            ("ls token", "ls token"),
            ("x=1 y=2 z=3", "x=1 y=2 z=3"),
        ];
        for (input, expected) in cases {
            assert_eq!(redact(input), expected, "input: {input:?}");
        }
    }

    #[test]
    fn redact_truncates_to_limit() {
        let long = "a ".repeat(400);
        let out = redact(&long);
        assert!(out.chars().count() <= REDACTED_MAX_CHARS + 1);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn redact_never_leaks_token_value() {
        let out = redact("cargo run -- --token=SECRETVALUE123 --other=ok");
        assert!(!out.contains("SECRETVALUE123"));
        assert!(out.contains("--other=ok"));
    }
}
