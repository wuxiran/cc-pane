use crate::utils::{AppError, AppResult};
use cc_panes_core::utils::atomic_file::write_atomic;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum LayoutSound {
    #[default]
    Default,
    Silent,
    Custom {
        asset: String,
        name: String,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationPreferences {
    pub layout_sounds: HashMap<String, LayoutSound>,
    pub session_snoozes: HashMap<String, u64>,
    /// 全局暂停截止（ms 时间戳）。None = 未暂停；`GLOBAL_PAUSE_INDEFINITE` = 直到手动恢复。
    #[serde(default)]
    pub global_pause_until: Option<u64>,
    /// 全局静音提示音（不抑制系统通知，只静音应用内提示音）。
    #[serde(default)]
    pub sound_muted: bool,
}

/// 「暂停所有提醒」的永久取值：远未来时间戳，手动取消时清除。
pub const GLOBAL_PAUSE_INDEFINITE: u64 = u64::MAX;

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub struct NotificationPreferenceService {
    root: PathBuf,
    state: Mutex<NotificationPreferences>,
}

fn validate_id(id: &str) -> AppResult<()> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(AppError::from("invalid notification preference identity"));
    }
    Ok(())
}

impl NotificationPreferenceService {
    pub fn new(root: PathBuf) -> Self {
        let path = root.join("notification-preferences.json");
        let state = if path.exists() {
            match std::fs::read(&path)
                .map_err(AppError::from)
                .and_then(|bytes| {
                    if bytes.len() > 256 * 1024 {
                        return Err(AppError::from("notification preferences exceed read limit"));
                    }
                    serde_json::from_slice(&bytes).map_err(|e| AppError::from(e.to_string()))
                }) {
                Ok(value) => value,
                Err(error) => {
                    tracing::warn!(%error, "Cannot load notification preferences; original file retained");
                    NotificationPreferences::default()
                }
            }
        } else {
            NotificationPreferences::default()
        };
        Self {
            root,
            state: Mutex::new(state),
        }
    }

    pub fn get(&self) -> NotificationPreferences {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.session_snoozes.retain(|_, until| *until > now_ms());
        state.clone()
    }

    pub fn snoozed(&self, session_id: Option<&str>, now: u64) -> bool {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.global_pause_until.is_some_and(|until| until > now) {
            return true;
        }
        session_id
            .and_then(|id| state.session_snoozes.get(id))
            .is_some_and(|until| *until > now)
    }

    /// 应用内提示音是否全局静音（系统通知不受此影响）。
    pub fn sound_muted(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sound_muted
    }

    /// 设置/取消全局暂停。暂停期间所有会话的系统通知与提示音都被抑制。
    pub fn set_global_pause(&self, paused: bool) -> AppResult<NotificationPreferences> {
        self.set_global_pause_until(paused.then_some(GLOBAL_PAUSE_INDEFINITE))
    }

    /// 暂停到指定截止（ms 时间戳；`GLOBAL_PAUSE_INDEFINITE` = 直到手动恢复；None = 取消）。
    pub fn set_global_pause_until(&self, until: Option<u64>) -> AppResult<NotificationPreferences> {
        self.update(|state| {
            state.global_pause_until = until;
        })
    }

    pub fn set_sound_muted(&self, muted: bool) -> AppResult<NotificationPreferences> {
        self.update(|state| {
            state.sound_muted = muted;
        })
    }

