//! Favicon extraction stays in the page origin and returns a bounded raster asset.
use super::*;

const METADATA_SCRIPT: &str = r#"(async () => {
  const result = { title: document.title, faviconUrl: '' };
  const candidate = document.querySelector('link[rel~="icon" i]')?.href;
  if (candidate && /^data:image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=]+$/i.test(candidate)) {
    if (candidate.length <= 131072) result.faviconUrl = candidate;
    return result;
  }
  const url = new URL(candidate || '/favicon.ico', location.href);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== location.origin || url.username || url.password) return result;
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 2000);
  try {
    const response = await fetch(url.href, { credentials:'same-origin', redirect:'error', signal:abort.signal });
    if (!response.ok || !response.body) return result;
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['image/png','image/jpeg','image/gif','image/webp','image/x-icon','image/vnd.microsoft.icon'].includes(mime)) return result;
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength;
      if (size > 96000) { await reader.cancel(); return result; } chunks.push(item.value); }
    let raw = ''; for (const chunk of chunks) for (const byte of chunk) raw += String.fromCharCode(byte);
    result.faviconUrl = 'data:' + mime + ';base64,' + btoa(raw);
  } catch {} finally { clearTimeout(timer); }
  return result;
})()"#;

fn bounded_raster(value: &str) -> Option<String> {
    if value.len() > 131_072 {
        return None;
    }
    let (prefix, encoded) = value.split_once(",")?;
    let mime = prefix.strip_prefix("data:")?.strip_suffix(";base64")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let valid = match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        "image/x-icon" | "image/vnd.microsoft.icon" => bytes.starts_with(&[0, 0, 1, 0]),
        _ => false,
    };
    valid.then(|| value.to_string())
}

pub(super) fn refresh(
    app: AppHandle,
    view: Webview,
    tab_id: String,
    page: std::sync::Arc<Mutex<BrowserPageState>>,
) {
    let generation = match page.lock() {
        Ok(state) => state.generation,
        Err(_) => return,
    };
    let url = match view.url() {
        Ok(url) => url,
        Err(_) => return,
    };
    tauri::async_runtime::spawn(async move {
        let Ok(raw) = call_devtools_protocol(
            view.clone(),
            "Runtime.evaluate",
            &browser_evaluate_params(METADATA_SCRIPT),
            std::time::Duration::from_secs(3),
            None,
        )
        .await
        else {
            return;
        };
        if page
            .lock()
            .map(|state| state.generation != generation)
            .unwrap_or(true)
            || view.url().ok().as_ref() != Some(&url)
        {
            return;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            return;
        };
        let data = &value["result"]["value"];
        let Some(title) = data["title"].as_str() else {
            return;
        };
        let event = BrowserTitleChangedEvent {
            tab_id,
            title: title.chars().take(512).collect(),
            favicon_url: Some(
                data["faviconUrl"]
                    .as_str()
                    .and_then(bounded_raster)
                    .unwrap_or_default(),
            ),
        };
        let _ = app.emit_to("main", "browser-title-changed", &event);
        if view.window().label() != "main" {
            let _ = app.emit_to(view.window().label(), "browser-title-changed", &event);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_bounded_raster_data_not_svg_or_external_requests() {
        let png = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\n")
        );
        assert!(bounded_raster(&png).is_some());
        assert!(bounded_raster("https://example.com/favicon.ico").is_none());
        assert!(bounded_raster("data:image/svg+xml;base64,PHN2Zz4=").is_none());
        assert!(bounded_raster("data:image/png;base64,PHN2Zz4=").is_none());
        assert!(bounded_raster(&format!("data:image/png;base64,{}", "A".repeat(131072))).is_none());
    }
}
