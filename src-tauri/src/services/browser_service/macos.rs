//! WKWebView implementation of the three browser operations CC-Panes exposes.
//! This is deliberately not a general CDP server: unsupported methods fail.

use crate::utils::AppResult;
use base64::Engine;
use block2::RcBlock;
use objc2::{
    rc::{Retained, Weak},
    runtime::AnyObject,
    runtime::NSObjectProtocol,
    MainThreadMarker,
};
use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType, NSImage, NSResponder};
use objc2_foundation::{
    NSError, NSJSONSerialization, NSJSONWritingOptions, NSNotFound, NSNull, NSNumber, NSPoint,
    NSProcessInfo, NSRange, NSString,
};
use objc2_web_kit::{
    WKContentWorld, WKErrorCode, WKErrorDomain, WKSnapshotConfiguration, WKWebView,
};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Webview;
use tokio::sync::oneshot;

type Reply = Arc<Mutex<Option<oneshot::Sender<AppResult<String>>>>>;

#[derive(Debug)]
enum Operation {
    Evaluate {
        expression: String,
        await_promise: bool,
    },
    Snapshot,
    Mouse {
        x: f64,
        y: f64,
        pressed: bool,
    },
    Text(String),
    Key {
        key: String,
        pressed: bool,
    },
}

impl Operation {
    fn parse(method: &str, params: &str) -> AppResult<Self> {
        let params: Value = serde_json::from_str(params)
            .map_err(|error| format!("invalid browser parameters: {error}"))?;
        match method {
            "Runtime.evaluate" => {
                let expression = params["expression"]
                    .as_str()
                    .ok_or("browser expression is required")?;
                if params["returnByValue"].as_bool() != Some(true) {
                    return Err("WKWebView evaluation requires returnByValue=true".into());
                }
                Ok(Self::Evaluate {
                    expression: expression.to_string(),
                    await_promise: params["awaitPromise"].as_bool().unwrap_or(false),
                })
            }
            "Page.captureScreenshot" => {
                if params["format"]
                    .as_str()
                    .is_some_and(|format| format != "png")
                    || params["captureBeyondViewport"].as_bool() == Some(true)
                    || !params["clip"].is_null()
                {
                    return Err(
                        "WKWebView screenshots support PNG of the current viewport only".into(),
                    );
                }
                Ok(Self::Snapshot)
            }
            "Input.dispatchMouseEvent" => Self::mouse(&params),
            "Input.insertText" => {
                let text = params["text"]
                    .as_str()
                    .ok_or("browser input text is required")?;
                if text.len() > 32 * 1024 || text.contains('\0') {
                    return Err("browser input text is too large or contains NUL".into());
                }
                Ok(Self::Text(text.into()))
            }
            "Input.dispatchKeyEvent" => {
                let key = params["key"].as_str().ok_or("browser key is required")?;
                super::computer_use::key_description(key)?;
                let pressed = match params["type"].as_str() {
                    Some("keyDown") => true,
                    Some("keyUp") => false,
                    _ => return Err("browser key event must be keyDown or keyUp".into()),
                };
                Ok(Self::Key {
                    key: key.into(),
                    pressed,
                })
            }
            _ => Err(format!("browser method is not supported by WKWebView: {method}").into()),
        }
    }

    fn mouse(params: &Value) -> AppResult<Self> {
        let x = params["x"].as_f64().ok_or("browser click x is required")?;
        let y = params["y"].as_f64().ok_or("browser click y is required")?;
        super::browser_click_params(x, y)?;
        if params["button"].as_str() != Some("left") || params["clickCount"].as_u64() != Some(1) {
            return Err("WKWebView supports a single left click".into());
        }
        let pressed = match params["type"].as_str() {
            Some("mousePressed") => true,
            Some("mouseReleased") => false,
            _ => return Err("WKWebView supports mousePressed and mouseReleased".into()),
        };
        Ok(Self::Mouse { x, y, pressed })
    }
}

