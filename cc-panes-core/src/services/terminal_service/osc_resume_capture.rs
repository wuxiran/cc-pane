//! Codex 会话 id 的 OSC 标题捕获。
//!
//! CC-Panes 启动 Codex 时注入 `-c tui.terminal_title=["activity","project","thread-id"]`，
//! Codex 会把活跃线程 id 写入终端标题（OSC 0/2 序列，混在 PTY 输出流里）。
//! 本模块在 PTY 读线程中扫描这些序列，提取 thread-id 前缀（上游对每个标题项
//! 截断到 32 字符含省略号，36 字符的 UUID 必然只剩 29 字符前缀），再用前缀对
//! `~/.codex/sessions` 的 rollout 文件名做精确前缀匹配解析出完整 id——
//! 这是身份匹配而非 mtime 猜测，并发启动也不会串。
//!
//! 时序特性：标题在 TUI 启动后约 1-2 秒出现；rollout 文件在首轮对话才落盘，
//! 因此解析按输出活动节流重试，首轮完成后必然命中。信任弹窗会导致线程 id
//! 轮换，故始终以**最新**标题为准（不做首次命中即停）。

use crate::constants::events as EV;
use crate::events::EventEmitter;
use crate::utils::command::no_window_command;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tracing::{debug, info, warn};

/// 解析尝试之间的最小间隔（按输出活动节流）
const RESOLVE_THROTTLE: Duration = Duration::from_secs(2);
/// 解析尝试上限：超过后放弃（防止 rollout 永不出现的会话无限重扫目录）。
/// 节流 2s + 上限 240 ≈ 至少覆盖 8 分钟活跃输出，正常首轮远早于此完成。
const RESOLVE_MAX_ATTEMPTS: u32 = 240;
/// 跨 chunk 拼接保留的尾部字符数（足够容纳一条被截断的 OSC 标题序列）
const TAIL_CARRY_CHARS: usize = 96;
/// OSC 标题内容最大长度（防御异常输入）
const MAX_TITLE_LEN: usize = 256;
/// UUID 前缀最短可信长度（含 4 组：8-4-4-4 = 23 字符）
const MIN_PREFIX_LEN: usize = 23;
const FULL_UUID_LEN: usize = 36;

/// 会话启动上下文（emit 事件时回带，供后端落库）
#[derive(Clone)]
pub(super) struct OscCaptureContext {
    pub session_id: String,
    pub runtime_kind: String,
    pub launch_id: Option<String>,
    pub project_path: String,
    pub workspace_path: Option<String>,
    pub wsl_distro: Option<String>,
}

struct SharedState {
    /// 最新捕获的 thread-id 前缀（标题轮换时被替换）
    current_prefix: Mutex<Option<String>>,
    /// 已成功 emit 完整 id
    done: AtomicBool,
    /// 有解析线程在跑（避免并发扫描）
    in_flight: AtomicBool,
}

/// PTY 读线程持有的捕获器（仅 Codex 会话创建）
pub(super) struct OscResumeCapture {
    ctx: OscCaptureContext,
    emitter: Arc<dyn EventEmitter>,
    tail: String,
    last_seen_prefix: Option<String>,
    last_attempt: Option<Instant>,
    attempts: u32,
    shared: Arc<SharedState>,
}

impl OscResumeCapture {
    pub(super) fn new(ctx: OscCaptureContext, emitter: Arc<dyn EventEmitter>) -> Self {
        Self {
            ctx,
            emitter,
            tail: String::new(),
            last_seen_prefix: None,
            last_attempt: None,
            attempts: 0,
            shared: Arc::new(SharedState {
                current_prefix: Mutex::new(None),
                done: AtomicBool::new(false),
                in_flight: AtomicBool::new(false),
            }),
        }
    }

