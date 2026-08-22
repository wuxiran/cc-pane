use crate::utils::AppResult;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{
    webview::{PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl,
};

pub const CDP_SPIKE_METHODS: [&str; 2] = ["Runtime.evaluate", "Page.captureScreenshot"];
const MAX_WEBVIEW_LABEL_LEN: usize = 64;
const SPIKE_RESULT_LIMIT_BYTES: usize = 4096;
const EVALUATE_RESULT_LIMIT_BYTES: usize = 64 * 1024;

/// 通用 CDP 超时：足够慢页面上的 `Runtime.evaluate` 跑完。
const DEFAULT_CDP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// 截图超时。截图要么很快返回，要么是根本拿不到帧——等满 10 秒只是让调用方
/// 多卡 6 秒，并不会提高成功率。
const SCREENSHOT_CDP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);
/// 等首帧的超时。提为可见后正常是一两帧的事（十几毫秒）。
const FIRST_FRAME_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// 等到下一次合成帧为止。rAF 触发即证明合成器在产帧；
/// 双层 rAF 是为了确保等到的是**提为可见之后**真正绘制的那一帧。
const FIRST_FRAME_PROBE: &str =
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))";

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

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserOpenTabEvent {
    /// MCP 请求等待前端确认实际 tabId；其他内部调用不需要应答。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub tab_id: String,
    pub url: String,
    pub title: String,
    /// 落位窗格；None 表示交给前端用当前活动窗格。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    /// 已有同 URL 标签时是否复用（默认 true）。前端消费；旧前端忽略该字段仍按新开处理。
    pub reuse: bool,
    /// 发起本次打开的 PTY 会话 id（MCP 调用方）。前端据此把标签落到**指挥者所在布局**，
    /// 而不是用户此刻正看着的那个布局。None = 无调用方身份（UI/命令入口），落当前布局。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller_session_id: Option<String>,
}

impl BrowserOpenTabEvent {
    pub fn try_new(url: &str, title: Option<&str>) -> AppResult<Self> {
        Self::try_new_with(url, title, None, true)
    }