pub(super) async fn call(
    webview: Webview,
    method: &str,
    params: &str,
    timeout: Duration,
    input_guard: Option<super::BrowserInputGuard>,
) -> AppResult<String> {
    let operation = Operation::parse(method, params)?;
    let (sender, receiver) = oneshot::channel();
    let reply = Arc::new(Mutex::new(Some(sender)));
    webview
        .with_webview(move |platform| {
            if is_closed(&reply) {
                return;
            }
            let Some(mtm) = MainThreadMarker::new() else {
                complete(
                    &reply,
                    Err("WKWebView operation was not dispatched to the main thread".into()),
                );
                return;
            };
            // Tauri owns this WKWebView throughout the callback. Never carry its
            // pointer or any other AppKit object across the async/thread boundary.
            let Some(wk) = (unsafe { platform.inner().cast::<WKWebView>().as_ref() }) else {
                complete(&reply, Err("native WKWebView is unavailable".into()));
                return;
            };
            if let Some(guard) = input_guard {
                let current_url = unsafe { wk.URL() }
                    .and_then(|url| url.absoluteString())
                    .map(|url| url.to_string())
                    .unwrap_or_default();
                if let Err(error) = guard.validate(&current_url) {
                    complete(&reply, Err(error));
                    return;
                }
            }
            match operation {
                Operation::Evaluate {
                    expression,
                    await_promise,
                } => evaluate(wk, mtm, expression, await_promise, reply),
                Operation::Snapshot => snapshot(wk, mtm, reply),
                Operation::Mouse { x, y, pressed } => complete(&reply, mouse(wk, x, y, pressed)),
                Operation::Text(text) => complete(&reply, insert_text(wk, &text)),
                Operation::Key { key, pressed } => complete(&reply, keyboard(wk, &key, pressed)),
            }
        })
        .map_err(|error| format!("failed to access native browser webview: {error}"))?;
    tokio::time::timeout(timeout, receiver)
        .await
        .map_err(|_| format!("WKWebView {method} timed out; the page may be busy or unavailable"))?
        .map_err(|_| "WKWebView response channel closed".to_string())?
}

fn complete(reply: &Reply, result: AppResult<String>) {
    if let Ok(mut sender) = reply.lock() {
        if let Some(sender) = sender.take() {
            let _ = sender.send(result);
        }
    }
}

fn is_closed(reply: &Reply) -> bool {
    reply
        .lock()
        .map(|sender| sender.as_ref().is_none_or(oneshot::Sender::is_closed))
        .unwrap_or(true)
}

fn evaluate(
    wk: &WKWebView,
    mtm: MainThreadMarker,
    expression: String,
    await_promise: bool,
    reply: Reply,
) {
    // The application's deployment target is 10.15. This API arrived in 11.0;
    // never dispatch an unavailable selector on an older supported OS.
    if !wk.respondsToSelector(
        objc2::sel!(callAsyncJavaScript:arguments:inFrame:inContentWorld:completionHandler:),
    ) {
        complete(
            &reply,
            Err("browser evaluation requires macOS 11 or later".into()),
        );
        return;
    }
    let script = include_str!("evaluate_macos.js")
        .replacen(
            "__CC_AWAIT__",
            if await_promise { "true" } else { "false" },
            1,
        )
        .replacen("__CC_EXPRESSION__", &expression, 1);
    let fallback_view = Weak::new(wk);
    let callback = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
        if is_closed(&reply) {
            return;
        }
        let result = unsafe {
            if let Some(error) = error.as_ref() {
                // Only compilation failure retries the raw statement script.
                // Runtime exceptions are caught by the wrapper; side effects
                // therefore never run twice. Preserve synchronous completion
                // values (e.g. `let x = 2; x`) with WebKit's script evaluator.
                if is_javascript_error(error) && error_message(error).starts_with("SyntaxError:") {
                    if let Some(wk) = fallback_view.load() {
                        evaluate_statements(&wk, &expression, Arc::clone(&reply));
                        return;
                    }
                }
                native_error(error)
            } else {
                value
                    .as_ref()
                    .and_then(|value| value.downcast_ref::<NSString>())
                    .map(ToString::to_string)
                    .ok_or_else(|| "WKWebView evaluation returned no serialized value".into())
            }
        };
        complete(&reply, result);
    });
    // WebKit copies the completion block until the async operation finishes.
    unsafe {
        wk.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
            &NSString::from_str(&script),
            None,
            None,
            &WKContentWorld::pageWorld(mtm),
            Some(&callback),
        );
    }
}

fn evaluate_statements(wk: &WKWebView, script: &str, reply: Reply) {
    let callback = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
        if is_closed(&reply) {
            return;
        }
        let result = unsafe {
            if let Some(error) = error.as_ref() {
                native_error(error)
            } else {
                native_value(value.as_ref())
            }
        };
        complete(&reply, result);
    });
    unsafe {
        wk.evaluateJavaScript_completionHandler(&NSString::from_str(script), Some(&callback));
    }
}

