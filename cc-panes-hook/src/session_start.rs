use serde::Deserialize;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::Command;

/// 创建不弹窗的 Command（Windows 自动设置 CREATE_NO_WINDOW）
fn no_window_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

use chrono::Local;

/// Hook input from Claude Code (stdin JSON).
#[derive(Debug, Deserialize)]
struct HookInput {
    session_id: Option<String>,
}

/// SessionStart hook entry point.
/// Reads hook JSON from stdin and outputs structured context to stdout.
pub fn run() {
    // Skip injection in non-interactive mode
    if std::env::var("CLAUDE_NON_INTERACTIVE").unwrap_or_default() == "1" {
        return;
    }

    // Read stdin early (can only be read once)
    let session_id = read_session_id_from_stdin();

    let project_dir = std::env::var("CLAUDE_PROJECT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let project_dir = project_dir.canonicalize().unwrap_or(project_dir);

    // Safety check
    if !project_dir.is_dir() {
        eprintln!(
            "[ccpanes] warning: CLAUDE_PROJECT_DIR is not a valid directory: {}",
            project_dir.display()
        );
        return;
    }

    let ccpanes_dir = project_dir.join(".ccpanes");

    // Write session-state.json with session_id from stdin
    match session_id {
        Some(ref id) => {
            eprintln!("[ccpanes-hook] session_id (stdin) = {}", id);
            let state = serde_json::json!({
                "claudeSessionId": id,
                "startedAt": Local::now().to_rfc3339(),
                "status": "active"
            });
            let state_path = ccpanes_dir.join("session-state.json");
            let _ = fs::create_dir_all(&ccpanes_dir);
            match fs::write(&state_path, state.to_string()) {
                Ok(_) => eprintln!(
                    "[ccpanes-hook] wrote session-state.json → {}",
                    state_path.display()
                ),
                Err(e) => eprintln!("[ccpanes-hook] FAILED to write session-state.json: {}", e),
            }
        }
        None => {
            eprintln!("[ccpanes-hook] WARNING: session_id not found in stdin JSON");
        }
    }

    // 1. Session context header
    println!(
        "<ccpanes-context>\n\
         CC-Panes has injected project context for this session.\n\
         Please read the following information carefully.\n\
         </ccpanes-context>\n"
    );

    // 2. Current state (dynamic)
    println!("<current-state>");
    println!("Time: {}", Local::now().format("%Y-%m-%d %H:%M:%S"));
    println!("Branch: {}", get_git_branch(&project_dir));
    println!("Git status:\n{}", get_git_status(&project_dir));
    println!("</current-state>\n");

    // 3. Workspace context
    if let Some(ws_claude_md) = find_workspace_claude_md(&project_dir) {
        println!("<workspace-context>");
        println!("{}", ws_claude_md);
        println!("</workspace-context>\n");
    }

    // 4. Memory context (high importance)
    if let Some(memory) = load_memory_context(&project_dir) {
        println!("<memory-context>");
        println!("{}", memory);
        println!("</memory-context>\n");
    }

    // 5. Workflow guide
    let workflow_path = ccpanes_dir.join("workflow.md");
    if workflow_path.exists() {
        if let Ok(content) = fs::read_to_string(&workflow_path) {
            println!("<workflow>");
            println!("{}", content);
            println!("</workflow>\n");
        }
    }

    // 6. Recent sessions
    let journal_index = ccpanes_dir.join("journal").join("index.md");
    if journal_index.exists() {
        if let Ok(content) = fs::read_to_string(&journal_index) {
            println!("<recent-sessions>");
            println!("{}", content);
            println!("</recent-sessions>\n");
        }
    }

    // 7. Ready prompt
    println!(
        "<ready>\n\
         Context loaded. Waiting for user input, then handle request per <workflow> guidelines.\n\
         </ready>"
    );
}

fn get_git_branch(project_dir: &Path) -> String {
    let output = no_window_command("git")
        .args(["branch", "--show-current"])
        .current_dir(project_dir)
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let branch = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if branch.is_empty() {
                "HEAD detached".to_string()
            } else {
                branch
            }
        }
        _ => "unknown".to_string(),
    }
}

