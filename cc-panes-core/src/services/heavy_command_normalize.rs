//! 重负载命令的归一化与脱敏（纯函数，台账唯一允许落盘的两种形态）。
//!
//! 隐私红线同 `system_stats_service/diagnostics.rs`：**原始命令行绝不落盘**。
//! - [`normalize`]：聚合键。去掉前导 `cd … &&` / 环境赋值 / 包管理器前缀，取首段
//!   前两个 token（`cargo test -p x` → `cargo test`，`rg foo src` → `rg`）。
//! - [`redact`]：给人看的那一行。掩掉 token/key/secret/password/authorization
//!   的值（`k=v` / `k:v` / `--flag v` / `-H "Authorization: Bearer v"` / `curl -u u:p` /
//!   `mysql -pSECRET`）、URL 里的凭据、≥32 位的 base64/hex/JWT 串，并截断到
//!   [`REDACTED_MAX_CHARS`]。宁可多掩：这一行只用来认出是哪条命令。

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
    redact(&normalize_command(command))
}

fn normalize_command(command: &str) -> String {
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
    if head.contains('=') || head.starts_with('$') {
        return "(assignment)".into();
    }
    let head = base_name(head);
    if head.is_empty() {
        return "(empty)".to_string();
    }
    if SINGLE_TOKEN_COMMANDS.contains(&head.as_str()) {
        return head;
    }
    match rest.first() {
        Some(sub) if trusted_subcommand(&head, sub) => {
            format!("{head} {}", sub.to_ascii_lowercase())
        }
        _ => head,
    }
}

/// `-p` 紧贴密码的命令（`mysql -pSECRET`、`7z -pSECRET`）。只对这些命令掩 `-p`：
/// `cargo test -p crate` 的 `-p` 是包名，掩掉就认不出是哪条命令了。
const PASSWORD_P_COMMANDS: &[&str] = &[
    "mysql",
    "mysqladmin",
    "mysqldump",
    "mariadb",
    "mariadb-dump",
    "sshpass",
    "smbclient",
    "7z",
    "7za",
    "7zr",
    "rar",
    "unrar",
];

/// 下一 token 该怎么掩。
#[derive(Clone, Copy, PartialEq, Eq)]
enum NextToken {
    Keep,
    /// 整个值掩掉（`--password x` / `Bearer x`）。
    Mask,
    /// `user:pass` 只掩冒号后（`curl -u u:p`）。
    MaskUserPass,
}

/// 脱敏并截断。输出可安全落盘 / 回传前端。
pub fn redact(command: &str) -> String {
    let mut out = String::with_capacity(command.len());
    let head = command_head(command);
    let password_p = PASSWORD_P_COMMANDS.contains(&head.as_str());
    let assignment = matches!(head.as_str(), "export" | "set" | "setx" | "declare");
    let mut next = NextToken::Keep;
    for (index, token) in quoted_tokens(command).into_iter().enumerate() {
        if index > 0 {
            out.push(' ');
        }
        let bare = token.trim_matches(|c| c == '"' || c == '\'');
        // `Bearer` / `Basic` 本身保留，掩它后面那个。
        if bare.eq_ignore_ascii_case("bearer") || bare.eq_ignore_ascii_case("basic") {
            out.push_str(token);
            next = NextToken::Mask;
            continue;
        }
        if bare == "=" && next == NextToken::Mask {
            out.push_str(token);
            continue;
        }
        // 宣告了"下一个是值"但来的是另一个 flag：没有值，不吞。
        let is_flag = bare.starts_with('-') && bare.len() > 1;
        match next {
            NextToken::Mask if !is_flag => {
                out.push_str(&mask_value(token));
                next = NextToken::Keep;
                continue;
            }
            NextToken::MaskUserPass if !is_flag => {
                out.push_str(&mask_user_pass(token));
                next = NextToken::Keep;
                continue;
            }
            _ => {}
        }
        next = if assignment && is_sensitive_key(bare) && !bare.contains('=') {
            NextToken::Mask
        } else {
            next_token_rule(bare, password_p)
        };
        out.push_str(&redact_token(token, bare, password_p));
    }
    truncate_chars(&out, REDACTED_MAX_CHARS)
}

