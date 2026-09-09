//! `build_menu_spec` 纯函数测试：菜单结构决策全分支覆盖。

use super::*;

const NOW: u64 = 1_000_000_000_000;
const MINUTE: u64 = 60_000;

fn session(id: &str, name: &str, status: SessionStatus, since_ms: u64) -> TraySessionEntry {
    TraySessionEntry {
        session_id: id.to_string(),
        name: name.to_string(),
        status,
        status_since_ms: since_ms,
    }
}

fn snapshot(sessions: Vec<TraySessionEntry>) -> TraySnapshot {
    TraySnapshot {
        sessions,
        paused_until: None,
        sound_muted: false,
        workspaces: vec![],
        now_ms: NOW,
    }
}

fn workspace(id: &str, name: &str) -> TrayWorkspaceEntry {
    TrayWorkspaceEntry {
        id: id.to_string(),
        name: name.to_string(),
    }
}

fn item_text<'a>(spec: &'a MenuSpec, id: &str) -> Option<&'a MenuEntry> {
    spec.entries.iter().find(|entry| match entry {
        MenuEntry::Item { id: item_id, .. }
        | MenuEntry::CheckItem { id: item_id, .. }
        | MenuEntry::Submenu { id: item_id, .. } => item_id == id,
        MenuEntry::Separator => false,
    })
}

/// 二级子菜单项查找：只在一级 Submenu 里按子项 id 找。
fn submenu_child<'a>(
    spec: &'a MenuSpec,
    submenu_id: &str,
    child_id: &str,
) -> Option<&'a MenuEntry> {
    spec.entries.iter().find_map(|entry| match entry {
        MenuEntry::Submenu { id, items, .. } if id == submenu_id => {
            items.iter().find(|child| match child {
                MenuEntry::Item { id, .. } | MenuEntry::CheckItem { id, .. } => id == child_id,
                MenuEntry::Submenu { .. } | MenuEntry::Separator => false,
            })
        }
        _ => None,
    })
}

fn child_checked(spec: &MenuSpec, submenu_id: &str, child_id: &str) -> Option<bool> {
    match submenu_child(spec, submenu_id, child_id) {
        Some(MenuEntry::CheckItem { checked, .. }) => Some(*checked),
        _ => None,
    }
}

fn item_enabled(spec: &MenuSpec, id: &str) -> Option<(String, bool)> {
    match item_text(spec, id) {
        Some(MenuEntry::Item { text, enabled, .. }) => Some((text.clone(), *enabled)),
        _ => None,
    }
}

fn check_state(spec: &MenuSpec, id: &str) -> Option<bool> {
    match item_text(spec, id) {
        Some(MenuEntry::CheckItem { checked, .. }) => Some(*checked),
        _ => None,
    }
}

fn pending_ids(spec: &MenuSpec) -> Vec<String> {
    spec.entries
        .iter()
        .filter_map(|entry| match entry {
            MenuEntry::Item { id, .. } if id.starts_with(PENDING_ID_PREFIX) => Some(id.clone()),
            _ => None,
        })
        .collect()
}

fn default_settings() -> TrayMenuSettings {
    TrayMenuSettings::default()
}

#[test]
fn empty_sessions_show_disabled_summary_and_no_pending() {
    let spec = build_menu_spec(&snapshot(vec![]), &default_settings(), TrayLang::ZhCn);
    let (text, enabled) = item_enabled(&spec, ID_SUMMARY).expect("summary entry");
    assert_eq!(text, "无运行中的会话");
    assert!(!enabled);
    assert!(pending_ids(&spec).is_empty());
    assert_eq!(spec.tooltip_summary, None);
    assert!(!spec.quit_needs_confirm);
}

