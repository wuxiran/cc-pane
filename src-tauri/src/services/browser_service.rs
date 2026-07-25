use crate::utils::AppResult;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{
    webview::WebviewBuilder, AppHandle, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl,
};

pub const CDP_SPIKE_METHODS: [&str; 2] = ["Runtime.evaluate", "Page.captureScreenshot"];
const MAX_WEBVIEW_LABEL_LEN: usize = 64;
const SPIKE_RESULT_LIMIT_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSpikeReport {
    pub runtime_evaluate_result: String,
    pub screenshot_png_bytes: usize,
    pub devtools_requested: bool,
}

impl BrowserBounds {
    pub fn try_new(x: f64, y: f64, width: f64, height: f64) -> AppResult<Self> {
        if ![x, y, width, height].iter().all(|value| value.is_finite()) {
            return Err("browser bounds must be finite logical-pixel values".into());
        }
        if width <= 0.0 || height <= 0.0 {
            return Err("browser bounds must have a positive width and height".into());
        }
        Ok(Self {
            x,
            y,
            width,
            height,
        })
    }

    fn logical_position(self) -> LogicalPosition<f64> {
        LogicalPosition::new(self.x, self.y)
    }

    fn logical_size(self) -> LogicalSize<f64> {
        LogicalSize::new(self.width, self.height)
    }
}

pub fn browser_webview_label(tab_id: &str) -> String {
    let mut readable = tab_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
        .take(32)
        .collect::<String>();
    if readable.is_empty() {
        readable.push_str("tab");
    }

    let digest = Sha256::digest(tab_id.as_bytes());
    let suffix = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let label = format!("browser-{readable}-{suffix}");
    label.chars().take(MAX_WEBVIEW_LABEL_LEN).collect()
}

pub fn truncate_cdp_result(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }

    let mut end = max_bytes.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...[truncated]", &value[..end])
}

#[derive(Default)]
pub struct BrowserTabManager {
    labels: Mutex<HashMap<String, String>>,
}

impl BrowserTabManager {
    pub fn contains(&self, tab_id: &str) -> bool {
        self.labels
            .lock()
            .map(|labels| labels.contains_key(tab_id))
            .unwrap_or(false)
    }

    pub fn create(
        &self,
        app: &AppHandle,
        tab_id: &str,
        url: &str,
        bounds: BrowserBounds,
        visible: bool,
    ) -> AppResult<()> {
        let parsed_url = validate_browser_url(url)?;
        let bounds = BrowserBounds::try_new(bounds.x, bounds.y, bounds.width, bounds.height)?;
        if self.contains(tab_id) {
            self.navigate(app, tab_id, url)?;
            self.set_bounds(app, tab_id, bounds)?;
            return self.set_visible(app, tab_id, visible, false);
        }

        let label = browser_webview_label(tab_id);
        let main_window = app
            .get_window("main")
            .ok_or_else(|| "main window is unavailable".to_string())?;
        let webview = main_window
            .add_child(
                WebviewBuilder::new(label.clone(), WebviewUrl::External(parsed_url))
                    .focused(false)
                    .devtools(true)
                    .enable_clipboard_access(),
                bounds.logical_position(),
                bounds.logical_size(),
            )
            .map_err(|error| format!("failed to create browser webview: {error}"))?;

        if !visible {
            webview
                .hide()
                .map_err(|error| format!("failed to hide browser webview: {error}"))?;
        }

        self.labels
            .lock()
            .map_err(|_| "browser tab registry lock is poisoned".to_string())?
            .insert(tab_id.to_string(), label);
        Ok(())
    }

    pub fn set_bounds(
        &self,
        app: &AppHandle,
        tab_id: &str,
        bounds: BrowserBounds,
    ) -> AppResult<()> {
        let bounds = BrowserBounds::try_new(bounds.x, bounds.y, bounds.width, bounds.height)?;
        let webview = self.webview(app, tab_id)?;
        webview
            .set_position(bounds.logical_position())
            .map_err(|error| format!("failed to position browser webview: {error}"))?;
        webview
            .set_size(bounds.logical_size())
            .map_err(|error| format!("failed to resize browser webview: {error}"))?;
        Ok(())
    }

    pub fn set_visible(
        &self,
        app: &AppHandle,
        tab_id: &str,
        visible: bool,
        focus: bool,
    ) -> AppResult<()> {
        let webview = self.webview(app, tab_id)?;
        if visible {
            webview
                .show()
                .map_err(|error| format!("failed to show browser webview: {error}"))?;
            if focus {
                webview
                    .set_focus()
                    .map_err(|error| format!("failed to focus browser webview: {error}"))?;
            }
        } else {
            webview
                .hide()
                .map_err(|error| format!("failed to hide browser webview: {error}"))?;
        }
        Ok(())
    }

