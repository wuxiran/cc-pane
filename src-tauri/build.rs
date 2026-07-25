use std::path::Path;

fn main() {
    // 确保 claude-bundle 目录结构存在（dev 模式下创建占位文件）
    // Release 构建时 copy-hook.cjs 会用真实内容覆盖
    ensure_bundled_claude_config();
    ensure_hook_binary_placeholder();
    ensure_web_dist_placeholder();

    // tauri-runtime-wry 2.11.x 静态导入 comctl32 v6 独有的 TaskDialogIndirect。
    // 测试二进制没有 Tauri 注入的应用清单，加载期即 STATUS_ENTRYPOINT_NOT_FOUND
    // (0xC0000139)。注意 `rustc-link-arg-tests` 只覆盖 tests/ 集成测试目标、
    // 不覆盖 lib 单测（cargo 缺口），清单方案走不通。改为延迟加载 comctl32：
    // 测试从不调用 TaskDialog 则永不解析；主程序清单里已有 v6 依赖，延迟解析
    // 走进程默认激活上下文，行为不变。
    #[cfg(windows)]
    {
        println!("cargo:rustc-link-arg=/DELAYLOAD:comctl32.dll");
        println!("cargo:rustc-link-arg=delayimp.lib");
    }

    tauri_build::build();
}

/// 确保 bundle.resources 中引用的 resources/claude-bundle/ 目录存在
/// 否则 Tauri 构建脚本会因 glob 匹配不到文件而报错
fn ensure_bundled_claude_config() {
    let dirs = [
        "resources/claude-bundle/.claude/commands/ccbook",
        "resources/claude-bundle/.claude/agents",
        "resources/claude-bundle/default-skills",
    ];
    for dir in &dirs {
        let path = Path::new(dir);
        if !path.exists() {
            std::fs::create_dir_all(path).ok();
            // 创建占位文件确保 glob 能匹配
            let placeholder = path.join(".placeholder");
            if !placeholder.exists() {
                std::fs::write(&placeholder, "# placeholder for dev build").ok();
            }
        }
    }
    let claude_md = Path::new("resources/claude-bundle/CLAUDE.md");
    if !claude_md.exists() {
        std::fs::write(claude_md, "# placeholder for dev build").ok();
    }
}

/// 确保 bundle.resources 中引用的 hook 二进制 glob 在 dev/check 模式也能匹配到
fn ensure_hook_binary_placeholder() {
    let binaries_dir = Path::new("binaries");
    if !binaries_dir.exists() {
        std::fs::create_dir_all(binaries_dir).ok();
    }

    let placeholder = binaries_dir.join("cc-panes-cli-hook.placeholder");
    if !placeholder.exists() {
        std::fs::write(placeholder, "placeholder for dev build").ok();
    }

    let daemon_placeholder = binaries_dir.join("cc-panes-daemon.placeholder");
    if !daemon_placeholder.exists() {
        std::fs::write(daemon_placeholder, "placeholder for dev build").ok();
    }

    let ctl_placeholder = binaries_dir.join("cc-panes-ctl.placeholder");
    if !ctl_placeholder.exists() {
        std::fs::write(ctl_placeholder, "placeholder for dev build").ok();
    }

    let web_placeholder = binaries_dir.join("cc-panes-web.placeholder");
    if !web_placeholder.exists() {
        std::fs::write(web_placeholder, "placeholder for dev build").ok();
    }
}

/// 确保 bundle.resources 中引用的 resources/web-dist/ 在 dev/check 模式也能匹配到
fn ensure_web_dist_placeholder() {
    let web_dist_dir = Path::new("resources/web-dist");
    if !web_dist_dir.exists() {
        std::fs::create_dir_all(web_dist_dir).ok();
    }

    let index = web_dist_dir.join("index.html");
    if !index.exists() {
        std::fs::write(
            index,
            "<!doctype html><html><body>placeholder for dev build</body></html>",
        )
        .ok();
    }
}