#[test]
fn exited_sessions_are_not_counted_as_running() {
    let snap = snapshot(vec![
        session("a", "", SessionStatus::Exited, NOW - MINUTE),
        session("b", "", SessionStatus::Idle, NOW - MINUTE),
    ]);
    let spec = build_menu_spec(&snap, &default_settings(), TrayLang::ZhCn);
    let (text, enabled) = item_enabled(&spec, ID_SUMMARY).unwrap();
    assert_eq!(text, "1 个会话运行中 · 0 个等待输入 · 0 个出错");
    assert!(enabled);
}

#[test]
fn running_only_sessions_have_summary_without_pending() {
    let snap = snapshot(vec![
        session("a", "", SessionStatus::Thinking, NOW),
        session("b", "", SessionStatus::ToolRunning, NOW),
    ]);
    let spec = build_menu_spec(&snap, &default_settings(), TrayLang::ZhCn);
    let (text, _) = item_enabled(&spec, ID_SUMMARY).unwrap();
    assert_eq!(text, "2 个会话运行中 · 0 个等待输入 · 0 个出错");
    assert!(pending_ids(&spec).is_empty());
    assert_eq!(
        spec.tooltip_summary.as_deref(),
        Some("2 个会话运行中 · 0 个等待输入 · 0 个出错")
    );
    assert!(spec.quit_needs_confirm);
}

#[test]
fn waiting_and_error_sessions_render_pending_oldest_first() {
    let snap = snapshot(vec![
        session(
            "w1",
            "修 bug",
            SessionStatus::WaitingInput,
            NOW - 3 * MINUTE,
        ),
        session("e1", "部署", SessionStatus::Error, NOW - 90 * MINUTE),
        session("r1", "", SessionStatus::Thinking, NOW),
    ]);
    let spec = build_menu_spec(&snap, &default_settings(), TrayLang::ZhCn);
    assert_eq!(
        pending_ids(&spec),
        vec![
            format!("{PENDING_ID_PREFIX}e1"),
            format!("{PENDING_ID_PREFIX}w1")
        ],
        "进入状态最早的排最前"
    );
    let (summary, _) = item_enabled(&spec, ID_SUMMARY).unwrap();
    assert_eq!(summary, "3 个会话运行中 · 1 个等待输入 · 1 个出错");
    let error_text = match item_text(&spec, &format!("{PENDING_ID_PREFIX}e1")) {
        Some(MenuEntry::Item { text, .. }) => text.clone(),
        _ => panic!("error pending entry"),
    };
    assert_eq!(error_text, "❗ 部署 — 出错 1 小时");
    let waiting_text = match item_text(&spec, &format!("{PENDING_ID_PREFIX}w1")) {
        Some(MenuEntry::Item { text, .. }) => text.clone(),
        _ => panic!("waiting pending entry"),
    };
    assert_eq!(waiting_text, "⏳ 修 bug — 等待输入 3 分钟");
}

#[test]
fn pending_entries_truncated_at_configured_max() {
    let sessions: Vec<TraySessionEntry> = (0..8)
        .map(|i| {
            session(
                &format!("s{i}"),
                &format!("任务 {i}"),
                SessionStatus::WaitingInput,
                NOW - (i as u64 + 1) * MINUTE,
            )
        })
        .collect();
    let settings = TrayMenuSettings {
        max_pending_entries: 3,
        ..default_settings()
    };
    let spec = build_menu_spec(&snapshot(sessions), &settings, TrayLang::ZhCn);
    assert_eq!(pending_ids(&spec).len(), 3);
}

#[test]
fn max_pending_entries_zero_is_clamped_to_one() {
    let settings = TrayMenuSettings {
        max_pending_entries: 0,
        ..default_settings()
    };
    let snap = snapshot(vec![session("a", "x", SessionStatus::Error, NOW - MINUTE)]);
    let spec = build_menu_spec(&snap, &settings, TrayLang::ZhCn);
    assert_eq!(pending_ids(&spec).len(), 1);
}