    pub fn navigate(&self, app: &AppHandle, tab_id: &str, url: &str) -> AppResult<()> {
        let url = validate_browser_url(url)?;
        self.webview(app, tab_id)?
            .navigate(url)
            .map_err(|error| format!("failed to navigate browser webview: {error}").into())
    }

    pub fn reload(&self, app: &AppHandle, tab_id: &str) -> AppResult<()> {
        self.webview(app, tab_id)?
            .reload()
            .map_err(|error| format!("failed to reload browser webview: {error}").into())
    }

    pub fn eval(&self, app: &AppHandle, tab_id: &str, script: &str) -> AppResult<()> {
        self.webview(app, tab_id)?
            .eval(script)
            .map_err(|error| format!("failed to evaluate browser script: {error}").into())
    }

    pub fn open_devtools(&self, app: &AppHandle, tab_id: &str) -> AppResult<()> {
        self.webview(app, tab_id)?.open_devtools();
        Ok(())
    }

    pub fn close(&self, app: &AppHandle, tab_id: &str) -> AppResult<()> {
        let label = self
            .labels
            .lock()
            .map_err(|_| "browser tab registry lock is poisoned".to_string())?
            .remove(tab_id);
        let Some(label) = label else {
            return Ok(());
        };
        if let Some(webview) = app.get_webview(&label) {
            webview
                .close()
                .map_err(|error| format!("failed to close browser webview: {error}"))?;
        }
        Ok(())
    }

    pub async fn call_cdp(
        &self,
        app: &AppHandle,
        tab_id: &str,
        method: &str,
        params_json: &str,
    ) -> AppResult<String> {
        call_devtools_protocol(self.webview(app, tab_id)?, method, params_json).await
    }

    pub async fn run_spike_probes(
        &self,
        app: &AppHandle,
        tab_id: &str,
    ) -> AppResult<BrowserSpikeReport> {
        let runtime_result = self
            .call_cdp(
                app,
                tab_id,
                CDP_SPIKE_METHODS[0],
                r#"{"expression":"1 + 1","returnByValue":true}"#,
            )
            .await?;
        let runtime_json: serde_json::Value = serde_json::from_str(&runtime_result)
            .map_err(|error| format!("Runtime.evaluate returned invalid JSON: {error}"))?;
        if runtime_json.get("exceptionDetails").is_some() {
            return Err("Runtime.evaluate returned exceptionDetails".into());
        }

        let screenshot_result = self
            .call_cdp(app, tab_id, CDP_SPIKE_METHODS[1], r#"{"format":"png"}"#)
            .await?;
        let screenshot_png = decode_cdp_screenshot(&screenshot_result)?;
        self.open_devtools(app, tab_id)?;

        Ok(BrowserSpikeReport {
            runtime_evaluate_result: truncate_cdp_result(&runtime_result, SPIKE_RESULT_LIMIT_BYTES),
            screenshot_png_bytes: screenshot_png.len(),
            devtools_requested: true,
        })
    }

    fn webview(&self, app: &AppHandle, tab_id: &str) -> AppResult<Webview> {
        let label = self
            .labels
            .lock()
            .map_err(|_| "browser tab registry lock is poisoned".to_string())?
            .get(tab_id)
            .cloned()
            .ok_or_else(|| format!("unknown browser tab: {tab_id}"))?;
        app.get_webview(&label)
            .ok_or_else(|| format!("browser webview is unavailable for tab: {tab_id}").into())
    }
}

fn decode_cdp_screenshot(response: &str) -> AppResult<Vec<u8>> {
    let value: serde_json::Value = serde_json::from_str(response)
        .map_err(|error| format!("Page.captureScreenshot returned invalid JSON: {error}"))?;
    let data = value
        .get("data")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Page.captureScreenshot response is missing data".to_string())?;
    let png = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| format!("Page.captureScreenshot returned invalid base64: {error}"))?;
    if !png.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        return Err("Page.captureScreenshot response is not a PNG".into());
    }
    Ok(png)
}

fn validate_browser_url(value: &str) -> AppResult<url::Url> {
    let url =
        url::Url::parse(value.trim()).map_err(|error| format!("invalid browser URL: {error}"))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        scheme => Err(format!("unsupported browser URL scheme: {scheme}").into()),
    }
}