    /// 在 PTY 读线程中对每个输出 chunk 调用。开销：done 后仅一次原子读；
    /// 未命中标题时为一次子串扫描。
    pub(super) fn scan(&mut self, data: &str) {
        if self.shared.done.load(Ordering::Relaxed) {
            return;
        }

        let combined = if self.tail.is_empty() {
            data.to_string()
        } else {
            let mut s = std::mem::take(&mut self.tail);
            s.push_str(data);
            s
        };

        if let Some(prefix) = extract_last_title_uuid_prefix(&combined) {
            if prefix.len() >= FULL_UUID_LEN {
                // 标题未截断（上游行为变化时的快路径）：直接确定
                self.emit_resolved(&prefix[..FULL_UUID_LEN]);
                return;
            }
            if self.last_seen_prefix.as_deref() != Some(prefix.as_str()) {
                debug!(
                    session_id = %self.ctx.session_id,
                    prefix = %prefix,
                    "osc-capture: thread-id prefix detected in terminal title"
                );
                self.last_seen_prefix = Some(prefix.clone());
                if let Ok(mut guard) = self.shared.current_prefix.lock() {
                    *guard = Some(prefix);
                }
                // 新前缀：立即尝试解析（绕过节流）
                self.last_attempt = None;
            }
        }

        // 保留尾部用于跨 chunk 的序列拼接
        self.tail = combined
            .chars()
            .rev()
            .take(TAIL_CARRY_CHARS)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();

        let has_prefix = self.last_seen_prefix.is_some();
        let throttled = self
            .last_attempt
            .map(|t| t.elapsed() < RESOLVE_THROTTLE)
            .unwrap_or(false);
        if self.attempts >= RESOLVE_MAX_ATTEMPTS {
            if self.attempts == RESOLVE_MAX_ATTEMPTS {
                warn!(
                    session_id = %self.ctx.session_id,
                    prefix = ?self.last_seen_prefix,
                    attempts = self.attempts,
                    "osc-capture: giving up resolving full session id (rollout never appeared)"
                );
                self.attempts += 1; // 只告警一次
            }
            return;
        }
        if has_prefix && !throttled && !self.shared.in_flight.swap(true, Ordering::AcqRel) {
            self.last_attempt = Some(Instant::now());
            self.attempts += 1;
            self.spawn_resolver();
        }
    }

    fn emit_resolved(&self, full_id: &str) {
        if self.shared.done.swap(true, Ordering::AcqRel) {
            return;
        }
        emit_detected(&self.emitter, &self.ctx, full_id);
    }

    fn spawn_resolver(&self) {
        let shared = self.shared.clone();
        let ctx = self.ctx.clone();
        let emitter = self.emitter.clone();
        std::thread::spawn(move || {
            let prefix = shared
                .current_prefix
                .lock()
                .ok()
                .and_then(|guard| guard.clone());
            let Some(prefix) = prefix else {
                shared.in_flight.store(false, Ordering::Release);
                return;
            };

            let resolved = if ctx.runtime_kind == "wsl" {
                resolve_full_id_wsl(&prefix, ctx.wsl_distro.as_deref())
            } else {
                resolve_full_id_local(&prefix)
            };

            match resolved {
                Ok(Some(full_id)) => {
                    // 标题可能在解析期间轮换：只接受仍匹配当前前缀的结果
                    let still_current = shared
                        .current_prefix
                        .lock()
                        .ok()
                        .and_then(|guard| guard.clone())
                        .map(|current| full_id.starts_with(&current))
                        .unwrap_or(false);
                    if still_current && !shared.done.swap(true, Ordering::AcqRel) {
                        emit_detected(&emitter, &ctx, &full_id);
                    }
                }
                Ok(None) => {
                    // rollout 文件尚未生成（首轮未完成）：等下次输出活动重试
                    debug!(
                        session_id = %ctx.session_id,
                        prefix = %prefix,
                        "osc-capture: no rollout file matches prefix yet"
                    );
                }
                Err(error) => {
                    warn!(
                        session_id = %ctx.session_id,
                        prefix = %prefix,
                        error = %error,
                        "osc-capture: resolve full session id failed"
                    );
                }
            }
            shared.in_flight.store(false, Ordering::Release);
        });
    }
}