fn is_javascript_error(error: &NSError) -> bool {
    &*error.domain() == unsafe { WKErrorDomain }
        && error.code() == WKErrorCode::JavaScriptExceptionOccurred.0
}

fn error_message(error: &NSError) -> String {
    error
        .userInfo()
        .objectForKey(&NSString::from_str("WKJavaScriptExceptionMessage"))
        .and_then(|value| value.downcast_ref::<NSString>().map(ToString::to_string))
        .unwrap_or_else(|| error.localizedDescription().to_string())
}

fn native_error(error: &NSError) -> AppResult<String> {
    let description = error_message(error);
    if is_javascript_error(error) {
        return Ok(serde_json::json!({ "result":{"type":"object","subtype":"error","description":description},
            "exceptionDetails":{"text":description,"exception":{"type":"object","subtype":"error","description":description}} }).to_string());
    }
    if error.code() == WKErrorCode::JavaScriptResultTypeIsUnsupported.0 {
        return Err(format!("WKWebView could not return this script value: {description}. For asynchronous statement blocks, return the Promise from an async IIFE: (async () => {{ ... }})()").into());
    }
    Err(format!("WKWebView evaluation failed: {description}").into())
}

fn native_value(value: Option<&AnyObject>) -> AppResult<String> {
    let Some(value) = value else {
        return Ok(r#"{"result":{"type":"undefined"}}"#.to_string());
    };
    if let Some(number) = value.downcast_ref::<NSNumber>() {
        let number = number.doubleValue();
        if !number.is_finite() || (number == 0.0 && number.is_sign_negative()) {
            let text = if number.is_nan() {
                "NaN"
            } else if number == f64::INFINITY {
                "Infinity"
            } else if number == f64::NEG_INFINITY {
                "-Infinity"
            } else {
                "-0"
            };
            return Ok(
                serde_json::json!({"result":{"type":"number","unserializableValue":text}})
                    .to_string(),
            );
        }
    }
    // Foundation throws for unsupported objects. Validate containers and only
    // allow the supported scalar classes before calling its JSON encoder.
    let scalar = value.downcast_ref::<NSString>().is_some()
        || value.downcast_ref::<NSNumber>().is_some()
        || value.downcast_ref::<NSNull>().is_some();
    if !scalar && !unsafe { NSJSONSerialization::isValidJSONObject(value) } {
        return Err(
            "WKWebView returned a non-JSON value; return a serializable value from an IIFE".into(),
        );
    }
    let data = unsafe {
        NSJSONSerialization::dataWithJSONObject_options_error(
            value,
            NSJSONWritingOptions::FragmentsAllowed,
        )
    }
    .map_err(|error| {
        format!(
            "failed to serialize WKWebView value: {}",
            error.localizedDescription()
        )
    })?;
    let value: Value = serde_json::from_slice(&data.to_vec()).map_err(|error| error.to_string())?;
    let kind = match &value {
        Value::Null | Value::Array(_) | Value::Object(_) => "object",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
    };
    let mut result = serde_json::json!({"type":kind,"value":value});
    if value.is_null() {
        result["subtype"] = "null".into();
    } else if value.is_array() {
        result["subtype"] = "array".into();
    }
    Ok(serde_json::json!({"result":result}).to_string())
}

fn snapshot(wk: &WKWebView, mtm: MainThreadMarker, reply: Reply) {
    let bounds = wk.bounds();
    let scale = wk
        .window()
        .map(|window| window.backingScaleFactor())
        .unwrap_or(1.0);
    if let Err(error) = validate_snapshot_size(bounds.size.width, bounds.size.height, scale) {
        complete(&reply, Err(error));
        return;
    }
    let callback = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
        if is_closed(&reply) {
            return;
        }
        let result = unsafe {
            if let Some(error) = error.as_ref() {
                Err(format!(
                    "WKWebView screenshot failed: {}",
                    error.localizedDescription()
                )
                .into())
            } else if let Some(image) = image.as_ref() {
                image
                    .TIFFRepresentation()
                    .map(|data| data.to_vec())
                    .ok_or_else(|| "WKWebView image has no raster data".into())
            } else {
                Err("WKWebView screenshot returned no image".into())
            }
        };
        match result {
            Ok(tiff) => {
                // Keep AppKit on the main thread. Compression and base64
                // encoding operate on owned bytes in the blocking pool.
                let reply = Arc::clone(&reply);
                tauri::async_runtime::spawn_blocking(move || {
                    if !is_closed(&reply) {
                        complete(&reply, png_response(&tiff));
                    }
                });
            }
            Err(error) => complete(&reply, Err(error)),
        }
    });
    unsafe {
        let configuration = WKSnapshotConfiguration::new(mtm);
        configuration.setRect(bounds);
        configuration.setAfterScreenUpdates(true);
        wk.takeSnapshotWithConfiguration_completionHandler(Some(&configuration), &callback);
    }
}