#[cfg(target_os = "windows")]
async fn call_devtools_protocol(
    webview: Webview,
    method: &str,
    params_json: &str,
) -> AppResult<String> {
    use std::sync::Arc;
    use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR};

    let method = method.to_string();
    let params_json = params_json.to_string();
    let (sender, receiver) = tokio::sync::oneshot::channel::<AppResult<String>>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let callback_sender = Arc::clone(&sender);

    webview
        .with_webview(move |platform| {
            let send_error = |message: String| {
                if let Ok(mut guard) = sender.lock() {
                    if let Some(sender) = guard.take() {
                        let _ = sender.send(Err(message.into()));
                    }
                }
            };

            let controller = platform.controller();
            let core_webview = match unsafe { controller.CoreWebView2() } {
                Ok(core_webview) => core_webview,
                Err(error) => {
                    send_error(format!("failed to get CoreWebView2: {error}"));
                    return;
                }
            };
            let method_wide = CoTaskMemPWSTR::from(method.as_str());
            let params_wide = CoTaskMemPWSTR::from(params_json.as_str());
            let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |status, result| {
                    if let Ok(mut guard) = callback_sender.lock() {
                        if let Some(sender) = guard.take() {
                            let response = status
                                .map(|_| result)
                                .map_err(|error| format!("CDP method failed: {error}").into());
                            let _ = sender.send(response);
                        }
                    }
                    Ok(())
                },
            ));

            if let Err(error) = unsafe {
                core_webview.CallDevToolsProtocolMethod(
                    *method_wide.as_ref().as_pcwstr(),
                    *params_wide.as_ref().as_pcwstr(),
                    &callback,
                )
            } {
                send_error(format!("failed to invoke CDP method: {error}"));
            }
        })
        .map_err(|error| format!("failed to access native browser webview: {error}"))?;

    tokio::time::timeout(std::time::Duration::from_secs(10), receiver)
        .await
        .map_err(|_| "CDP method timed out".to_string())?
        .map_err(|_| "CDP response channel closed".to_string())?
}

#[cfg(not(target_os = "windows"))]
async fn call_devtools_protocol(
    _webview: Webview,
    _method: &str,
    _params_json: &str,
) -> AppResult<String> {
    Err("native WebView2 CDP is only available on Windows".into())
}

#[cfg(test)]
mod tests {
    use super::{
        browser_webview_label, decode_cdp_screenshot, truncate_cdp_result, BrowserBounds,
        CDP_SPIKE_METHODS,
    };

    #[test]
    fn logical_bounds_keep_css_pixel_values_for_dpi_scaling() {
        let bounds = BrowserBounds::try_new(12.5, 48.0, 900.25, 640.5).unwrap();

        assert_eq!(bounds.x, 12.5);
        assert_eq!(bounds.y, 48.0);
        assert_eq!(bounds.width, 900.25);
        assert_eq!(bounds.height, 640.5);
    }

    #[test]
    fn bounds_reject_non_finite_and_empty_regions() {
        assert!(BrowserBounds::try_new(f64::NAN, 0.0, 100.0, 100.0).is_err());
        assert!(BrowserBounds::try_new(0.0, 0.0, 0.0, 100.0).is_err());
        assert!(BrowserBounds::try_new(0.0, 0.0, 100.0, -1.0).is_err());
    }

    #[test]
    fn webview_labels_are_stable_isolated_and_tauri_safe() {
        let first = browser_webview_label("tab-123");
        let same = browser_webview_label("tab-123");
        let other = browser_webview_label("tab/456:unsafe");

        assert_eq!(first, same);
        assert_ne!(first, other);
        assert!(first.starts_with("browser-"));
        assert!(other
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-'));
        assert!(other.len() <= 64);
    }

    #[test]
    fn spike_probes_cover_runtime_evaluate_and_page_screenshot() {
        assert_eq!(
            CDP_SPIKE_METHODS,
            ["Runtime.evaluate", "Page.captureScreenshot"]
        );
    }

    #[test]
    fn cdp_results_are_truncated_on_utf8_boundaries() {
        let result = truncate_cdp_result("abc中文def", 7);

        assert_eq!(result, "abc中...[truncated]");
        assert!(result.is_char_boundary(result.len()));
    }

    #[test]
    fn cdp_screenshot_requires_png_payload() {
        let png = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            [137, 80, 78, 71, 13, 10, 26, 10, 0],
        );

        assert_eq!(
            decode_cdp_screenshot(&serde_json::json!({ "data": png }).to_string()).unwrap(),
            [137, 80, 78, 71, 13, 10, 26, 10, 0]
        );
        assert!(decode_cdp_screenshot(r#"{"data":"bm90LXBuZw=="}"#).is_err());
        assert!(decode_cdp_screenshot(r#"{"missing":"data"}"#).is_err());
    }
}