    pub fn try_new_with(
        url: &str,
        title: Option<&str>,
        pane_id: Option<&str>,
        reuse: bool,
    ) -> AppResult<Self> {
        let parsed = validate_browser_url(url)?;
        let default_title = parsed.host_str().unwrap_or("Browser");
        Ok(Self {
            request_id: None,
            tab_id: format!("tab-{}", uuid::Uuid::new_v4()),
            url: parsed.to_string(),
            title: title
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(default_title)
                .to_string(),
            pane_id: pane_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            reuse,
            caller_session_id: None,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPageLoadEvent {
    tab_id: String,
    url: String,
    loading: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserTitleChangedEvent {
    tab_id: String,
    title: String,
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

    const SUFFIX: &str = "...[truncated]";
    let content_limit = if max_bytes < SUFFIX.len() {
        max_bytes
    } else {
        max_bytes - SUFFIX.len()
    };
    let mut end = content_limit.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    if max_bytes < SUFFIX.len() {
        return value[..end].to_string();
    }
    format!("{}{SUFFIX}", &value[..end])
}

#[derive(Debug, Clone)]
struct BrowserTabEntry {
    label: String,
    /// 该标签的 webview 当前是否处于 `show()` 状态。
    ///
    /// 截图必须知道这件事：隐藏的 WebView2 合成器停止产帧，
    /// `Page.captureScreenshot` 会一直等不到帧直到超时（见 `screenshot`）。
    visible: bool,
}

#[derive(Default)]
pub struct BrowserTabManager {
    tabs: Mutex<HashMap<String, BrowserTabEntry>>,
}

/// 截图期间临时提帧的守卫：`Drop` 时把标签恢复成原先的隐藏状态。
///
/// 用守卫而非顺序代码，是因为截图路径中间有多个 `?` 早退点（CDP 超时、
/// 非 PNG、写盘失败），任何一条早退都不能把用户的后台标签永久留在可见状态。
struct TemporaryVisibilityGuard<'a> {
    manager: &'a BrowserTabManager,
    app: &'a AppHandle,
    tab_id: String,
}

impl Drop for TemporaryVisibilityGuard<'_> {
    fn drop(&mut self) {
        if let Err(error) = self
            .manager
            .set_visible(self.app, &self.tab_id, false, false)
        {
            log::warn!(
                "failed to restore hidden state for browser tab {}: {error}",
                self.tab_id
            );
        }
    }
}

impl BrowserTabManager {
    pub fn contains(&self, tab_id: &str) -> bool {
        self.tabs
            .lock()
            .map(|tabs| tabs.contains_key(tab_id))
            .unwrap_or(false)
    }

    /// 标签当前是否可见；未注册的标签视为不可见。
    fn is_visible(&self, tab_id: &str) -> bool {
        self.tabs
            .lock()
            .map(|tabs| tabs.get(tab_id).is_some_and(|entry| entry.visible))
            .unwrap_or(false)
    }

    fn mark_visible(&self, tab_id: &str, visible: bool) -> AppResult<()> {
        let mut tabs = self
            .tabs
            .lock()
            .map_err(|_| "browser tab registry lock is poisoned".to_string())?;
        if let Some(entry) = tabs.get_mut(tab_id) {
            entry.visible = visible;
        }
        Ok(())
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
        let load_app = app.clone();
        let load_tab_id = tab_id.to_string();
        let title_app = app.clone();
        let title_tab_id = tab_id.to_string();
        let webview = main_window
            .add_child(
                WebviewBuilder::new(label.clone(), WebviewUrl::External(parsed_url))
                    .focused(false)
                    .devtools(true)
                    .enable_clipboard_access()
                    .on_page_load(move |_webview, payload| {
                        let event = BrowserPageLoadEvent {
                            tab_id: load_tab_id.clone(),
                            url: payload.url().to_string(),
                            loading: payload.event() == PageLoadEvent::Started,
                        };
                        let _ = load_app.emit_to("main", "browser-page-load", event);
                    })
                    .on_document_title_changed(move |_webview, title| {
                        let event = BrowserTitleChangedEvent {
                            tab_id: title_tab_id.clone(),
                            title,
                        };
                        let _ = title_app.emit_to("main", "browser-title-changed", event);
                    }),
                bounds.logical_position(),
                bounds.logical_size(),
            )
            .map_err(|error| format!("failed to create browser webview: {error}"))?;

        if !visible {
            webview
                .hide()
                .map_err(|error| format!("failed to hide browser webview: {error}"))?;
        }

        self.tabs
            .lock()
            .map_err(|_| "browser tab registry lock is poisoned".to_string())?
            .insert(tab_id.to_string(), BrowserTabEntry { label, visible });
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
        self.mark_visible(tab_id, visible)
    }

    pub fn navigate(&self, app: &AppHandle, tab_id: &str, url: &str) -> AppResult<()> {
        let webview = self.webview(app, tab_id)?;
        let url = validate_browser_url(url)?;
        webview
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
        let entry = self
            .tabs
            .lock()
            .map_err(|_| "browser tab registry lock is poisoned".to_string())?
            .remove(tab_id);
        let Some(BrowserTabEntry { label, .. }) = entry else {
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
        self.call_cdp_with_timeout(app, tab_id, method, params_json, DEFAULT_CDP_TIMEOUT)
            .await
    }

    async fn call_cdp_with_timeout(
        &self,
        app: &AppHandle,
        tab_id: &str,
        method: &str,
        params_json: &str,
        timeout: std::time::Duration,
    ) -> AppResult<String> {
        call_devtools_protocol(self.webview(app, tab_id)?, method, params_json, timeout).await
    }

    pub async fn evaluate(&self, app: &AppHandle, tab_id: &str, script: &str) -> AppResult<String> {
        let result = self
            .call_cdp(
                app,
                tab_id,
                "Runtime.evaluate",
                &browser_evaluate_params(script),
            )
            .await?;
        Ok(truncate_cdp_result(&result, EVALUATE_RESULT_LIMIT_BYTES))
    }

    /// 截取标签当前可视区域。
    ///
    /// 隐藏的 WebView2 合成器停止产帧（实测 `requestAnimationFrame` 完全不触发），
    /// 此时 `Page.captureScreenshot` 会一直等不到帧、直到超时——对 agent 而言
    /// "开个后台标签再截图"是最常见的用法，命中率接近 100%。
    ///
    /// 因此隐藏标签会被**临时提为可见**以驱动出一帧，截完由守卫立刻复原。
    pub async fn screenshot(
        &self,
        app: &AppHandle,
        tab_id: &str,
        screenshots_dir: &Path,
    ) -> AppResult<PathBuf> {
        // 守卫在作用域内持有，任何早退路径都会复原隐藏状态。
        let _restore = if self.is_visible(tab_id) {
            None
        } else {
            self.set_visible(app, tab_id, true, false)?;
            self.await_composited_frame(app, tab_id).await?;
            Some(TemporaryVisibilityGuard {
                manager: self,
                app,
                tab_id: tab_id.to_string(),
            })
        };

        let result = self
            .call_cdp_with_timeout(
                app,
                tab_id,
                "Page.captureScreenshot",
                r#"{"format":"png","captureBeyondViewport":false}"#,
                SCREENSHOT_CDP_TIMEOUT,
            )
            .await
            .map_err(describe_screenshot_failure)?;
        save_browser_screenshot(&result, screenshots_dir, tab_id)
    }

    /// 等待刚提为可见的 webview 真正产出一帧。
    ///
    /// 用 `requestAnimationFrame` 而非固定 sleep：rAF 回调的触发本身就是
    /// "合成器已恢复"的证据，而固定 sleep 在慢机器上会偏短、在快机器上又白等。
    /// 拿不到帧不算致命——退回直接截图，由截图自己的超时兜底并给出可读错误。
    async fn await_composited_frame(&self, app: &AppHandle, tab_id: &str) -> AppResult<()> {
        let probe = self
            .call_cdp_with_timeout(
                app,
                tab_id,
                "Runtime.evaluate",
                &browser_evaluate_params(FIRST_FRAME_PROBE),
                FIRST_FRAME_TIMEOUT,
            )
            .await;
        if let Err(error) = probe {
            log::warn!("browser tab {tab_id} produced no frame after being shown: {error}");
        }
        Ok(())
    }

    pub async fn click(&self, app: &AppHandle, tab_id: &str, x: f64, y: f64) -> AppResult<()> {
        for params in browser_click_params(x, y)? {
            self.call_cdp(app, tab_id, "Input.dispatchMouseEvent", &params)
                .await?;
        }
        Ok(())
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
        let label = self.registered_label(tab_id)?;
        app.get_webview(&label)
            .ok_or_else(|| format!("browser webview is unavailable for tab: {tab_id}").into())
    }

    fn registered_label(&self, tab_id: &str) -> AppResult<String> {
        self.tabs
            .lock()
            .map_err(|_| "browser tab registry lock is poisoned".to_string())?
            .get(tab_id)
            .map(|entry| entry.label.clone())
            .ok_or_else(|| format!("unknown browser tab: {tab_id}").into())
    }
}

/// 把截图的超时翻译成可执行的诊断。
///
/// 走到这里意味着标签已被提为可见却仍拿不到帧，最常见的成因是整个主窗口
/// 不可见（最小化/隐藏到托盘）——此时任何子 webview 都不产帧，与标签自身
/// 的可见性无关。原文案只说"CDP method timed out"，无法区分。
fn describe_screenshot_failure(error: crate::utils::AppError) -> crate::utils::AppError {
    let message = error.to_string();
    if !message.contains("timed out") {
        return error;
    }
    "browser screenshot timed out: the page produced no frame. \
This usually means the CC-Panes window is minimized or hidden — a webview only \
composites while its host window is on screen. Restore the window and retry, or \
use browser_evaluate to read the page without a screenshot."
        .into()
}

fn browser_evaluate_params(script: &str) -> String {
    serde_json::json!({
        "expression": script,
        "returnByValue": true,
        "awaitPromise": true,
    })
    .to_string()
}

fn browser_click_params(x: f64, y: f64) -> AppResult<[String; 2]> {
    if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 {
        return Err("browser click coordinates must be finite non-negative values".into());
    }
    let params = |event_type: &str| {
        serde_json::json!({
            "type": event_type,
            "x": x,
            "y": y,
            "button": "left",
            "clickCount": 1,
        })
        .to_string()
    };
    Ok([params("mousePressed"), params("mouseReleased")])
}

fn save_browser_screenshot(response: &str, dir: &Path, tab_id: &str) -> AppResult<PathBuf> {
    let png = decode_cdp_screenshot(response)?;
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("failed to create browser screenshots directory: {error}"))?;
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S_%3f");
    let filename = format!(
        "{}_{}_{}.png",
        browser_webview_label(tab_id),
        timestamp,
        uuid::Uuid::new_v4().simple(),
    );
    let path = dir.join(filename);
    std::fs::write(&path, png)
        .map_err(|error| format!("failed to save browser screenshot: {error}"))?;
    Ok(path)
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
        "about" if url.as_str() == "about:blank" => Ok(url),
        scheme => Err(format!("unsupported browser URL scheme: {scheme}").into()),
    }
}

#[cfg(target_os = "windows")]
async fn call_devtools_protocol(
    webview: Webview,
    method: &str,
    params_json: &str,
    timeout: std::time::Duration,
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

    tokio::time::timeout(timeout, receiver)
        .await
        .map_err(|_| "CDP method timed out".to_string())?
        .map_err(|_| "CDP response channel closed".to_string())?
}

#[cfg(not(target_os = "windows"))]
async fn call_devtools_protocol(
    _webview: Webview,
    _method: &str,
    _params_json: &str,
    _timeout: std::time::Duration,
) -> AppResult<String> {
    Err("native WebView2 CDP is only available on Windows".into())
}

#[cfg(test)]
mod tests {
    use super::{
        browser_click_params, browser_evaluate_params, browser_webview_label,
        decode_cdp_screenshot, save_browser_screenshot, truncate_cdp_result, BrowserBounds,
        BrowserOpenTabEvent, BrowserTabManager, CDP_SPIKE_METHODS,
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
        let result = truncate_cdp_result("abc中文defghijklmnop", 20);

        assert_eq!(result, "abc中...[truncated]");
        assert!(result.len() <= 20);
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

    #[test]
    fn evaluate_params_preserve_script_and_request_return_value() {
        let params: serde_json::Value =
            serde_json::from_str(&browser_evaluate_params("document.title")).unwrap();

        assert_eq!(params["expression"], "document.title");
        assert_eq!(params["returnByValue"], true);
        assert_eq!(params["awaitPromise"], true);
    }

    #[test]
    fn click_params_emit_pressed_and_released_mouse_events() {
        let params = browser_click_params(12.5, 24.0).unwrap();
        let pressed: serde_json::Value = serde_json::from_str(&params[0]).unwrap();
        let released: serde_json::Value = serde_json::from_str(&params[1]).unwrap();

        assert_eq!(pressed["type"], "mousePressed");
        assert_eq!(released["type"], "mouseReleased");
        assert_eq!(pressed["x"], 12.5);
        assert_eq!(pressed["y"], 24.0);
        assert_eq!(pressed["button"], "left");
        assert_eq!(pressed["clickCount"], 1);
        assert!(browser_click_params(f64::NAN, 0.0).is_err());
        assert!(browser_click_params(-1.0, 0.0).is_err());
    }

    #[test]
    fn browser_screenshot_is_saved_with_a_safe_png_name() {
        let temp = tempfile::tempdir().unwrap();
        let png = [137, 80, 78, 71, 13, 10, 26, 10, 0];
        let data = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, png);

        let path = save_browser_screenshot(
            &serde_json::json!({ "data": data }).to_string(),
            temp.path(),
            "tab/unsafe:id",
        )
        .unwrap();

        assert_eq!(path.parent(), Some(temp.path()));
        assert_eq!(
            path.extension().and_then(|value| value.to_str()),
            Some("png")
        );
        assert!(!path.file_name().unwrap().to_string_lossy().contains('/'));
        assert_eq!(std::fs::read(path).unwrap(), png);
    }

    #[test]
    fn manager_rejects_tabs_outside_its_registry() {
        let manager = BrowserTabManager::default();

        assert!(manager.registered_label("unknown-tab").is_err());
        // 未注册的标签必须判为不可见，否则截图会跳过提帧、直接撞超时。
        assert!(!manager.is_visible("unknown-tab"));
    }

    #[test]
    fn visibility_is_tracked_so_screenshots_know_to_raise_a_frame() {
        let manager = BrowserTabManager::default();
        manager.tabs.lock().unwrap().insert(
            "tab-1".to_string(),
            super::BrowserTabEntry {
                label: "browser-tab-1".to_string(),
                visible: false,
            },
        );

        assert!(!manager.is_visible("tab-1"));
        manager.mark_visible("tab-1", true).unwrap();
        assert!(manager.is_visible("tab-1"));
        manager.mark_visible("tab-1", false).unwrap();
        assert!(!manager.is_visible("tab-1"));
    }

    #[test]
    fn screenshot_timeout_explains_the_no_frame_cause() {
        let translated = super::describe_screenshot_failure("CDP method timed out".into());
        let message = translated.to_string();

        // 必须点明"没有帧"和可执行的下一步，而不是只说超时。
        assert!(message.contains("no frame"));
        assert!(message.contains("minimized"));
        assert!(message.contains("browser_evaluate"));

        // 非超时错误必须原样透传，不能被这条文案盖掉真实成因。
        let other = super::describe_screenshot_failure("response is not a PNG".into());
        assert_eq!(other.to_string(), "response is not a PNG");
    }

    #[test]
    fn screenshot_timeout_is_shorter_than_the_generic_cdp_timeout() {
        // 截图要么很快返回要么根本拿不到帧，等满通用超时只是让调用方多卡几秒。
        assert!(super::SCREENSHOT_CDP_TIMEOUT < super::DEFAULT_CDP_TIMEOUT);
        assert!(super::FIRST_FRAME_TIMEOUT < super::SCREENSHOT_CDP_TIMEOUT);
    }

    #[test]
    fn first_frame_probe_waits_for_an_actual_composited_frame() {
        // 探针必须靠 rAF 而非 sleep：rAF 触发本身就是合成器已恢复的证据。
        assert!(super::FIRST_FRAME_PROBE.contains("requestAnimationFrame"));
        assert!(super::FIRST_FRAME_PROBE.starts_with("new Promise"));
    }

    #[test]
    fn open_tab_event_validates_url_and_derives_title() {
        let event = BrowserOpenTabEvent::try_new("http://localhost:5173", None).unwrap();

        assert_eq!(event.url, "http://localhost:5173/");
        assert_eq!(event.title, "localhost");
        assert!(event.tab_id.starts_with("tab-"));
        assert_eq!(event.request_id, None);
        assert_eq!(
            BrowserOpenTabEvent::try_new("https://example.com", Some(" Preview "))
                .unwrap()
                .title,
            "Preview"
        );
        assert!(BrowserOpenTabEvent::try_new("file:///tmp/a.html", None).is_err());
    }
}