fn png_response(tiff: &[u8]) -> AppResult<String> {
    let image = image::load_from_memory_with_format(tiff, image::ImageFormat::Tiff)
        .map_err(|error| format!("WKWebView image could not be decoded: {error}"))?;
    let mut png = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|error| format!("WKWebView image could not be encoded as PNG: {error}"))?;
    Ok(serde_json::json!({ "data": base64::engine::general_purpose::STANDARD.encode(png.into_inner()) }).to_string())
}

fn validate_snapshot_size(width: f64, height: f64, scale: f64) -> AppResult<()> {
    if ![width, height, scale]
        .iter()
        .all(|value| value.is_finite() && *value > 0.0)
    {
        return Err("browser viewport is empty or invalid".into());
    }
    if width * height * scale * scale > 64_000_000.0 {
        return Err("browser screenshot exceeds the 64 megapixel limit".into());
    }
    Ok(())
}

fn mouse(wk: &WKWebView, x: f64, y: f64, pressed: bool) -> AppResult<String> {
    let window = wk.window().ok_or("browser webview has no host window")?;
    let bounds = wk.bounds();
    let zoom = if wk.respondsToSelector(objc2::sel!(pageZoom)) {
        unsafe { wk.pageZoom() }
    } else {
        1.0
    };
    let (x, y) = click_point(
        x,
        y,
        bounds.size.width,
        bounds.size.height,
        zoom,
        wk.isFlipped(),
    )?;
    let local = NSPoint::new(bounds.origin.x + x, bounds.origin.y + y);
    let in_superview = wk.convertPoint_toView(local, unsafe { wk.superview() }.as_deref());
    let target = wk
        .hitTest(in_superview)
        .ok_or("browser click did not hit a visible webview")?;
    let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        if pressed { NSEventType::LeftMouseDown } else { NSEventType::LeftMouseUp },
        wk.convertPoint_toView(local, None), NSEventModifierFlags::empty(),
        NSProcessInfo::processInfo().systemUptime(), window.windowNumber(), None, 0, 1, if pressed { 1.0 } else { 0.0 },
    ).ok_or("failed to create native browser mouse event")?;
    if pressed {
        target.mouseDown(&event);
    } else {
        target.mouseUp(&event);
    }
    Ok("{}".to_string())
}

fn input_responder(wk: &WKWebView) -> AppResult<Retained<NSResponder>> {
    let window = wk.window().ok_or("browser webview has no host window")?;
    if !window.makeFirstResponder(Some(wk)) {
        return Err("browser webview could not accept keyboard focus".into());
    }
    window
        .firstResponder()
        .ok_or_else(|| "browser has no keyboard responder".into())
}

fn insert_text(wk: &WKWebView, text: &str) -> AppResult<String> {
    let responder = input_responder(wk)?;
    let selector = objc2::sel!(insertText:replacementRange:);
    if !responder.respondsToSelector(selector) {
        return Err("browser focused view does not support native text insertion".into());
    }
    let text = NSString::from_str(text);
    // NSTextInputClient's public insertion method replaces the current DOM
    // selection. The responder and NSString remain on the AppKit main thread.
    let _: () = unsafe {
        objc2::msg_send![&*responder, insertText: &*text, replacementRange: NSRange::new(NSNotFound as usize, 0)]
    };
    Ok("{}".into())
}

