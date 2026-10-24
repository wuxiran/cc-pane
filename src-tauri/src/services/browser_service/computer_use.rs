use super::*;
use serde_json::{json, Value};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserViewport {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserElement {
    pub id: u32,
    pub tag: String,
    pub role: String,
    pub name: String,
    pub text: String,
    pub disabled: bool,
    pub editable: bool,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDomSnapshot {
    pub page_token: String,
    pub url: String,
    pub title: String,
    pub text: String,
    pub elements: Vec<BrowserElement>,
    pub truncated: bool,
    pub viewport: BrowserViewport,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabInfo {
    pub tab_id: String,
    pub url: String,
    pub title: String,
    pub visible: bool,
}

impl BrowserTabManager {
    pub(super) fn automation(
        &self,
        tab_id: &str,
    ) -> AppResult<std::sync::Arc<tokio::sync::Mutex<()>>> {
        self.tabs
            .lock()
            .map_err(|_| "browser registry lock is poisoned")?
            .get(tab_id)
            .map(|entry| entry.automation.clone())
            .ok_or_else(|| "Unknown browser tab".into())
    }

    pub(super) fn try_automation(
        &self,
        tab_id: &str,
    ) -> AppResult<tokio::sync::OwnedMutexGuard<()>> {
        self.automation(tab_id)?.try_lock_owned().map_err(|_| {
            "Browser action is in progress; retry navigation after it completes".into()
        })
    }

    fn page_state(&self, tab_id: &str) -> AppResult<std::sync::Arc<Mutex<BrowserPageState>>> {
        self.tabs
            .lock()
            .map_err(|_| "browser registry lock is poisoned")?
            .get(tab_id)
            .map(|entry| entry.page_state.clone())
            .ok_or_else(|| "Unknown browser tab".into())
    }

    pub(super) fn invalidate_snapshot(&self, tab_id: &str) -> AppResult<()> {
        self.page_state(tab_id)?
            .lock()
            .map_err(|_| "browser page state is unavailable")?
            .invalidate();
        Ok(())
    }

    fn validate_token(&self, tab_id: &str, token: &str) -> AppResult<()> {
        if self
            .page_state(tab_id)?
            .lock()
            .map_err(|_| "browser page state is unavailable")?
            .token
            .as_deref()
            != Some(token)
        {
            return Err(crate::utils::AppError::coded(
                "BROWSER_PAGE_CHANGED",
                "Stale browser snapshot; take a new snapshot before acting",
            ));
        }
        Ok(())
    }

    pub(super) async fn validate_page(
        &self,
        app: &AppHandle,
        tab_id: &str,
        token: &str,
    ) -> AppResult<()> {
        self.validate_token(tab_id, token)?;
        self.computer_use(app, tab_id, json!({"action":"validate", "pageToken":token}))
            .await?;
        Ok(())
    }

    pub(super) async fn call_guarded_input(
        &self,
        app: &AppHandle,
        tab_id: &str,
        token: &str,
        method: &str,
        params: &str,
    ) -> AppResult<String> {
        let page = self.page_state(tab_id)?;
        let url = page
            .lock()
            .map_err(|_| "browser page state is unavailable")?
            .url
            .clone()
            .ok_or("Browser snapshot is unavailable")?;
        let guard = BrowserInputGuard {
            page,
            token: token.into(),
            url,
        };
        call_devtools_protocol(
            self.webview(app, tab_id)?,
            method,
            params,
            DEFAULT_CDP_TIMEOUT,
            Some(guard),
        )
        .await
    }

    pub fn list_tabs(&self, app: &AppHandle) -> AppResult<Vec<BrowserTabInfo>> {
        let entries = self
            .tabs
            .lock()
            .map_err(|_| "browser registry lock is poisoned")?
            .iter()
            .map(|(id, entry)| (id.clone(), entry.label.clone(), entry.visibility.visible))
            .collect::<Vec<_>>();
        let mut tabs = Vec::new();
        for (tab_id, label, visible) in entries {
            if let Some(view) = app.get_webview(&label) {
                let url = view.url().map_err(|error| error.to_string())?;
                tabs.push(BrowserTabInfo {
                    tab_id,
                    title: url.host_str().unwrap_or("Browser").into(),
                    url: url.to_string(),
                    visible,
                });
            }
        }
        tabs.sort_by(|a, b| a.tab_id.cmp(&b.tab_id));
        Ok(tabs)
    }

    pub async fn snapshot(&self, app: &AppHandle, tab_id: &str) -> AppResult<BrowserDomSnapshot> {
        let _operation = self.automation(tab_id)?.lock_owned().await;
        let page_state = self.page_state(tab_id)?;
        let generation = page_state
            .lock()
            .map_err(|_| "browser page state is unavailable")?
            .generation;
        let value = self
            .computer_use(
                app,
                tab_id,
                json!({"action":"snapshot", "pageToken":uuid::Uuid::new_v4().to_string()}),
            )
            .await?;
        let snapshot: BrowserDomSnapshot = serde_json::from_value(value)
            .map_err(|error| format!("Invalid browser snapshot: {error}"))?;
        let mut page = page_state
            .lock()
            .map_err(|_| "browser page state is unavailable")?;
        if page.generation != generation {
            return Err("Page navigated while taking snapshot; retry".into());
        }
        page.token = Some(snapshot.page_token.clone());
        page.url = Some(snapshot.url.clone());
        Ok(snapshot)
    }

    /// Snapshot text never returns form values. Fill uses the native input path
    /// after focusing/selecting the observed editable element.
    pub async fn fill(
        &self,
        app: &AppHandle,
        tab_id: &str,
        page_token: &str,
        element_id: u32,
        text: &str,
    ) -> AppResult<()> {
        if text.len() > 32 * 1024 || text.contains('\0') {
            return Err("Browser fill text exceeds 32 KiB or contains NUL".into());
        }
        let _operation = self.automation(tab_id)?.lock_owned().await;
        self.validate_token(tab_id, page_token)?;
        #[cfg(target_os = "macos")]
        let _native_operation = self.native_operation(tab_id)?.lock_owned().await;
        let _restore = self.temporarily_show(app, tab_id)?;
        self.computer_use(
            app,
            tab_id,
            json!({"action":"focus-fill", "pageToken":page_token,"elementId":element_id}),
        )
        .await?;
        self.validate_page(app, tab_id, page_token).await?;
        self.call_guarded_input(
            app,
            tab_id,
            page_token,
            "Input.insertText",
            &json!({"text":text}).to_string(),
        )
        .await?;
        Ok(())
    }

    pub async fn press_key(
        &self,
        app: &AppHandle,
        tab_id: &str,
        page_token: &str,
        key: &str,
    ) -> AppResult<()> {
        let (code, virtual_key) = key_description(key)?;
        let _operation = self.automation(tab_id)?.lock_owned().await;
        self.validate_token(tab_id, page_token)?;
        #[cfg(target_os = "macos")]
        let _native_operation = self.native_operation(tab_id)?.lock_owned().await;
        let _restore = self.temporarily_show(app, tab_id)?;
        self.computer_use(
            app,
            tab_id,
            json!({"action":"validate", "pageToken":page_token}),
        )
        .await?;
        for event in ["keyDown", "keyUp"] {
            if let Err(error) = self.validate_token(tab_id, page_token) {
                if event == "keyUp" && page_changed(&error) {
                    return Ok(());
                }
                return Err(error);
            }
            let result = self.call_guarded_input(
                app,
                tab_id,
                page_token,
                "Input.dispatchKeyEvent",
                &json!({"type":event,"key":key,"code":code,"windowsVirtualKeyCode":virtual_key})
                    .to_string(),
            )
            .await;
            if let Err(error) = result {
                if event == "keyUp" {
                    if page_changed(&error) {
                        return Ok(());
                    }
                    return Err(format!("Browser keyDown was already dispatched; keyUp failed: {error}. Inspect the page before retrying").into());
                }
                return Err(error);
            }
        }
        Ok(())
    }

    pub async fn scroll(
        &self,
        app: &AppHandle,
        tab_id: &str,
        page_token: &str,
        delta_x: f64,
        delta_y: f64,
    ) -> AppResult<()> {
        if !delta_x.is_finite()
            || !delta_y.is_finite()
            || delta_x.abs() > 100_000.0
            || delta_y.abs() > 100_000.0
        {
            return Err(
                "Browser scroll deltas must be finite and at most 100000 CSS pixels".into(),
            );
        }
        let _operation = self.automation(tab_id)?.lock_owned().await;
        self.validate_token(tab_id, page_token)?;
        self.computer_use(
            app,
            tab_id,
            json!({"action":"scroll", "pageToken":page_token,"deltaX":delta_x,"deltaY":delta_y}),
        )
        .await?;
        Ok(())
    }

    pub async fn click_element(
        &self,
        app: &AppHandle,
        tab_id: &str,
        page_token: &str,
        element_id: u32,
    ) -> AppResult<()> {
        let _operation = self.automation(tab_id)?.lock_owned().await;
        self.validate_token(tab_id, page_token)?;
        let point = self
            .computer_use(
                app,
                tab_id,
                json!({"action":"click-point", "pageToken":page_token,"elementId":element_id}),
            )
            .await?;
        let x = point["x"]
            .as_f64()
            .ok_or("Browser element has no click point")?;
        let y = point["y"]
            .as_f64()
            .ok_or("Browser element has no click point")?;
        self.validate_token(tab_id, page_token)?;
        self.click_inner(app, tab_id, x, y, Some(page_token)).await
    }

    async fn computer_use(
        &self,
        app: &AppHandle,
        tab_id: &str,
        request: Value,
    ) -> AppResult<Value> {
        let script = format!("({})({})", include_str!("computer_use.js"), request);
        let response = self.evaluate_inner(app, tab_id, &script).await?;
        decode_result(&response)
    }
}

fn page_changed(error: &crate::utils::AppError) -> bool {
    error.code() == Some("BROWSER_PAGE_CHANGED")
        || error.message().contains("Stale browser snapshot")
}

fn decode_result(response: &str) -> AppResult<Value> {
    let response: Value = serde_json::from_str(response)
        .map_err(|error| format!("Invalid browser response: {error}"))?;
    if let Some(error) = response.get("exceptionDetails") {
        return Err(format!(
            "Browser action failed: {}",
            error["text"].as_str().unwrap_or("JavaScript exception")
        )
        .into());
    }
    let result = response["result"]["value"].clone();
    if let Some(error) = result.get("error").and_then(Value::as_str) {
        return Err(error.to_string().into());
    }
    if result.is_null() {
        return Err("Browser action returned no result".into());
    }
    Ok(result)
}

pub(super) fn key_description(key: &str) -> AppResult<(&'static str, u16)> {
    Ok(match key {
        "Enter" => ("Enter", 13), "Tab" => ("Tab", 9), "Escape" => ("Escape", 27),
        "Backspace" => ("Backspace", 8), "Delete" => ("Delete", 46),
        "ArrowLeft" => ("ArrowLeft", 37), "ArrowUp" => ("ArrowUp", 38),
        "ArrowRight" => ("ArrowRight", 39), "ArrowDown" => ("ArrowDown", 40),
        "Home" => ("Home", 36), "End" => ("End", 35),
        "PageUp" => ("PageUp", 33), "PageDown" => ("PageDown", 34),
        _ => return Err("Unsupported browser key; use Enter, Tab, Escape, Backspace, Delete, Arrow keys, Home, End, PageUp or PageDown".into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_dispatch_guard_rejects_navigation_after_validation() {
        let page = std::sync::Arc::new(Mutex::new(BrowserPageState {
            generation: 1,
            token: Some("seen".into()),
            url: Some("https://fixture.test/".into()),
        }));
        let guard = BrowserInputGuard {
            page: page.clone(),
            token: "seen".into(),
            url: "https://fixture.test/".into(),
        };
        assert!(guard.validate("https://fixture.test/").is_ok());
        assert!(guard.validate("https://fixture.test/other").is_err());
        page.lock().unwrap().invalidate();
        assert_eq!(
            guard.validate("https://fixture.test/").unwrap_err().code(),
            Some("BROWSER_PAGE_CHANGED")
        );
    }

    #[tokio::test]
    async fn queued_actions_recheck_page_tokens_and_other_tabs_remain_available() {
        let manager = std::sync::Arc::new(BrowserTabManager::default());
        for tab in ["one", "two"] {
            manager.tabs.lock().unwrap().insert(
                tab.into(),
                BrowserTabEntry {
                    label: tab.into(),
                    visibility: BrowserVisibility::new(true),
                    automation: Default::default(),
                    page_state: Default::default(),
                    #[cfg(target_os = "macos")]
                    native_operation: Default::default(),
                },
            );
        }
        manager.page_state("one").unwrap().lock().unwrap().token = Some("observed".into());
        let active = manager.automation("one").unwrap().lock_owned().await;
        assert!(manager.try_automation("one").is_err());
        assert!(manager.try_automation("two").is_ok());
        let queued_manager = manager.clone();
        let queued = tokio::spawn(async move {
            let _operation = queued_manager.automation("one").unwrap().lock_owned().await;
            queued_manager.validate_token("one", "observed")
        });
        manager.invalidate_snapshot("one").unwrap();
        drop(active);
        assert!(queued.await.unwrap().is_err());
    }
    #[test]
    fn computer_use_errors_are_not_reported_as_success() {
        assert!(
            decode_result(r#"{"result":{"value":{"error":"Stale browser snapshot"}}}"#).is_err()
        );
        assert!(decode_result(r#"{"exceptionDetails":{"text":"page error"}}"#).is_err());
        assert!(decode_result("truncated...").is_err());
        assert_eq!(
            decode_result(r#"{"result":{"value":{"success":true}}}"#).unwrap()["success"],
            true
        );
    }
    #[test]
    fn computer_use_keys_do_not_allow_os_shortcuts_or_unbounded_input() {
        assert_eq!(key_description("Enter").unwrap(), ("Enter", 13));
        for key in ["Meta+Q", "Ctrl+W", "", "a"] {
            assert!(key_description(key).is_err());
        }
    }
}
