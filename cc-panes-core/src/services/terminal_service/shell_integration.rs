//! Shell 集成脚本注入（OSC 133 命令边界 + OSC 7 cwd）。
//!
//! 仅对**纯 shell 标签页**（cli_tool == none）生效：让 shell 主动发出
//! `OSC 133;C;<cmd>`（命令开始，osc_state_detect 据此识别 agent 启动）和
//! `OSC 133;D;<exit>`（命令结束 + 退出码），宿主无需解析 prompt 文本。
//! launch_task 直启的 CLI 会话没有 shell，状态信号走 hook 的 OSC 777 通道。
//!
//! 注入方式（参考 Terax pty/scripts/）：
//! - pwsh / powershell：`-NoExit -File <script>`，脚本包装用户 prompt 函数，
//!   每次出 prompt 时发 D + OSC 7（PowerShell 无原生 preexec，不发 C——
//!   检测器的武装来自 OSC 777，D 仍能携带 agent 退出码）
//! - bash / git-bash：`--rcfile <script>`，脚本先 source ~/.bashrc，
//!   DEBUG trap 发 C（ip 门控防 PROMPT_COMMAND 误触发），PROMPT_COMMAND 发 D
//! - zsh：`ZDOTDIR=<dir>`，转发用户 dotfiles 后挂 preexec/precmd 钩子
//! - cmd / fish / wsl：不注入（透传）
//!
//! 脚本每次启动覆盖写入 `<data_dir>/shell-integration/`，写失败不阻断启动。

use std::collections::HashMap;
use std::path::Path;
use tracing::warn;

