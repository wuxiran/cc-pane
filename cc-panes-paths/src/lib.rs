//! CC-Panes 路径归一化的唯一来源。
//!
//! 零内部依赖的 leaf crate：core、cc-cli-adapters、cli-hook 等都可以依赖它，
//! 不会引入 core → adapters 的反向依赖。
//!
//! 同一个路径在不同场景下"相等"的含义不同，所以入口按语义分四类，调用方按场景选：
//!
//! 1. **项目身份** [`identity_key`]：一个项目在本地 / WSL 两种运行时下是否同一条注册记录。
//!    盘符、`/mnt/<x>`、指向挂载盘的 WSL UNC 归一到 `D:\...`；WSL Linux 路径归一到
//!    `\\wsl.localhost\<distro>\...`。
//! 2. **同宿主比较 / 前缀判断** [`paths_equivalent`]、[`comparison_path`]、
//!    [`comparison_key`]、[`path_starts_with`]：只统一分隔符、verbatim 前缀与尾分隔符，
//!    盘符部分忽略大小写；**不**做盘符 ↔ `/mnt` ↔ UNC 的跨形式映射。
//! 3. **WSL 视角比较** [`wsl_compare_key`]：会话归属匹配用，把各种形式都映射到 WSL 内看到的
//!    POSIX 路径。
//! 4. **形式转换** [`to_wsl_posix`]、[`to_windows_unc`]、[`parse_wsl_unc`]：产出可执行 / 可展示
//!    的路径，不用于比较。
//!
//! 另含数据目录解析 [`DataDirResolver`] 与 [`running_under_wsl`]。
//!
//! 纯字符串函数一律不加 `#[cfg(windows)]`，保证在 Linux CI 上也能跑同一份用例。

mod data_dir;
mod identity;
mod normalize;
mod wsl;

pub use data_dir::{
    running_under_wsl, DataDirResolver, APP_CONFIG_DIR_ENV, APP_DIR_NAME, DATA_DIR_ENV,
    DEV_APP_DIR_NAME, RELEASE_APP_DIR_NAME,
};
pub use identity::{canonical_project_path, identity_key, project_paths_equivalent};
pub use normalize::{
    comparison_key, comparison_path, normalize_project_path, path_starts_with, paths_equivalent,
    simplify_opt_path_str, simplify_path, simplify_path_str,
};
pub use wsl::{
    mnt_drive_letter, parse_wsl_unc, to_windows_unc, to_wsl_posix, wsl_compare_key,
    DEFAULT_WSL_MOUNT_ROOT,
};