#[test]
fn master_switch_off_hides_summary_pending_and_tooltip() {
    let snap = snapshot(vec![session(
        "a",
        "x",
        SessionStatus::WaitingInput,
        NOW - MINUTE,
    )]);
    let settings = TrayMenuSettings {
        show_session_status: false,
        ..default_settings()
    };
    let spec = build_menu_spec(&snap, &settings, TrayLang::ZhCn);
    assert!(item_text(&spec, ID_SUMMARY).is_none());
    assert!(pending_ids(&spec).is_empty());
    assert_eq!(spec.tooltip_summary, None);
    // 其余区域不受影响
    assert!(item_text(&spec, ID_NEW_SESSION).is_some());
    assert!(item_text(&spec, ID_QUIT).is_some());
}

#[test]
fn tooltip_switch_off_keeps_summary_item_but_drops_tooltip() {
    let snap = snapshot(vec![session("a", "", SessionStatus::Idle, NOW)]);
    let settings = TrayMenuSettings {
        tooltip_summary: false,
        ..default_settings()
    };
    let spec = build_menu_spec(&snap, &settings, TrayLang::ZhCn);
    assert!(item_text(&spec, ID_SUMMARY).is_some());
    assert_eq!(spec.tooltip_summary, None);
}

#[test]
fn quit_confirmation_follows_setting_and_running_count() {
    let running = snapshot(vec![session("a", "", SessionStatus::Idle, NOW)]);
    let mut settings = default_settings();
    assert!(build_menu_spec(&running, &settings, TrayLang::ZhCn).quit_needs_confirm);

    settings.confirm_quit = false;
    assert!(!build_menu_spec(&running, &settings, TrayLang::ZhCn).quit_needs_confirm);

    settings.confirm_quit = true;
    assert!(!build_menu_spec(&snapshot(vec![]), &settings, TrayLang::ZhCn).quit_needs_confirm);
}

#[test]
fn notification_checks_reflect_snapshot_state() {
    let mut snap = snapshot(vec![]);
    snap.sound_muted = true;
    let spec = build_menu_spec(&snap, &default_settings(), TrayLang::ZhCn);
    assert_eq!(check_state(&spec, ID_MUTE_SOUND), Some(true));
}

#[test]
fn pause_submenu_modes_and_resume_enablement() {
    // 未暂停：恢复项禁用、永久档未勾、父项无后缀
    let spec = build_menu_spec(&snapshot(vec![]), &default_settings(), TrayLang::ZhCn);
    let resume_enabled = match submenu_child(&spec, ID_PAUSE_SUBMENU, ID_PAUSE_RESUME) {
        Some(MenuEntry::Item { enabled, .. }) => *enabled,
        _ => panic!("resume entry missing"),
    };
    assert!(!resume_enabled);
    assert_eq!(
        child_checked(&spec, ID_PAUSE_SUBMENU, ID_PAUSE_INDEFINITE),
        Some(false)
    );

    // 永久暂停：永久档勾选、恢复可用、父项带「已暂停」
    let mut snap = snapshot(vec![]);
    snap.paused_until = Some(u64::MAX);
    let spec = build_menu_spec(&snap, &default_settings(), TrayLang::ZhCn);
    assert_eq!(
        child_checked(&spec, ID_PAUSE_SUBMENU, ID_PAUSE_INDEFINITE),
        Some(true)
    );
    let (text, enabled) = match submenu_child(&spec, ID_PAUSE_SUBMENU, ID_PAUSE_RESUME) {
        Some(MenuEntry::Item { text, enabled, .. }) => (text.clone(), *enabled),
        _ => panic!("resume entry missing"),
    };
    assert_eq!(text, "恢复提醒");
    assert!(enabled);
    let parent = match item_text(&spec, ID_PAUSE_SUBMENU) {
        Some(MenuEntry::Submenu { text, .. }) => text.clone(),
        _ => panic!("pause submenu missing"),
    };
    assert_eq!(parent, "暂停所有提醒（已暂停）");

    // 限时暂停：父项带剩余时长、永久档不勾
    let mut snap = snapshot(vec![]);
    snap.paused_until = Some(NOW + 42 * MINUTE);
    let spec = build_menu_spec(&snap, &default_settings(), TrayLang::ZhCn);
    let parent = match item_text(&spec, ID_PAUSE_SUBMENU) {
        Some(MenuEntry::Submenu { text, .. }) => text.clone(),
        _ => panic!("pause submenu missing"),
    };
    assert_eq!(parent, "暂停所有提醒（剩 42 分钟）");
    assert_eq!(
        child_checked(&spec, ID_PAUSE_SUBMENU, ID_PAUSE_INDEFINITE),
        Some(false)
    );
}

