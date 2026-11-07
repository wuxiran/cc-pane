//! 把桌面应用的版本号（src-tauri/tauri.conf.json）编进 cc-panes-web：
//! 远程设备部署靠它判断两端版本是否一致、是否需要升级。crate 自身的 0.1.0 没有意义。
use std::path::Path;

fn main() {
    let conf = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src-tauri/tauri.conf.json");
    println!("cargo:rerun-if-changed={}", conf.display());
    println!("cargo:rerun-if-env-changed=CC_PANES_APP_VERSION");
    if std::env::var("CC_PANES_APP_VERSION").is_ok() {
        return;
    }
    let version = std::fs::read_to_string(&conf)
        .ok()
        .and_then(|text| {
            text.lines().find_map(|line| {
                let line = line.trim();
                let rest = line.strip_prefix("\"version\"")?;
                let value = rest.trim_start().strip_prefix(':')?.trim();
                Some(value.trim_end_matches(',').trim_matches('"').to_string())
            })
        })
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    println!("cargo:rustc-env=CC_PANES_APP_VERSION={version}");
}