    fn update(
        &self,
        change: impl FnOnce(&mut NotificationPreferences),
    ) -> AppResult<NotificationPreferences> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = state.clone();
        next.session_snoozes.retain(|_, until| *until > now_ms());
        change(&mut next);
        if next.layout_sounds.len() > 512 || next.session_snoozes.len() > 512 {
            return Err(AppError::from("too many notification preferences"));
        }
        std::fs::create_dir_all(&self.root)?;
        let path = self.root.join("notification-preferences.json");
        if path.exists() {
            std::fs::copy(&path, path.with_extension("json.bak"))?;
        }
        let bytes = serde_json::to_vec_pretty(&next).map_err(|e| AppError::from(e.to_string()))?;
        write_atomic(&path, bytes).map_err(|e| AppError::from(e.to_string()))?;
        *state = next.clone();
        Ok(next)
    }

    pub fn set_snooze(&self, id: &str, until: Option<u64>) -> AppResult<NotificationPreferences> {
        validate_id(id)?;
        if until.is_some_and(|value| {
            value <= now_ms() || value > now_ms().saturating_add(7 * 86_400_000)
        }) {
            return Err(AppError::from("snooze must end within the next seven days"));
        }
        self.update(|state| {
            if let Some(until) = until {
                state.session_snoozes.insert(id.into(), until);
            } else {
                state.session_snoozes.remove(id);
            }
        })
    }

    pub fn set_sound(&self, id: &str, sound: LayoutSound) -> AppResult<NotificationPreferences> {
        validate_id(id)?;
        if let LayoutSound::Custom { asset, name } = &sound {
            if name.chars().count() > 128 || !self.sound_path(asset)?.is_file() {
                return Err(AppError::from("notification sound is missing or invalid"));
            }
        }
        self.update(|state| {
            if matches!(sound, LayoutSound::Default) {
                state.layout_sounds.remove(id);
            } else {
                state.layout_sounds.insert(id.into(), sound);
            }
        })
    }

    pub fn sound_path(&self, asset: &str) -> AppResult<PathBuf> {
        let (id, extension) = asset
            .rsplit_once('.')
            .ok_or_else(|| AppError::from("invalid sound asset"))?;
        uuid::Uuid::parse_str(id).map_err(|_| AppError::from("invalid sound asset"))?;
        if !["mp3", "wav", "ogg"].contains(&extension) {
            return Err(AppError::from("unsupported sound format"));
        }
        Ok(self.root.join("notification-sounds").join(asset))
    }

    pub fn import_sound(&self, path: &Path) -> AppResult<LayoutSound> {
        let extension = path
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !["mp3", "wav", "ogg"].contains(&extension.as_str()) {
            return Err(AppError::from("choose an MP3, WAV or OGG sound"));
        }
        let metadata = std::fs::metadata(path)?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 10 * 1024 * 1024 {
            return Err(AppError::from(
                "sound must be a nonempty file no larger than 10 MB",
            ));
        }
        let asset = format!("{}.{}", uuid::Uuid::new_v4(), extension);
        let target = self.sound_path(&asset)?;
        std::fs::create_dir_all(target.parent().unwrap())?;
        std::fs::copy(path, target)?;
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .chars()
            .take(128)
            .collect();
        Ok(LayoutSound::Custom { asset, name })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_snooze_is_scoped_persistent_and_cancellable() {
        let root = tempfile::tempdir().unwrap();
        let service = NotificationPreferenceService::new(root.path().into());
        let until = now_ms() + 60_000;
        service.set_snooze("session-a", Some(until)).unwrap();
        let loaded = NotificationPreferenceService::new(root.path().into());
        assert!(loaded.snoozed(Some("session-a"), until - 1));
        assert!(!loaded.snoozed(Some("session-b"), until - 1));
        assert!(!loaded.snoozed(Some("session-a"), until));
        loaded.set_snooze("session-a", None).unwrap();
        assert!(!loaded.snoozed(Some("session-a"), now_ms()));
        assert!(root
            .path()
            .join("notification-preferences.json.bak")
            .exists());
    }

    #[test]
    fn invalid_input_never_changes_preferences() {
        let root = tempfile::tempdir().unwrap();
        let service = NotificationPreferenceService::new(root.path().into());
        assert!(service
            .set_snooze("../session", Some(now_ms() + 1000))
            .is_err());
        assert!(service.set_snooze("session", Some(0)).is_err());
        assert!(service
            .set_snooze("session", Some(now_ms() + 8 * 86_400_000))
            .is_err());
        assert!(service.sound_path("../test.wav").is_err());
        assert!(!root.path().join("notification-preferences.json").exists());
    }

    #[test]
    fn sound_policy_uses_layout_identity_and_default_removes_override() {
        let root = tempfile::tempdir().unwrap();
        let service = NotificationPreferenceService::new(root.path().into());
        service.set_sound("layout-1", LayoutSound::Silent).unwrap();
        assert!(matches!(
            service.get().layout_sounds["layout-1"],
            LayoutSound::Silent
        ));
        service.set_sound("layout-1", LayoutSound::Default).unwrap();
        assert!(service.get().layout_sounds.is_empty());
    }

    #[test]
    fn global_pause_suppresses_every_session_until_cleared() {
        let root = tempfile::tempdir().unwrap();
        let service = NotificationPreferenceService::new(root.path().into());
        let now = now_ms();
        assert!(!service.snoozed(Some("session-a"), now));

        let prefs = service.set_global_pause(true).unwrap();
        assert_eq!(prefs.global_pause_until, Some(GLOBAL_PAUSE_INDEFINITE));
        assert!(service.snoozed(Some("session-a"), now));
        assert!(service.snoozed(None, now));
        // 持久化后新实例仍然暂停（勾选态跨重启保留）
        let loaded = NotificationPreferenceService::new(root.path().into());
        assert!(loaded.snoozed(Some("session-b"), now));

        let prefs = loaded.set_global_pause(false).unwrap();
        assert_eq!(prefs.global_pause_until, None);
        assert!(!loaded.snoozed(Some("session-a"), now));
    }

    #[test]
    fn sound_muted_round_trips_and_defaults_off_for_legacy_files() {
        let root = tempfile::tempdir().unwrap();
        // 老数据文件没有新字段：serde default 兜底
        std::fs::write(
            root.path().join("notification-preferences.json"),
            r#"{"layoutSounds":{},"sessionSnoozes":{}}"#,
        )
        .unwrap();
        let service = NotificationPreferenceService::new(root.path().into());
        assert!(!service.sound_muted());
        assert_eq!(service.get().global_pause_until, None);

        let prefs = service.set_sound_muted(true).unwrap();
        assert!(prefs.sound_muted);
        let loaded = NotificationPreferenceService::new(root.path().into());
        assert!(loaded.sound_muted());
        // 静音不抑制系统通知判定（snoozed 只反映暂停/ Snooze）
        assert!(!loaded.snoozed(Some("session-a"), now_ms()));
    }
}
