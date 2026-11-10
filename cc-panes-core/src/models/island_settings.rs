//! 灵动岛（屏幕顶部常驻的会话状态胶囊）设置。
//!
//! 与 `quick_terminal_settings.rs` 同范式从 `models::settings` 拆出，由其重导出。
//! 枚举型字段刻意存成字符串并在 `merge_missing_defaults` 里归一：配置文件里一个拼错
//! 的值只回落默认，不能让整份 AppSettings 反序列化失败。

use serde::{Deserialize, Serialize};

pub const ISLAND_POSITION_TOP: &str = "top";
pub const ISLAND_POSITION_LEFT: &str = "left";
pub const ISLAND_POSITION_RIGHT: &str = "right";
pub const ISLAND_DISPLAY_MOUSE: &str = "mouse";
pub const ISLAND_DISPLAY_PRIMARY: &str = "primary";

fn default_true() -> bool {
    true
}

fn default_position() -> String {
    ISLAND_POSITION_TOP.to_string()
}

fn default_display() -> String {
    ISLAND_DISPLAY_MOUSE.to_string()
}

/// 灵动岛设置。首个版本默认关闭，用户在「设置 › 灵动岛」显式开启。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IslandSettings {
    #[serde(default)]
    pub enabled: bool,
    /// `top` / `left` / `right`。
    #[serde(default = "default_position")]
    pub position: String,
    /// `mouse`（鼠标所在屏）/ `primary`（主屏）。
    #[serde(default = "default_display")]
    pub display: String,
    /// 会话完成时在收起态弹出 4 秒。
    #[serde(default = "default_true")]
    pub pop_on_finish: bool,
    /// 展开面板底部显示订阅额度。
    #[serde(default = "default_true")]
    pub show_quota: bool,
    /// 前台是全屏应用时收成 3px 细线。
    #[serde(default = "default_true")]
    pub collapse_in_fullscreen: bool,
    /// 主窗口在前台时隐藏灵动岛。
    #[serde(default)]
    pub hide_when_main_focused: bool,
}

impl Default for IslandSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            position: default_position(),
            display: default_display(),
            pop_on_finish: true,
            show_quota: true,
            collapse_in_fullscreen: true,
            hide_when_main_focused: false,
        }
    }
}

impl IslandSettings {
    pub fn merge_missing_defaults(&mut self) {
        if ![
            ISLAND_POSITION_TOP,
            ISLAND_POSITION_LEFT,
            ISLAND_POSITION_RIGHT,
        ]
        .contains(&self.position.as_str())
        {
            self.position = default_position();
        }
        if ![ISLAND_DISPLAY_MOUSE, ISLAND_DISPLAY_PRIMARY].contains(&self.display.as_str()) {
            self.display = default_display();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_section_falls_back_to_disabled_defaults() {
        let parsed: IslandSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(parsed, IslandSettings::default());
        assert!(!parsed.enabled);
        assert_eq!(parsed.position, "top");
        assert_eq!(parsed.display, "mouse");
        assert!(parsed.pop_on_finish && parsed.show_quota && parsed.collapse_in_fullscreen);
        assert!(!parsed.hide_when_main_focused);
    }

    #[test]
    fn unknown_enum_values_are_repaired_instead_of_failing() {
        let mut parsed: IslandSettings =
            serde_json::from_str(r#"{"position":"bottom","display":"tv","enabled":true}"#).unwrap();
        parsed.merge_missing_defaults();
        assert!(parsed.enabled);
        assert_eq!(parsed.position, "top");
        assert_eq!(parsed.display, "mouse");
    }

    #[test]
    fn valid_values_survive_merge_and_use_camel_case() {
        let mut parsed: IslandSettings = serde_json::from_str(
            r#"{"position":"right","display":"primary","hideWhenMainFocused":true,"popOnFinish":false}"#,
        )
        .unwrap();
        parsed.merge_missing_defaults();
        assert_eq!(parsed.position, "right");
        assert_eq!(parsed.display, "primary");
        assert!(parsed.hide_when_main_focused);
        assert!(!parsed.pop_on_finish);
        let json = serde_json::to_string(&parsed).unwrap();
        assert!(json.contains("collapseInFullscreen"));
        assert!(json.contains("showQuota"));
    }
}