fn emit_detected(emitter: &Arc<dyn EventEmitter>, ctx: &OscCaptureContext, full_id: &str) {
    info!(
        session_id = %ctx.session_id,
        resume_session_id = %full_id,
        "osc-capture: codex thread id resolved from terminal title"
    );
    let _ = emitter.emit(
        EV::TERMINAL_RESUME_ID_DETECTED,
        serde_json::json!({
            "sessionId": ctx.session_id,
            "resumeSessionId": full_id,
            "source": "osc-title",
            "cliTool": "codex",
            "runtimeKind": ctx.runtime_kind,
            "launchId": ctx.launch_id,
            "projectPath": ctx.project_path,
            "workspacePath": ctx.workspace_path,
            "wslDistro": ctx.wsl_distro,
        }),
    );
}

/// 从输出流中提取**最后一条** OSC 0/2 标题里的 UUID（前缀）。
/// 取最后一条：信任弹窗等场景线程 id 会轮换，最新标题才是活跃线程。
fn extract_last_title_uuid_prefix(data: &str) -> Option<String> {
    let mut result = None;
    let bytes = data.as_bytes();
    let mut i = 0;
    while let Some(pos) = data[i..].find("\u{1b}]") {
        let start = i + pos;
        let rest = &data[start + 2..];
        // OSC 0 (icon+title) / 2 (title)
        let Some(body) = rest.strip_prefix("0;").or_else(|| rest.strip_prefix("2;")) else {
            i = start + 2;
            continue;
        };
        // 终止符：BEL 或 ST（ESC \）。这里把任意 ESC 当作标题结束（不校验后随 \\）：
        // 标题体内出现非 ST 的 ESC 属于异常序列，提前截断最多导致本条 uuid 形状
        // 校验不过而被跳过，后续标题会重试，不会误绑。未终止（chunk 截断）则留给 tail 拼接
        let end = body
            .char_indices()
            .take(MAX_TITLE_LEN)
            .find(|(_, c)| *c == '\u{7}' || *c == '\u{1b}')
            .map(|(idx, _)| idx);
        if let Some(end) = end {
            if let Some(uuid) = extract_uuid_like(&body[..end]) {
                result = Some(uuid);
            }
            i = start + 2 + end;
        } else {
            // 序列尚未完整到达
            break;
        }
        if i >= bytes.len() {
            break;
        }
    }
    result
}

/// 在标题文本中找 UUID 形状的子串（允许截断到 >= MIN_PREFIX_LEN）。
/// UUIDv7 形如 019eb24f-f78f-7c63-baba-b70f8...（破折号位于 8/13/18/23）。
fn extract_uuid_like(text: &str) -> Option<String> {
    let mut best: Option<String> = None;
    let chars: Vec<char> = text.chars().collect();
    let mut run_start = None;
    for (idx, &c) in chars.iter().chain(std::iter::once(&' ')).enumerate() {
        let is_uuid_char = c.is_ascii_hexdigit() && !c.is_ascii_uppercase() || c == '-';
        if is_uuid_char {
            run_start.get_or_insert(idx);
            continue;
        }
        if let Some(start) = run_start.take() {
            let run: String = chars[start..idx].iter().collect();
            let run = run.trim_end_matches('-');
            if is_uuid_shaped(run) {
                best = Some(run.to_string());
            }
        }
    }
    best
}

fn is_uuid_shaped(run: &str) -> bool {
    if run.len() < MIN_PREFIX_LEN || run.len() > FULL_UUID_LEN {
        return false;
    }
    for (idx, c) in run.char_indices() {
        let expect_dash = matches!(idx, 8 | 13 | 18 | 23);
        if expect_dash != (c == '-') {
            return false;
        }
    }
    true
}

