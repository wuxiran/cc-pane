use std::path::Path;

fn main() {
    // 确保 bundled-claude-config 目录结构存在（dev 模式下创建占位文件）
    // Release 构建时 copy-hook.cjs 会用真实内容覆盖
    ensure_bundled_claude_config();

    tauri_build::build();
}

/// 确保 bundle.resources 中引用的 bundled-claude-config/ 目录存在
/// 否则 Tauri 构建脚本会因 glob 匹配不到文件而报错
fn ensure_bundled_claude_config() {
    let dirs = [
        "bundled-claude-config/.claude/commands/ccbook",
        "bundled-claude-config/.claude/agents",
        "bundled-claude-config/default-skills",
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
    let claude_md = Path::new("bundled-claude-config/CLAUDE.md");
    if !claude_md.exists() {
        std::fs::write(claude_md, "# placeholder for dev build").ok();
    }
}
