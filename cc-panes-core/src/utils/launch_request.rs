use crate::models::{CreateSessionRequest, WslLaunchInfo};
use tracing::warn;

pub fn normalize_session_request_for_current_host(
    request: CreateSessionRequest,
) -> CreateSessionRequest {
    normalize_session_request_for_host(request, running_under_wsl())
}

pub fn normalize_session_request_for_host(
    mut request: CreateSessionRequest,
    running_under_wsl: bool,
) -> CreateSessionRequest {
    if !running_under_wsl || request.ssh.is_some() {
        return request;
    }

    if let Some(wsl) = request.wsl.take() {
        let project_path = non_empty(&wsl.remote_path)
            .map(expand_home_path)
            .unwrap_or_else(|| {
                normalize_path_for_wsl(&request.project_path).unwrap_or(request.project_path)
            });
        request.workspace_path =
            normalize_workspace_path_for_wsl(request.workspace_path.take(), &project_path, &wsl);
        request.project_path = project_path;
        return request;
    }

    request.project_path =
        normalize_path_for_wsl(&request.project_path).unwrap_or(request.project_path);
    request.workspace_path = request
        .workspace_path
        .take()
        .map(|path| normalize_path_for_wsl(&path).unwrap_or(path));
    request
}

fn normalize_workspace_path_for_wsl(
    workspace_path: Option<String>,
    project_path: &str,
    wsl: &WslLaunchInfo,
) -> Option<String> {
    if let Some(remote_path) = wsl.workspace_remote_path.as_deref().and_then(non_empty) {
        return Some(expand_home_path(remote_path));
    }

    let workspace_path = workspace_path?;
    let normalized = normalize_path_for_wsl(&workspace_path).unwrap_or(workspace_path);
    if is_same_or_parent_path(&normalized, project_path) {
        Some(normalized)
    } else {
        None
    }
}

fn normalize_path_for_wsl(path: &str) -> Option<String> {
    windows_drive_path_to_wsl(path).or_else(|| wsl_unc_path_to_posix(path))
}

fn windows_drive_path_to_wsl(path: &str) -> Option<String> {
    let normalized = path.trim().trim_matches('"').replace('\\', "/");
    let path = normalized
        .strip_prefix("//?/")
        .or_else(|| normalized.strip_prefix("//./"))
        .unwrap_or(&normalized);
    let bytes = path.as_bytes();
    if bytes.len() < 2 || bytes[1] != b':' {
        return None;
    }

    let drive = (bytes[0] as char).to_ascii_lowercase();
    if !drive.is_ascii_alphabetic() {
        return None;
    }

    let rest = path[2..].trim_start_matches('/');
    if rest.is_empty() {
        Some(format!("/mnt/{drive}"))
    } else {
        Some(format!("/mnt/{drive}/{rest}"))
    }
}

fn wsl_unc_path_to_posix(path: &str) -> Option<String> {
    let normalized = path.trim().trim_matches('"').replace('\\', "/");
    let without_slashes = normalized.trim_start_matches('/');
    let lower = without_slashes.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("wsl.localhost/")
        .or_else(|| lower.strip_prefix("wsl$/"))
        .or_else(|| lower.strip_prefix("wsl/"))?;

    let host_prefix_len = without_slashes.len() - rest.len();
    let rest_original = &without_slashes[host_prefix_len..];
    let mut parts = rest_original.splitn(2, '/');
    let distro = parts.next().unwrap_or_default();
    if distro.trim().is_empty() {
        return None;
    }
    let remote_path = parts.next().unwrap_or_default().trim_start_matches('/');
    if remote_path.is_empty() {
        Some("/".to_string())
    } else {
        Some(format!("/{remote_path}"))
    }
}

fn expand_home_path(path: &str) -> String {
    let path = path.trim();
    if path == "~" {
        return dirs::home_dir()
            .map(|home| home.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string());
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return dirs::home_dir()
            .map(|home| home.join(rest).to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string());
    }
    path.to_string()
}

fn is_same_or_parent_path(parent: &str, child: &str) -> bool {
    let parent = parent.trim_end_matches('/');
    let child = child.trim_end_matches('/');
    if parent.is_empty() || child.is_empty() {
        return false;
    }
    if parent == "/" {
        return child.starts_with('/');
    }
    child == parent || child.starts_with(&format!("{parent}/"))
}

fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn running_under_wsl() -> bool {
    std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .map(|release| {
            let release = release.to_ascii_lowercase();
            release.contains("microsoft") || release.contains("wsl")
        })
        .unwrap_or(false)
}

/// 继承来的 locale 不是 UTF-8 时，给会话补一组 UTF-8 locale。
///
/// macOS 从 Finder/Dock 启动的 GUI 应用**不继承** shell 的 locale（Terminal.app 是靠
/// 「启动时设置 locale 环境变量」那个选项才有的）。于是 app 自身与它拉起的每个本地
/// PTY 都跑在 `LC_CTYPE=C` 下，依赖 locale 判断字符边界/显示宽度的程序会把多字节文本
/// 算错——实测该 locale 下 `wc -m "中文测试"` 返回 12（字节）而非 4（字符）。
///
/// 判据与 WSL Codex 那条路径（`wsl_codex.rs` 注入的 shell 片段）一致：已经是 UTF-8
/// 就一律不动。
///
/// **只补 `LANG`，绝不设 `LC_ALL`。** `LC_ALL` 是 POSIX 里优先级最高的总覆盖，会碾平
/// 用户自己设的每一个 `LC_*` 细分类别（`LC_TIME` / `LC_COLLATE` / `LC_NUMERIC`…）。
/// WSL 那段是一次性 bootstrap 脚本，强制无妨；搬到常驻 PTY 环境就成了误伤。`LANG`
/// 是**最低优先级的兜底**，只填补没被显式设置的类别，正是这里需要的层级。
///
/// 值取 `C.UTF-8` 而非某个具体语言：只改字符集、不引入某个地区的排序与格式约定。
/// 万一目标系统没有该 locale，setlocale 会退回 C —— 与不打这个补丁的现状相同，
/// 不会更糟。
pub fn ensure_utf8_locale(env: &mut std::collections::HashMap<String, String>) {
    const UTF8_LOCALE: &str = "C.UTF-8";

    // 判定顺序对齐 shell 的 ${LC_ALL:-${LC_CTYPE:-${LANG:-}}}：字符集由 LC_CTYPE 管，
    // 它被显式设过就说明用户有主张，不该被 LANG 兜底覆盖掉。
    let effective = ["LC_ALL", "LC_CTYPE", "LANG"]
        .into_iter()
        .find_map(|key| {
            env.get(key)
                .cloned()
                .or_else(|| std::env::var(key).ok())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_default();

    let normalized = effective.to_ascii_lowercase();
    if normalized.ends_with("utf-8") || normalized.ends_with("utf8") {
        return;
    }

    // 读的时候按 POSIX 优先级取，写的时候只写最低优先级的 LANG——当"非 UTF-8"的来源
    // 正是 LC_ALL / LC_CTYPE 本身时，注入会被它们压制、本次修复**静默失效**（实测
    // `env LC_ALL=C LANG=C.UTF-8 wc -m` 仍按字节计数）。
    //
    // 仍然不强写 LC_ALL：那会碾平用户每一个 LC_* 细分设置，代价大于收益。但静默失效
    // 更糟——用户会以为修好了。故留一条日志让它可诊断。有人会在 profile 里
    // `export LC_ALL=C` 求脚本输出稳定，正是这类人会撞上。
    if let Some((key, value)) = ["LC_ALL", "LC_CTYPE"].into_iter().find_map(|key| {
        env.get(key)
            .cloned()
            .or_else(|| std::env::var(key).ok())
            .filter(|value| !value.is_empty())
            .map(|value| (key, value))
    }) {
        warn!(
            blocked_by = key,
            value = %value,
            "UTF-8 locale 注入被更高优先级的 {key} 压制，本会话仍按非 UTF-8 处理多字节文本"
        );
    }

    env.insert("LANG".to_string(), UTF8_LOCALE.to_string());
}

/// 出生锚点：会话在**创建时刻**就被指定的 tab / terminal-pane id。
///
/// 这两个 id 由创建方预先分配、随 launch 事件下发，前端**原样采用**（不再自己
/// `generateId`），因此它们是可核对的真实数据，而不是为了凑满校验而造的占位值。
///
/// 不含 `layout_id`：会话落在哪个布局由前端按「显式 layoutId > layoutName >
/// 父会话所在布局 > 工作空间绑定 > 当前布局」解析，创建方无从得知；而 layout
/// 恰恰是会合法移动的那一维，本就不属于出生事实。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BirthAnchors {
    pub tab_id: String,
    pub terminal_pane_id: String,
}

/// 分配一组出生锚点。前缀与前端 `paneTree.ts` 的 `generateId` 约定一致，
/// 保证两侧 id 形态同源。
pub fn mint_birth_anchors() -> BirthAnchors {
    BirthAnchors {
        tab_id: format!("tab-{}", uuid::Uuid::new_v4()),
        terminal_pane_id: format!("terminal-pane-{}", uuid::Uuid::new_v4()),
    }
}

#[cfg(test)]
mod tests {
    use crate::models::{CliTool, LaunchProviderSelection};

    use super::*;

    fn request(project_path: &str) -> CreateSessionRequest {
        CreateSessionRequest {
            launch_id: None,
            project_path: project_path.to_string(),
            cols: 120,
            rows: 30,
            workspace_name: Some("workspace".to_string()),
            provider_id: None,
            model_id: None,
            provider_selection: LaunchProviderSelection::Inherit,
            launch_profile_id: None,
            workspace_path: None,
            workspace_snapshot_id: None,
            origin_layout_id: None,
            origin_tab_id: None,
            origin_terminal_pane_id: None,
            expected_saved_session_id: None,
            launch_claude: false,
            cli_tool: CliTool::Claude,
            resume_id: None,
            skip_mcp: false,
            append_system_prompt: None,
            initial_prompt: None,
            yolo_mode: None,
            adapter_options: None,
            extra_env: None,
            ssh: None,
            wsl: None,
        }
    }

    #[test]
    fn preserves_wsl_launch_on_non_wsl_host() {
        let mut req = request("D:/workspace/repo");
        req.workspace_path = Some("D:/workspace".to_string());
        req.wsl = Some(WslLaunchInfo {
            remote_path: "/mnt/d/workspace/repo".to_string(),
            workspace_remote_path: Some("/mnt/d/workspace".to_string()),
            distro: Some("Ubuntu".to_string()),
        });

        let normalized = normalize_session_request_for_host(req, false);

        assert!(normalized.wsl.is_some());
        assert_eq!(normalized.project_path, "D:/workspace/repo");
        assert_eq!(normalized.workspace_path.as_deref(), Some("D:/workspace"));
    }

    #[test]
    fn converts_wsl_launch_to_local_paths_when_web_runs_inside_wsl() {
        let mut req = request("D:/workspace/repo");
        req.workspace_path = Some("D:/workspace".to_string());
        req.wsl = Some(WslLaunchInfo {
            remote_path: "/mnt/d/workspace/repo".to_string(),
            workspace_remote_path: Some("/mnt/d/workspace".to_string()),
            distro: Some("Ubuntu".to_string()),
        });

        let normalized = normalize_session_request_for_host(req, true);

        assert!(normalized.wsl.is_none());
        assert_eq!(normalized.project_path, "/mnt/d/workspace/repo");
        assert_eq!(
            normalized.workspace_path.as_deref(),
            Some("/mnt/d/workspace")
        );
    }

    #[test]
    fn clears_windows_workspace_path_when_it_is_not_the_wsl_parent() {
        let mut req = request("D:/workspace/repo");
        req.workspace_path = Some("D:/workspace".to_string());
        req.wsl = Some(WslLaunchInfo {
            remote_path: "/home/dev/repo".to_string(),
            workspace_remote_path: None,
            distro: Some("Ubuntu".to_string()),
        });

        let normalized = normalize_session_request_for_host(req, true);

        assert_eq!(normalized.project_path, "/home/dev/repo");
        assert!(normalized.workspace_path.is_none());
        assert!(normalized.wsl.is_none());
    }

    #[test]
    fn converts_local_windows_paths_when_web_runs_inside_wsl() {
        let mut req = request("D:\\workspace\\repo");
        req.workspace_path = Some("D:\\workspace".to_string());

        let normalized = normalize_session_request_for_host(req, true);

        assert_eq!(normalized.project_path, "/mnt/d/workspace/repo");
        assert_eq!(
            normalized.workspace_path.as_deref(),
            Some("/mnt/d/workspace")
        );
    }

    #[test]
    fn converts_wsl_unc_paths_to_posix_paths() {
        assert_eq!(
            normalize_path_for_wsl(r#"\\wsl.localhost\Ubuntu\home\dev\repo"#).as_deref(),
            Some("/home/dev/repo")
        );
    }

    #[test]
    fn leaves_an_existing_utf8_locale_alone() {
        for existing in ["en_US.UTF-8", "zh_CN.utf8", "C.UTF-8"] {
            let mut env =
                std::collections::HashMap::from([("LANG".to_string(), existing.to_string())]);

            ensure_utf8_locale(&mut env);

            // 用户特意设的区域不能被覆盖：只有非 UTF-8 才补。
            assert_eq!(env.get("LANG").map(String::as_str), Some(existing));
            assert_eq!(env.get("LC_ALL"), None);
            assert_eq!(env.get("LC_CTYPE"), None);
        }
    }

    #[test]
    fn fills_in_utf8_when_the_inherited_locale_is_not() {
        // LC_CTYPE=C 正是 macOS GUI 应用（Finder/Dock 启动）拉起会话时的实际形态。
        let mut env = std::collections::HashMap::from([("LANG".to_string(), "C".to_string())]);

        ensure_utf8_locale(&mut env);

        assert_eq!(env.get("LANG").map(String::as_str), Some("C.UTF-8"));
        // LC_ALL 会碾平用户每一个 LC_* 细分设置，兜底绝不能用它。
        assert_eq!(env.get("LC_ALL"), None);
    }

    #[test]
    fn never_overrides_user_lc_categories() {
        let mut env = std::collections::HashMap::from([
            ("LANG".to_string(), "C".to_string()),
            ("LC_TIME".to_string(), "zh_CN.UTF-8".to_string()),
            ("LC_COLLATE".to_string(), "zh_CN.UTF-8".to_string()),
        ]);

        ensure_utf8_locale(&mut env);

        assert_eq!(env.get("LANG").map(String::as_str), Some("C.UTF-8"));
        assert_eq!(env.get("LC_TIME").map(String::as_str), Some("zh_CN.UTF-8"));
        assert_eq!(
            env.get("LC_COLLATE").map(String::as_str),
            Some("zh_CN.UTF-8")
        );
        assert_eq!(env.get("LC_ALL"), None);
    }

    #[test]
    fn respects_an_explicit_lc_ctype() {
        // 字符集归 LC_CTYPE 管；用户显式设了就是有主张，不该被 LANG 兜底盖过去。
        let mut env = std::collections::HashMap::from([
            ("LC_CTYPE".to_string(), "en_US.UTF-8".to_string()),
            ("LANG".to_string(), "C".to_string()),
        ]);

        ensure_utf8_locale(&mut env);

        assert_eq!(env.get("LANG").map(String::as_str), Some("C"));
    }

    #[test]
    fn lc_all_wins_over_lang_when_deciding() {
        // 与 shell 的 ${LC_ALL:-${LANG:-}} 同序：LC_ALL 已是 UTF-8 就不该因 LANG 而改写。
        let mut env = std::collections::HashMap::from([
            ("LC_ALL".to_string(), "en_US.UTF-8".to_string()),
            ("LANG".to_string(), "C".to_string()),
        ]);

        ensure_utf8_locale(&mut env);

        assert_eq!(env.get("LANG").map(String::as_str), Some("C"));
        assert_eq!(env.get("LC_ALL").map(String::as_str), Some("en_US.UTF-8"));
    }

    /// 前缀必须与前端 `paneTree.ts` 的 `generateId` 约定一致：前端会把这两个 id
    /// 原样用作 tab / leaf 的 id，形态不同源会让日志和排查凭空多一层歧义。
    #[test]
    fn mints_anchors_with_frontend_id_prefixes() {
        let anchors = mint_birth_anchors();

        assert!(anchors.tab_id.starts_with("tab-"), "{}", anchors.tab_id);
        assert!(
            anchors.terminal_pane_id.starts_with("terminal-pane-"),
            "{}",
            anchors.terminal_pane_id
        );
    }

    /// 每次调用都必须是新的一组：复用会让两条会话的出生凭证撞在一起，
    /// 恢复期就分不出谁是谁。
    #[test]
    fn mints_unique_anchors_per_call() {
        let first = mint_birth_anchors();
        let second = mint_birth_anchors();

        assert_ne!(first.tab_id, second.tab_id);
        assert_ne!(first.terminal_pane_id, second.terminal_pane_id);
        assert_ne!(first.tab_id, first.terminal_pane_id);
    }
}