/// 本地：扫 ~/.codex/sessions/YYYY/MM/DD 下的 rollout 文件名做前缀匹配
fn resolve_full_id_local(prefix: &str) -> Result<Option<String>, String> {
    let root = dirs::home_dir()
        .ok_or_else(|| "home dir not found".to_string())?
        .join(".codex")
        .join("sessions");
    if !root.exists() {
        return Ok(None);
    }
    let mut visited = 0usize;
    Ok(find_in_dir(&root, prefix, 0, &mut visited))
}

fn find_in_dir(dir: &Path, prefix: &str, depth: usize, visited: &mut usize) -> Option<String> {
    // sessions/YYYY/MM/DD/*.jsonl：最多 4 层
    if depth > 4 || *visited > 20_000 {
        return None;
    }
    let entries = std::fs::read_dir(dir).ok()?;
    // 倒序遍历让最近日期优先命中（目录名按日期排序）
    let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    paths.sort();
    for path in paths.into_iter().rev() {
        *visited += 1;
        if path.is_dir() {
            if let Some(found) = find_in_dir(&path, prefix, depth + 1, visited) {
                return Some(found);
            }
        } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if let Some(full_id) = extract_full_id_from_filename(name, prefix) {
                return Some(full_id);
            }
        }
    }
    None
}

