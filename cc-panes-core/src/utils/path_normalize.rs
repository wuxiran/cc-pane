//! 同宿主路径归一化。实现已迁到零依赖 crate `cc-panes-paths`，这里只做 re-export，
//! 保持 `crate::utils::path_normalize::*` 的既有调用点不变。
//!
//! 背景见 `docs/35-unc-path-contamination.md`。

pub use cc_panes_paths::{
    comparison_key, comparison_path, normalize_project_path, path_starts_with, paths_equivalent,
    simplify_opt_path_str, simplify_path, simplify_path_str,
};