#[test]
fn workspace_submenu_lists_entries_and_hides_when_empty() {
    let mut snap = snapshot(vec![]);
    assert!(item_text(
        &build_menu_spec(&snap, &default_settings(), TrayLang::ZhCn),
        ID_WORKSPACE_SUBMENU
    )
    .is_none());

    snap.workspaces = vec![
        workspace("w1", "cc-pane 主仓"),
        workspace("w2", "这是一个名字特别特别长需要截断的工作区名称超出限制"),
    ];
    let spec = build_menu_spec(&snap, &default_settings(), TrayLang::ZhCn);
    let first = match submenu_child(&spec, ID_WORKSPACE_SUBMENU, "tray-workspace:w1") {
        Some(MenuEntry::Item { text, enabled, .. }) => (text.clone(), *enabled),
        _ => panic!("workspace entry missing"),
    };
    assert_eq!(first, ("cc-pane 主仓".to_string(), true));
    let long = match submenu_child(&spec, ID_WORKSPACE_SUBMENU, "tray-workspace:w2") {
        Some(MenuEntry::Item { text, .. }) => text.clone(),
        _ => panic!("workspace entry missing"),
    };
    assert_eq!(long.chars().count(), MAX_NAME_CHARS);
}

#[test]
fn max_pending_radio_checks_current_value() {
    let spec = build_menu_spec(&snapshot(vec![]), &default_settings(), TrayLang::ZhCn);
    assert_eq!(
        child_checked(&spec, ID_SETTINGS_SUBMENU, "tray-set-max-pending:3"),
        Some(false)
    );
    assert_eq!(
        child_checked(&spec, ID_SETTINGS_SUBMENU, "tray-set-max-pending:5"),
        Some(true)
    );
    assert_eq!(
        child_checked(&spec, ID_SETTINGS_SUBMENU, "tray-set-max-pending:10"),
        Some(false)
    );
}

#[test]
fn check_updates_entry_present() {
    let spec = build_menu_spec(&snapshot(vec![]), &default_settings(), TrayLang::ZhCn);
    let (text, enabled) = item_enabled(&spec, ID_CHECK_UPDATES).expect("check-updates entry");
    assert_eq!(text, "检查更新");
    assert!(enabled);
}