fn keyboard(wk: &WKWebView, key: &str, pressed: bool) -> AppResult<String> {
    let (code, characters) = match key {
        "Enter" => (36, "\r"),
        "Tab" => (48, "\t"),
        "Escape" => (53, "\u{1b}"),
        "Backspace" => (51, "\u{7f}"),
        "Delete" => (117, "\u{f728}"),
        "ArrowLeft" => (123, "\u{f702}"),
        "ArrowRight" => (124, "\u{f703}"),
        "ArrowUp" => (126, "\u{f700}"),
        "ArrowDown" => (125, "\u{f701}"),
        "Home" => (115, "\u{f729}"),
        "End" => (119, "\u{f72b}"),
        "PageUp" => (116, "\u{f72c}"),
        "PageDown" => (121, "\u{f72d}"),
        _ => return Err("unsupported native browser key".into()),
    };
    let responder = input_responder(wk)?;
    let window = wk.window().ok_or("browser webview has no host window")?;
    let characters = NSString::from_str(characters);
    let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
        if pressed { NSEventType::KeyDown } else { NSEventType::KeyUp }, NSPoint::new(0.0, 0.0), NSEventModifierFlags::empty(),
        NSProcessInfo::processInfo().systemUptime(), window.windowNumber(), None, &characters, &characters, false, code,
    ).ok_or("failed to create native browser key event")?;
    if pressed {
        responder.keyDown(&event);
    } else {
        responder.keyUp(&event);
    }
    Ok("{}".into())
}

fn click_point(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    zoom: f64,
    flipped: bool,
) -> AppResult<(f64, f64)> {
    if ![x, y, width, height, zoom]
        .iter()
        .all(|value| value.is_finite())
        || zoom <= 0.0
    {
        return Err("browser click geometry is invalid".into());
    }
    let (x, y) = (x * zoom, y * zoom);
    if x < 0.0 || y < 0.0 || x >= width || y >= height {
        return Err("browser click is outside the current viewport".into());
    }
    Ok((x, if flipped { y } else { height - y }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_geometry_is_bounded_before_native_allocation() {
        assert!(validate_snapshot_size(3840.0, 2160.0, 2.0).is_ok());
        assert!(validate_snapshot_size(0.0, 2160.0, 2.0).is_err());
        assert!(validate_snapshot_size(f64::NAN, 2160.0, 2.0).is_err());
        assert!(validate_snapshot_size(8000.0, 8000.0, 2.0).is_err());
    }

    #[test]
    fn blocking_png_encoder_preserves_fixture_pixels() {
        let image = image::RgbImage::from_pixel(4, 3, image::Rgb([220, 30, 40]));
        let mut tiff = std::io::Cursor::new(Vec::new());
        image.write_to(&mut tiff, image::ImageFormat::Tiff).unwrap();
        let response = png_response(tiff.get_ref()).unwrap();
        let png = super::super::decode_cdp_screenshot(&response).unwrap();
        let image = image::load_from_memory(&png).unwrap().to_rgb8();
        assert_eq!(image.dimensions(), (4, 3));
        assert_eq!(image.get_pixel(2, 1).0, [220, 30, 40]);
        assert!(png_response(b"not an image").is_err());
    }

    #[test]
    fn unsupported_protocol_features_fail_explicitly() {
        assert!(Operation::parse("Network.enable", "{}").is_err());
        assert!(Operation::parse("Runtime.evaluate", r#"{"expression":"1"}"#).is_err());
        assert!(Operation::parse("Page.captureScreenshot", r#"{"format":"jpeg"}"#).is_err());
        assert!(Operation::parse(
            "Page.captureScreenshot",
            r#"{"captureBeyondViewport":true}"#
        )
        .is_err());
        assert!(Operation::parse("Page.captureScreenshot", r#"{"clip":{}}"#).is_err());
        assert!(Operation::parse("Page.captureScreenshot", "not-json").is_err());
    }

    #[test]
    fn native_click_converts_css_pixels_and_rejects_out_of_bounds() {
        assert_eq!(
            click_point(20.0, 40.0, 400.0, 300.0, 1.5, false).unwrap(),
            (30.0, 240.0)
        );
        assert_eq!(
            click_point(20.0, 40.0, 400.0, 300.0, 1.5, true).unwrap(),
            (30.0, 60.0)
        );
        assert!(click_point(400.0, 0.0, 400.0, 300.0, 1.0, true).is_err());
        assert!(click_point(-1.0, 0.0, 400.0, 300.0, 1.0, true).is_err());
        assert!(click_point(0.0, f64::NAN, 400.0, 300.0, 1.0, true).is_err());
        assert!(click_point(0.0, 0.0, 400.0, 300.0, 0.0, true).is_err());
    }

    #[tokio::test]
    async fn late_native_callback_is_safe_after_timeout_or_cancellation() {
        let (sender, receiver) = oneshot::channel();
        let reply = Arc::new(Mutex::new(Some(sender)));
        drop(receiver);
        assert!(is_closed(&reply));
        complete(&reply, Ok("late".into()));
        complete(&reply, Ok("duplicate".into()));
        assert!(is_closed(&reply));
    }
}
