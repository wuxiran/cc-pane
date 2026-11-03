//! 系统外观：强调色与窗口材质。

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::WebviewWindow;

static MATERIAL_ACTIVE: AtomicBool = AtomicBool::new(false);

/// 平台默认：macOS 默认开；Windows 可手动开（默认关）；其余平台不支持。
pub fn material_enabled(setting: Option<bool>) -> bool {
    if cfg!(target_os = "macos") {
        setting.unwrap_or(true)
    } else if cfg!(target_os = "windows") {
        setting.unwrap_or(false)
    } else {
        false
    }
}

/// 透明窗口只能在创建时决定，所以启动前读配置。
pub fn prepare_main_window_material(context: &mut tauri::Context<tauri::Wry>) {
    let settings = crate::services::SettingsService::new().get_settings();
    if !material_enabled(settings.theme.system_material) {
        return;
    }
    for window in &mut context.config_mut().app.windows {
        if window.label == "main" {
            window.transparent = true;
            window.background_color = None;
        }
    }
    MATERIAL_ACTIVE.store(true, Ordering::SeqCst);
}

pub fn apply_main_window_material(window: &WebviewWindow) {
    if !MATERIAL_ACTIVE.load(Ordering::SeqCst) {
        return;
    }
    #[cfg(target_os = "macos")]
    let effect = Effect::Sidebar;
    #[cfg(not(target_os = "macos"))]
    let effect = Effect::Mica;
    let effects = EffectsBuilder::new()
        .effect(effect)
        .state(EffectState::FollowsWindowActiveState)
        .build();
    if let Err(error) = window.set_effects(effects) {
        // 材质失败不影响使用：前端判定为未生效，界面保持不透明。
        MATERIAL_ACTIVE.store(false, Ordering::SeqCst);
        tracing::warn!(%error, "[appearance] failed to apply window material");
    }
}

/// 前端据此决定是否让外壳透出材质。
#[tauri::command]
pub fn window_material_active() -> bool {
    MATERIAL_ACTIVE.load(Ordering::SeqCst)
}

/// 系统强调色（`#rrggbb`）；平台不支持或读取失败时返回 None，前端回退主题色。
#[tauri::command]
pub fn get_system_accent_color() -> Option<String> {
    read_system_accent()
}

#[cfg(target_os = "macos")]
fn read_system_accent() -> Option<String> {
    use objc2_app_kit::{NSColor, NSColorSpace};
    let color = NSColor::controlAccentColor();
    let srgb = color.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())?;
    let channel = |value: f64| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
    Some(format!(
        "#{:02x}{:02x}{:02x}",
        channel(srgb.redComponent()),
        channel(srgb.greenComponent()),
        channel(srgb.blueComponent()),
    ))
}

#[cfg(target_os = "windows")]
fn read_system_accent() -> Option<String> {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let mut value: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    // DWM 的 AccentColor 是 ABGR。
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\DWM"),
            w!("AccentColor"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut _),
            Some(&mut size),
        )
    };
    if status.is_err() {
        return None;
    }
    let (r, g, b) = (value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff);
    Some(format!("#{r:02x}{g:02x}{b:02x}"))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn read_system_accent() -> Option<String> {
    None
}