/// 本 token 是否宣告"下一个是值"：`--password` / `-H` 后的 `Authorization:` /
/// `-u` / `-p`（仅密码类命令）。带 `=` 的是 glued 形态，不影响下一个。
fn next_token_rule(bare: &str, password_p: bool) -> NextToken {
    if let Some((key, value)) = bare.split_once('=') {
        return if value.is_empty() && is_sensitive_key(key) {
            NextToken::Mask
        } else {
            NextToken::Keep
        };
    }
    if bare.starts_with("$env:") && is_sensitive_key(bare) {
        return NextToken::Mask;
    }
    if bare == "-u" || bare == "--user" {
        return NextToken::MaskUserPass;
    }
    if password_p && bare == "-p" {
        return NextToken::Mask;
    }
    if let Some(key) = bare.strip_suffix(':') {
        // `"Authorization:` → 下一个是 `Bearer`（会再顺延一个）或裸值。
        if is_sensitive_key(key) {
            return NextToken::Mask;
        }
    }
    if bare.starts_with("--") && is_sensitive_key(bare) {
        return NextToken::Mask;
    }
    NextToken::Keep
}

fn redact_token(token: &str, bare: &str, password_p: bool) -> String {
    // Keep an entire quoted header/value together, including spaces in secrets.
    if let Some((key, value)) = token.split_once(':') {
        if is_sensitive_key(key) && value.starts_with(' ') {
            let value = value.trim_start();
            let scheme = ["Bearer ", "Basic "]
                .into_iter()
                .find(|scheme| value.starts_with(scheme))
                .unwrap_or("");
            let close = token
                .chars()
                .last()
                .filter(|c| matches!(c, '\'' | '"'))
                .map(|c| c.to_string())
                .unwrap_or_default();
            return format!("{key}: {scheme}{MASK}{close}");
        }
    }

    // URL 凭据：scheme://user:pass@host
    if let Some(scheme_end) = token.find("://") {
        let (scheme, rest) = token.split_at(scheme_end + 3);
        if let Some(at) = rest.find('@') {
            let (_, host) = rest.split_at(at);
            return format!("{scheme}{MASK}{host}");
        }
    }
    // `--user=u:p` / `-uu:p`
    if let Some(value) = bare
        .strip_prefix("--user=")
        .or_else(|| bare.strip_prefix("-u").filter(|rest| rest.contains(':')))
    {
        let prefix = &bare[..bare.len() - value.len()];
        return format!("{prefix}{}", mask_user_pass(value));
    }
    // `mysql -pSECRET`
    if password_p && bare.len() > 2 && bare.starts_with("-p") && !bare.starts_with("--") {
        return format!("-p{MASK}");
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
    if is_long_opaque(bare) {
        return mask_value(token);
    }
    token.to_string()
}

/// 掩整个值，保留两端引号（`"x"` → `"***"`，`x"` → `***"`），行看起来还是那条命令。
fn mask_value(token: &str) -> String {
    let open = token
        .chars()
        .next()
        .filter(|c| *c == '"' || *c == '\'')
        .map(|c| c.to_string())
        .unwrap_or_default();
    let close = token
        .chars()
        .last()
        .filter(|c| (*c == '"' || *c == '\'') && token.len() > 1)
        .map(|c| c.to_string())
        .unwrap_or_default();
    format!("{open}{MASK}{close}")
}

/// `user:pass` → `user:***`；没有冒号就原样（只有用户名）。
fn mask_user_pass(token: &str) -> String {
    match token.split_once(':') {
        Some((user, pass)) if !pass.is_empty() => {
            let close = pass
                .chars()
                .last()
                .filter(|c| *c == '"' || *c == '\'')
                .map(|c| c.to_string())
                .unwrap_or_default();
            format!("{user}:{MASK}{close}")
        }
        _ => token.to_string(),
    }
}

/// 第一段的命令名（跳过环境赋值与 runner 前缀），供 `-p` 规则判断。
fn command_head(command: &str) -> String {
    let tokens = tokenize(split_first_segment(command));
    tokens
        .iter()
        .map(|token| base_name(token))
        .find(|name| !is_env_assignment(name) && !RUNNER_PREFIXES.contains(&name.as_str()))
        .unwrap_or_default()
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

/// ≥32 位且只由 base64 / base64url / hex / JWT 字符组成的串，视为凭据。
/// `.` 允许是为了 JWT（`eyJ….eyJ….sig`）；带 `.` 的同时带路径分隔符的是文件路径，不掩。
/// 以 `-` 开头的是长选项，不掩。
fn is_long_opaque(token: &str) -> bool {
    if token.starts_with("eyJ") && token.matches('.').count() == 2 {
        return true;
    }
    let body = token.trim_end_matches('=');
    let looks_like_path = body.contains('.') && (body.contains('/') || body.contains('\\'));
    body.len() >= 32
        && !body.starts_with('-')
        && !looks_like_path
        && body
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '-' | '_' | '.'))
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

/// Preserve quoted spans so a secret containing whitespace cannot leak a suffix.
fn quoted_tokens(input: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let mut start = None;
    let mut quote = None;
    let mut escaped = false;
    for (index, ch) in input.char_indices() {
        if ch.is_whitespace() && quote.is_none() && !escaped {
            if let Some(start) = start.take() {
                tokens.push(&input[start..index]);
            }
            continue;
        }
        start.get_or_insert(index);
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if Some(ch) == quote {
            quote = None;
        } else if quote.is_none() && matches!(ch, '\'' | '"') {
            quote = Some(ch);
        }
    }
    if let Some(start) = start {
        tokens.push(&input[start..]);
    }
    tokens
}

fn tokenize(segment: &str) -> Vec<String> {
    quoted_tokens(segment)
        .into_iter()
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

fn trusted_subcommand(command: &str, sub: &str) -> bool {
    let verbs: &[&str] = match command {
        "cargo" => &[
            "build", "check", "test", "clippy", "doc", "run", "fmt", "clean", "install", "bench",
            "metadata", "update", "fetch",
        ],
        "git" => &[
            "status", "diff", "log", "show", "clone", "fetch", "pull", "push", "add", "commit",
            "checkout", "switch", "worktree", "branch", "merge", "rebase",
        ],
        "docker" => &[
            "build",
            "compose",
            "run",
            "exec",
            "pull",
            "push",
            "image",
            "container",
        ],
        "go" | "dotnet" => &["build", "test", "run", "restore", "publish", "install"],
        _ => &[],
    };
    verbs.contains(&sub.to_ascii_lowercase().as_str())
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
    fn credentials_never_survive_either_ledger_field() {
        for command in [
            "export API_KEY=synthetic-secret-123",
            "set DATABASE_PASSWORD=synthetic-secret-123",
            "setx TOKEN \"synthetic secret value\"",
            "$env:API_KEY = 'synthetic secret value'",
            "mysql --password=\"synthetic secret value\" -e select",
            "mysql --password 'synthetic secret value'",
            "arbitrary-tool synthetic-secret-123",
        ] {
            assert!(
                !normalize(command).contains("synthetic"),
                "aggregate: {command}"
            );
            if !command.starts_with("arbitrary-tool") {
                assert!(!redact(command).contains("synthetic"), "display: {command}");
            }
        }
    }

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
            // 带路径分隔符的长文件名不是凭据（允许 `.` 之后的回归守卫）
            (
                "cat docs/107-performance-plan-0.12.22-with-a-long-name.md",
                "cat docs/107-performance-plan-0.12.22-with-a-long-name.md",
            ),
            (
                "rg foo --glob=!node_modules/**/dist-2024-01-01-build-output-x",
                "rg foo --glob=!node_modules/**/dist-2024-01-01-build-output-x",
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(redact(input), expected, "input: {input:?}");
        }
    }

    /// 敏感 flag 后面单独一个值 token 的形态（审查发现 #6）。
    #[test]
    fn redact_masks_separate_value_tokens() {
        let cases = [
            ("mysql --password hunter2 -e x", "mysql --password *** -e x"),
            (
                "cargo run -- --token abc --other ok",
                "cargo run -- --token *** --other ok",
            ),
            ("foo --api-key sk-123 bar", "foo --api-key *** bar"),
            ("foo --secret-file path.txt", "foo --secret-file ***"),
            // 值紧跟 `=` 的 glued 形态不影响下一个 token
            ("foo --token=abc next", "foo --token=*** next"),
            // `-p` 只对密码类命令生效；cargo 的 -p 是包名
            ("mysql -p hunter2 db", "mysql -p *** db"),
            ("mysql -phunter2 db", "mysql -p*** db"),
            ("7z x -pS3cret a.7z", "7z x -p*** a.7z"),
            ("cargo test -p cc-panes-core", "cargo test -p cc-panes-core"),
            ("cargo test -pcc-panes-core", "cargo test -pcc-panes-core"),
            ("sudo mysql -pxyz", "sudo mysql -p***"),
            // 敏感 flag 后面已经是另一个 flag：没有值，不吞
            ("--password --other", "--password --other"),
            ("mysql -p -e x", "mysql -p -e x"),
        ];
        for (input, expected) in cases {
            assert_eq!(redact(input), expected, "input: {input:?}");
        }
    }

    /// `-H "Authorization: Bearer x"` / `Basic x`：掩 `Bearer` 之后那个。
    #[test]
    fn redact_masks_authorization_header_values() {
        let cases = [
            (
                r#"curl -H "Authorization: Bearer abc.def" https://x"#,
                r#"curl -H "Authorization: Bearer ***" https://x"#,
            ),
            (
                "curl -H 'Authorization: Basic dXNlcjpwYXNz' https://x",
                "curl -H 'Authorization: Basic ***' https://x",
            ),
            (
                "curl -H Authorization:Bearer-xyz",
                "curl -H Authorization:***",
            ),
            // 没有 Bearer 的裸头值
            (
                r#"curl -H "X-Api-Key: abc123" https://x"#,
                r#"curl -H "X-Api-Key: ***" https://x"#,
            ),
            ("echo Bearer abc", "echo Bearer ***"),
        ];
        for (input, expected) in cases {
            assert_eq!(redact(input), expected, "input: {input:?}");
        }
    }

    /// `curl -u user:pass` → `user:***`，三种拼法。
    #[test]
    fn redact_masks_basic_auth_user_pass() {
        let cases = [
            (
                "curl -u alice:hunter2 https://x",
                "curl -u alice:*** https://x",
            ),
            (
                "curl --user alice:hunter2 https://x",
                "curl --user alice:*** https://x",
            ),
            (
                "curl --user=alice:hunter2 https://x",
                "curl --user=alice:*** https://x",
            ),
            (
                "curl -ualice:hunter2 https://x",
                "curl -ualice:*** https://x",
            ),
            (r#"curl -u "alice:hunter2" x"#, r#"curl -u "alice:***" x"#),
            // 只有用户名：原样
            ("curl -u alice https://x", "curl -u alice https://x"),
        ];
        for (input, expected) in cases {
            assert_eq!(redact(input), expected, "input: {input:?}");
        }
    }

    /// JWT（三段 base64url，带 `.`）必须被掩。
    #[test]
    fn redact_masks_jwt_tokens() {
        let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
        assert_eq!(redact(&format!("curl -H x {jwt}")), "curl -H x ***");
        assert_eq!(
            redact(&format!("echo \"{jwt}\"")),
            "echo \"***\"",
            "quotes stay, value goes"
        );
        // 短一点但仍是三段 eyJ 的也掩
        assert_eq!(redact("echo eyJa.eyJb.c"), "echo ***");
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