const PWSH_SCRIPT: &str = r#"# CC-Panes shell integration: OSC 133;D (exit code) + OSC 7 (cwd).
# Overwritten by CC-Panes on every launch - do not edit.
if ($null -eq $global:__ccpanes_prompt) {
  $global:__ccpanes_prompt = $function:prompt
  function global:prompt {
    $__ec = if ($global:LASTEXITCODE -is [int]) { $global:LASTEXITCODE } elseif ($?) { 0 } else { 1 }
    $__e = [char]27
    $__p = ($executionContext.SessionState.Path.CurrentLocation.ProviderPath) -replace '\\', '/'
    [Console]::Write("$__e]133;D;$__ec$__e\$__e]7;file://$env:COMPUTERNAME/$__p$__e\")
    & $global:__ccpanes_prompt
  }
}
"#;

const BASH_SCRIPT: &str = r#"# CC-Panes shell integration (bash): OSC 133;C/D + OSC 7.
# Overwritten by CC-Panes on every launch - do not edit.
[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"

__ccpanes_ip=1
__ccpanes_ec=0
__ccpanes_preexec() {
  [ "$__ccpanes_ip" = 1 ] || return
  __ccpanes_ip=0
  printf '\033]133;C;%s\033\\' "$BASH_COMMAND"
}
__ccpanes_save_ec() { __ccpanes_ec=$?; }
__ccpanes_precmd() {
  printf '\033]133;D;%s\033\\\033]7;file://%s%s\033\\' "$__ccpanes_ec" "${HOSTNAME:-localhost}" "$PWD"
  __ccpanes_ip=1
}
trap '__ccpanes_preexec' DEBUG
PROMPT_COMMAND="__ccpanes_save_ec${PROMPT_COMMAND:+;$PROMPT_COMMAND};__ccpanes_precmd"
"#;

const ZSHENV_SCRIPT: &str = r#"# CC-Panes shell integration bootstrap (zsh). Do not edit.
export __CCPANES_USER_ZDOTDIR="${__CCPANES_USER_ZDOTDIR:-$HOME}"
[ -f "$__CCPANES_USER_ZDOTDIR/.zshenv" ] && source "$__CCPANES_USER_ZDOTDIR/.zshenv"
"#;

const ZPROFILE_SCRIPT: &str = r#"# CC-Panes shell integration (zsh). Do not edit.
[ -f "$__CCPANES_USER_ZDOTDIR/.zprofile" ] && source "$__CCPANES_USER_ZDOTDIR/.zprofile"
"#;

const ZLOGIN_SCRIPT: &str = r#"# CC-Panes shell integration (zsh). Do not edit.
[ -f "$__CCPANES_USER_ZDOTDIR/.zlogin" ] && source "$__CCPANES_USER_ZDOTDIR/.zlogin"
"#;

const ZSHRC_SCRIPT: &str = r#"# CC-Panes shell integration (zsh): OSC 133;C/D + OSC 7. Do not edit.
[ -f "$__CCPANES_USER_ZDOTDIR/.zshrc" ] && source "$__CCPANES_USER_ZDOTDIR/.zshrc"

autoload -Uz add-zsh-hook
__ccpanes_preexec() { printf '\033]133;C;%s\033\\' "$1" }
__ccpanes_precmd() {
  local __ec=$?
  printf '\033]133;D;%s\033\\\033]7;file://%s%s\033\\' "$__ec" "${HOST:-localhost}" "$PWD"
}
add-zsh-hook precmd __ccpanes_precmd
add-zsh-hook preexec __ccpanes_preexec
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellKind {
    Pwsh,
    Bash,
    Zsh,
}

fn classify(command: &str) -> Option<ShellKind> {
    let base = Path::new(command)
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())?;
    let base = base.strip_suffix(".exe").unwrap_or(&base);
    match base {
        "pwsh" | "powershell" => Some(ShellKind::Pwsh),
        "bash" => Some(ShellKind::Bash),
        "zsh" => Some(ShellKind::Zsh),
        _ => None,
    }
}

/// 对纯 shell 标签页应用集成脚本。失败时透传原始命令（不阻断启动）。
///
/// 返回 (command, args)；zsh 通过 `env` 注入 ZDOTDIR。
pub(super) fn apply(
    data_dir: &Path,
    command: String,
    mut args: Vec<String>,
    env: &mut HashMap<String, String>,
) -> (String, Vec<String>) {
    let Some(kind) = classify(&command) else {
        return (command, args);
    };

    let dir = data_dir.join("shell-integration");
    match write_scripts(&dir, kind) {
        Ok(()) => {}
        Err(e) => {
            warn!("shell integration scripts write failed (non-fatal): {e}");
            return (command, args);
        }
    }

    match kind {
        ShellKind::Pwsh => {
            args.extend([
                "-NoExit".to_string(),
                "-File".to_string(),
                dir.join("integration.ps1").to_string_lossy().to_string(),
            ]);
        }
        ShellKind::Bash => {
            args.extend([
                "--rcfile".to_string(),
                script_path_for_bash(&dir.join("bashrc.bash")),
            ]);
        }
        ShellKind::Zsh => {
            // 保留用户原 ZDOTDIR，脚本据此转发 dotfiles
            if let Ok(user_zdotdir) = std::env::var("ZDOTDIR") {
                env.insert("__CCPANES_USER_ZDOTDIR".to_string(), user_zdotdir);
            }
            env.insert(
                "ZDOTDIR".to_string(),
                dir.join("zsh").to_string_lossy().to_string(),
            );
        }
    }
    (command, args)
}

/// git-bash 接受 Windows 路径但正斜杠形式更稳（`D:/...`）。
fn script_path_for_bash(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn write_scripts(dir: &Path, kind: ShellKind) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    match kind {
        ShellKind::Pwsh => {
            write_if_changed(&dir.join("integration.ps1"), PWSH_SCRIPT)?;
        }
        ShellKind::Bash => {
            write_if_changed(&dir.join("bashrc.bash"), BASH_SCRIPT)?;
        }
        ShellKind::Zsh => {
            let zdir = dir.join("zsh");
            std::fs::create_dir_all(&zdir)?;
            write_if_changed(&zdir.join(".zshenv"), ZSHENV_SCRIPT)?;
            write_if_changed(&zdir.join(".zprofile"), ZPROFILE_SCRIPT)?;
            write_if_changed(&zdir.join(".zlogin"), ZLOGIN_SCRIPT)?;
            write_if_changed(&zdir.join(".zshrc"), ZSHRC_SCRIPT)?;
        }
    }
    Ok(())
}

/// 内容一致时跳过写入，避免多标签页并发启动时互相覆盖同一文件。
fn write_if_changed(path: &Path, content: &str) -> std::io::Result<()> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing == content {
            return Ok(());
        }
    }
    std::fs::write(path, content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_recognizes_supported_shells() {
        assert_eq!(classify("pwsh"), Some(ShellKind::Pwsh));
        assert_eq!(
            classify(r"C:\Program Files\PowerShell\7\pwsh.exe"),
            Some(ShellKind::Pwsh)
        );
        assert_eq!(classify("powershell"), Some(ShellKind::Pwsh));
        assert_eq!(
            classify(r"C:\Program Files\Git\bin\bash.exe"),
            Some(ShellKind::Bash)
        );
        assert_eq!(classify("/bin/zsh"), Some(ShellKind::Zsh));
        assert_eq!(classify("cmd.exe"), None);
        assert_eq!(classify("wsl"), None);
        assert_eq!(classify("/usr/bin/fish"), None);
    }

    #[test]
    fn apply_pwsh_appends_file_args_and_writes_script() {
        let tmp = tempfile::tempdir().unwrap();
        let mut env = HashMap::new();
        let (cmd, args) = apply(tmp.path(), "pwsh".to_string(), vec![], &mut env);
        assert_eq!(cmd, "pwsh");
        assert_eq!(args[0], "-NoExit");
        assert_eq!(args[1], "-File");
        assert!(std::path::Path::new(&args[2]).exists());
        assert!(env.is_empty());
    }

    #[test]
    fn apply_bash_uses_rcfile_with_forward_slashes() {
        let tmp = tempfile::tempdir().unwrap();
        let mut env = HashMap::new();
        let (_, args) = apply(tmp.path(), "bash".to_string(), vec![], &mut env);
        assert_eq!(args[0], "--rcfile");
        assert!(!args[1].contains('\\'));
        assert!(
            std::path::Path::new(&args[1].replace('/', std::path::MAIN_SEPARATOR_STR)).exists()
        );
    }

    #[test]
    fn apply_zsh_sets_zdotdir_env() {
        let tmp = tempfile::tempdir().unwrap();
        let mut env = HashMap::new();
        let (_, args) = apply(tmp.path(), "/bin/zsh".to_string(), vec![], &mut env);
        assert!(args.is_empty());
        let zdotdir = env.get("ZDOTDIR").expect("ZDOTDIR set");
        assert!(std::path::Path::new(zdotdir).join(".zshrc").exists());
    }

    #[test]
    fn apply_unknown_shell_passes_through() {
        let tmp = tempfile::tempdir().unwrap();
        let mut env = HashMap::new();
        let (cmd, args) = apply(tmp.path(), "cmd.exe".to_string(), vec![], &mut env);
        assert_eq!(cmd, "cmd.exe");
        assert!(args.is_empty());
        assert!(env.is_empty());
        assert!(!tmp.path().join("shell-integration").exists());
    }
}