/// WSL：在 distro 内 find 文件名含前缀的 rollout 文件
fn resolve_full_id_wsl(prefix: &str, distro: Option<&str>) -> Result<Option<String>, String> {
    // 前缀来自 UUID 形状校验，仅含 [0-9a-f-]，可安全内插到 shell 命令
    if !prefix.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err("invalid prefix".to_string());
    }
    let mut command = no_window_command("wsl.exe");
    if let Some(distro) = distro.filter(|d| !d.trim().is_empty()) {
        command.arg("-d").arg(distro);
    }
    let script =
        format!("find ~/.codex/sessions -name '*{prefix}*.jsonl' -print 2>/dev/null | head -n 1");
    command.arg("--").arg("bash").arg("-lc").arg(&script);
    let output = command
        .output()
        .map_err(|error| format!("wsl.exe spawn failed: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "wsl.exe find exited with {}: {}",
            output.status,
            stderr.trim().chars().take(200).collect::<String>()
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.trim();
    if line.is_empty() {
        return Ok(None);
    }
    let name = line.rsplit('/').next().unwrap_or(line);
    Ok(extract_full_id_from_filename(name, prefix))
}

/// resume 前预检：codex 会话库 `~/.codex/sessions` 里是否存在该完整 thread/session id 的 rollout 文件。
///
/// 用于启动 `codex resume <id>` 之前判断目标是否真实存在——不存在则回退为开新会话，
/// 避免拿"查无此文件"的 id 去 resume 导致 codex 报 `No saved session found` 秒退、pane 半残。
///
/// 返回：`Some(true)` 确定存在；`Some(false)` 确定不存在（包括 id 形状非法，或库里查无此文件——
/// 如被抓错的 v4 id `17b39c9d…` 不会有对应 rollout）；`None` 无法判定（检查本身失败，调用方
/// 应 fail-open，保留 resume 不误伤）。
///
/// `distro = Some(..)` 走 WSL 内 find；`distro = None` 扫本地 `~/.codex/sessions`。
// 生产调用方在 wsl_codex.rs（Windows-only 模块），Linux 下仅测试引用
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn codex_rollout_exists(full_id: &str, distro: Option<&str>) -> Option<bool> {
    // 必须是完整 UUID 形状（精确匹配，避免短前缀撞车，如 019ef31c 同时间戳前缀不同后缀）
    if full_id.len() != FULL_UUID_LEN || !is_uuid_shaped(full_id) {
        return Some(false);
    }
    let resolved = match distro {
        Some(distro) => resolve_full_id_wsl(full_id, Some(distro)),
        None => resolve_full_id_local(full_id),
    };
    match resolved {
        Ok(Some(_)) => Some(true),
        Ok(None) => Some(false),
        Err(_) => None,
    }
}

/// 从 rollout 文件名（rollout-<ts>-<uuid>.jsonl）提取以 prefix 开头的完整 UUID
fn extract_full_id_from_filename(name: &str, prefix: &str) -> Option<String> {
    let pos = name.find(prefix)?;
    let candidate: String = name[pos..].chars().take(FULL_UUID_LEN).collect();
    (candidate.len() == FULL_UUID_LEN && is_uuid_shaped(&candidate)).then_some(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_truncated_uuid_prefix_from_osc_title() {
        let data = "noise\u{1b}]0;019eb24f-f78f-7c63-baba-b70f8...\u{7}more";
        assert_eq!(
            extract_last_title_uuid_prefix(data).as_deref(),
            Some("019eb24f-f78f-7c63-baba-b70f8")
        );
    }

    #[test]
    fn takes_the_last_title_when_thread_rotates() {
        let data = "\u{1b}]0;019eb24f-1f0f-72f1-8fe0-c3f6a...\u{7}x\u{1b}]2;⠇ proj 019eb24f-f78f-7c63-baba-b70f8...\u{1b}\\";
        assert_eq!(
            extract_last_title_uuid_prefix(data).as_deref(),
            Some("019eb24f-f78f-7c63-baba-b70f8")
        );
    }

    #[test]
    fn ignores_titles_without_uuid() {
        let data = "\u{1b}]0;⠇ ccpanes-osc-test\u{7}";
        assert_eq!(extract_last_title_uuid_prefix(data), None);
    }

    #[test]
    fn unterminated_sequence_returns_none_until_completed() {
        let data = "\u{1b}]0;019eb24f-f78f-7c63-baba";
        assert_eq!(extract_last_title_uuid_prefix(data), None);
    }

    #[test]
    fn full_uuid_in_title_is_accepted() {
        let data = "\u{1b}]2;019eb24f-f78f-7c63-baba-b70f8aabbccd\u{7}";
        assert_eq!(
            extract_last_title_uuid_prefix(data).as_deref(),
            Some("019eb24f-f78f-7c63-baba-b70f8aabbccd")
        );
    }

    #[test]
    fn rejects_non_uuid_hex_runs() {
        assert!(!is_uuid_shaped("deadbeefdeadbeefdeadbeef"));
        assert!(is_uuid_shaped("019eb24f-f78f-7c63-baba-b70f8"));
        assert!(is_uuid_shaped("019eb24f-f78f-7c63-baba-b70f8aabbccd"));
        assert!(!is_uuid_shaped("019eb24f-f78f-7c63"));
    }

    #[test]
    fn extracts_full_id_from_rollout_filename() {
        let name = "rollout-2026-06-11T00-13-10-019eb24f-f78f-7c63-baba-b70f8aabbccd.jsonl";
        assert_eq!(
            extract_full_id_from_filename(name, "019eb24f-f78f-7c63-baba-b70f8").as_deref(),
            Some("019eb24f-f78f-7c63-baba-b70f8aabbccd")
        );
        assert_eq!(
            extract_full_id_from_filename(name, "019eb24f-aaaa").as_deref(),
            None
        );
    }

    #[test]
    fn codex_rollout_exists_rejects_malformed_id_shapes() {
        // 长度/形状非法的 id 直接判定不存在，不触发任何文件/WSL 查询（确定性）。
        assert_eq!(codex_rollout_exists("abc", Some("Ubuntu")), Some(false));
        assert_eq!(
            codex_rollout_exists("not-a-uuid-at-all-xxxxxxxxxxxxxxxxxxxx", None),
            Some(false)
        );
        // 完整长度但破折号位置不对 → 形状非法。
        assert_eq!(
            codex_rollout_exists("019eb24ff78f7c63babab70f8aabbccd0000ab", Some("Ubuntu")),
            Some(false)
        );
    }
}