#[test]
fn settings_submenu_groups_general_toggles_in_order() {
    let settings = TrayMenuSettings {
        close_to_tray: true,
        confirm_quit: false,
        ..default_settings()
    };
    let spec = build_menu_spec(&snapshot(vec![]), &settings, TrayLang::ZhCn);
    // 顶级不再平铺「设置…」，改为二级子菜单
    assert!(item_text(&spec, ID_OPEN_SETTINGS).is_none());
    let child_ids: Vec<&str> = match item_text(&spec, ID_SETTINGS_SUBMENU) {
        Some(MenuEntry::Submenu { items, .. }) => items
            .iter()
            .filter_map(|entry| match entry {
                MenuEntry::Item { id, .. } | MenuEntry::CheckItem { id, .. } => Some(id.as_str()),
                MenuEntry::Submenu { .. } | MenuEntry::Separator => None,
            })
            .collect(),
        _ => panic!("settings submenu missing"),
    };
    assert_eq!(
        child_ids,
        vec![
            ID_SET_CLOSE_TO_TRAY,
            ID_SET_SHOW_STATUS,
            ID_SET_TOOLTIP_SUMMARY,
            ID_SET_CONFIRM_QUIT,
            "tray-set-max-pending:3",
            "tray-set-max-pending:5",
            "tray-set-max-pending:10",
            ID_OPEN_SETTINGS
        ]
    );
    // 勾选态镜像设置值
    assert_eq!(
        child_checked(&spec, ID_SETTINGS_SUBMENU, ID_SET_CLOSE_TO_TRAY),
        Some(true)
    );
    assert_eq!(
        child_checked(&spec, ID_SETTINGS_SUBMENU, ID_SET_SHOW_STATUS),
        Some(true)
    );
    assert_eq!(
        child_checked(&spec, ID_SETTINGS_SUBMENU, ID_SET_TOOLTIP_SUMMARY),
        Some(true)
    );
    assert_eq!(
        child_checked(&spec, ID_SETTINGS_SUBMENU, ID_SET_CONFIRM_QUIT),
        Some(false)
    );
    let close_text = match submenu_child(&spec, ID_SETTINGS_SUBMENU, ID_SET_CLOSE_TO_TRAY) {
        Some(MenuEntry::CheckItem { text, .. }) => text.clone(),
        _ => panic!("close-to-tray check missing"),
    };
    assert_eq!(close_text, "关闭时最小化到托盘");
}

#[test]
fn settings_submenu_survives_master_switch_off() {
    // 关掉「菜单显示会话状态」后，摘要/待处理隐藏，但子菜单仍在且该项未勾——能从托盘再开回来
    let settings = TrayMenuSettings {
        show_session_status: false,
        ..default_settings()
    };
    let spec = build_menu_spec(&snapshot(vec![]), &settings, TrayLang::ZhCn);
    assert!(item_text(&spec, ID_SUMMARY).is_none());
    assert_eq!(
        child_checked(&spec, ID_SETTINGS_SUBMENU, ID_SET_SHOW_STATUS),
        Some(false)
    );
}

#[test]
fn english_labels_render_for_en_language() {
    let snap = snapshot(vec![session(
        "abc123def456",
        "",
        SessionStatus::WaitingInput,
        NOW - 5 * MINUTE,
    )]);
    let spec = build_menu_spec(&snap, &default_settings(), TrayLang::En);
    let (summary, _) = item_enabled(&spec, ID_SUMMARY).unwrap();
    assert_eq!(summary, "1 running · 1 waiting input · 0 error");
    let pending = match item_text(&spec, &format!("{PENDING_ID_PREFIX}abc123def456")) {
        Some(MenuEntry::Item { text, .. }) => text.clone(),
        _ => panic!("pending entry"),
    };
    // 无名字时回退到「Session + id 短码」
    assert_eq!(pending, "⏳ Session abc123de — waiting input 5 min");
    assert!(item_text(&spec, ID_QUIT).is_some());
}

#[test]
fn duration_text_covers_just_now_minutes_and_hours() {
    assert_eq!(duration_text(30_000, TrayLang::ZhCn), "刚刚");
    assert_eq!(duration_text(3 * MINUTE, TrayLang::ZhCn), "3 分钟");
    assert_eq!(duration_text(120 * MINUTE, TrayLang::En), "2 h");
}

#[test]
fn long_session_names_are_truncated() {
    let long_name = "这是一个非常非常长的会话名字需要被截断处理的场景";
    let entry = session("a", long_name, SessionStatus::WaitingInput, NOW);
    assert_eq!(
        display_name(&entry, TrayLang::ZhCn).chars().count(),
        MAX_NAME_CHARS
    );
}

#[test]
fn resolve_lang_maps_zh_family_to_chinese() {
    assert_eq!(resolve_lang("zh-CN"), TrayLang::ZhCn);
    assert_eq!(resolve_lang("zh"), TrayLang::ZhCn);
    assert_eq!(resolve_lang("en-US"), TrayLang::En);
    assert_eq!(resolve_lang(""), TrayLang::En);
}