fn get_git_status(project_dir: &Path) -> String {
    let output = no_window_command("git")
        .args(["status", "--short"])
        .current_dir(project_dir)
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let status = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if status.is_empty() {
                "Working tree clean".to_string()
            } else {
                status
            }
        }
        _ => "Unable to get git status".to_string(),
    }
}

/// Find the workspace CLAUDE.md for the given project directory.
/// Scans `~/.cc-panes/workspaces/*/workspace.json` to find which workspace contains this project.
fn find_workspace_claude_md(project_dir: &Path) -> Option<String> {
    let home = dirs::home_dir()?;
    let workspaces_dir = home.join(".cc-panes").join("workspaces");
    if !workspaces_dir.is_dir() {
        return None;
    }

    let project_path_str = project_dir.to_string_lossy();

    let entries = fs::read_dir(&workspaces_dir).ok()?;
    for entry in entries.flatten() {
        let ws_dir = entry.path();
        if !ws_dir.is_dir() {
            continue;
        }

        let ws_json_path = ws_dir.join("workspace.json");
        if !ws_json_path.exists() {
            continue;
        }

        // Read and parse workspace.json
        let content = fs::read_to_string(&ws_json_path).ok()?;
        let ws: serde_json::Value = serde_json::from_str(&content).ok()?;

        // Check if any project in this workspace matches
        if let Some(projects) = ws.get("projects").and_then(|p| p.as_array()) {
            for proj in projects {
                if let Some(path) = proj.get("path").and_then(|p| p.as_str()) {
                    if normalize_path(path) == normalize_path(&project_path_str) {
                        // Found the workspace, read CLAUDE.md
                        let claude_md_path = ws_dir.join("CLAUDE.md");
                        if claude_md_path.exists() {
                            return fs::read_to_string(&claude_md_path).ok();
                        }
                    }
                }
            }
        }
    }

    None
}

/// Normalize path separators for comparison (Windows vs Unix).
fn normalize_path(p: &str) -> String {
    p.replace('\\', "/").to_lowercase()
}

/// Find cc-memory-mcp binary and load high-importance memories.
fn load_memory_context(project_dir: &Path) -> Option<String> {
    let cli_path = find_memory_cli()?;

    let home = dirs::home_dir()?;
    let db_path = home.join(".cc-panes").join("memory.db");
    if !db_path.exists() {
        return None;
    }

    let output = no_window_command(&cli_path)
        .args([
            "search",
            "--db-path",
            &db_path.to_string_lossy(),
            "--project-path",
            &project_dir.to_string_lossy(),
            "--min-importance",
            "4",
            "--limit",
            "5",
            "--format",
            "markdown",
        ])
        .output()
        .ok()?;

    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !text.is_empty() && text != "No memories found." {
            return Some(text);
        }
    }

    None
}

fn find_memory_cli() -> Option<String> {
    let bin_name = if cfg!(windows) {
        "cc-memory-mcp.exe"
    } else {
        "cc-memory-mcp"
    };

    // 1. Check ~/.cc-panes/bin/
    if let Some(home) = dirs::home_dir() {
        let cc_panes_bin = home.join(".cc-panes").join("bin").join(bin_name);
        if cc_panes_bin.exists() {
            return Some(cc_panes_bin.to_string_lossy().to_string());
        }
    }

    // 2. Check PATH
    which_in_path(bin_name)
}

fn which_in_path(bin_name: &str) -> Option<String> {
    let path_var = std::env::var("PATH").ok()?;
    let separator = if cfg!(windows) { ';' } else { ':' };
    for dir in path_var.split(separator) {
        let full = PathBuf::from(dir).join(bin_name);
        if full.exists() {
            return Some(full.to_string_lossy().to_string());
        }
    }
    None
}

/// Read session_id from stdin JSON (Claude Code hook input).
fn read_session_id_from_stdin() -> Option<String> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).ok()?;
    let hook: HookInput = serde_json::from_str(&input).ok()?;
    hook.session_id.filter(|s| !s.is_empty())
}
