# 55. Browser tab spike conclusion

Date: 2026-07-25

## Decision

**GO** for phases 1 and 2 under the worker validation boundary: the child-WebView,
native WebView2 CDP, and per-WebView DevTools paths are implemented as a minimal
runnable harness, covered by focused assertions, and type-check on the Windows
MSVC target.

This is not a Windows desktop visual acceptance. The focus, mixed-DPI, rendered
placement, live CDP response, and DevTools-window observations remain in the
leader checklist below, as required by the worker instructions.

## Evidence

### 1. Multiwebview coexistence

- `tauri/unstable` is enabled only after confirming Tauri 2.11.0 exposes
  `Window::add_child` and the child `Webview` bounds/visibility/focus APIs.
- `BrowserTabManager::create` attaches a child WebView to the existing `main`
  window. It does not alter `TerminalView` or terminal lifecycle code.
- Position and size use `LogicalPosition<f64>` and `LogicalSize<f64>` directly
  from CSS `getBoundingClientRect()` values. No physical-pixel multiplication is
  applied, so WebView2/Tauri remains responsible for monitor scale conversion.
- The harness independently supports set bounds, show, hide, focus, and close.
- Focused tests verify logical values are preserved and invalid/empty regions are
  rejected. Stable hashed labels isolate multiple browser tabs.

### 2. CDP attach

Selected channel: **WebView2 native `CallDevToolsProtocolMethod`**.

- The Windows path obtains `ICoreWebView2` from the child WebView controller via
  `Webview::with_webview`; no remote-debugging port or websocket endpoint is
  opened.
- `BrowserTabManager::run_spike_probes` calls both required methods:
  `Runtime.evaluate` and `Page.captureScreenshot`.
- The screenshot probe decodes the returned base64 and requires a PNG signature;
  the evaluate response must be valid JSON without `exceptionDetails`.
- `cargo.exe check -p cc-panes --lib` type-checked the Windows-only COM path on
  `x86_64-pc-windows-msvc` with no warnings.

### 3. F12 / built-in DevTools

- The child is created with DevTools enabled.
- `BrowserTabManager::open_devtools` targets the registered child WebView rather
  than the main application WebView.
- The Tauri `devtools` feature keeps this path available outside debug builds.

## Automated checks

```text
cargo test -p cc-panes browser_service --lib
6 passed; 0 failed

cargo.exe check -p cc-panes --lib
Finished dev profile; 0 warnings
```

The focused tests cover logical bounds, invalid bounds, label isolation, required
CDP methods, UTF-8-safe result truncation, and PNG response validation.

## Windows host acceptance checklist

1. Open terminal and browser tabs in adjacent panes; confirm both render without
   clipping or z-order overlap.
2. Click the browser content, type into a page, then click the terminal and type;
   confirm neither transition creates a focus dead zone.
3. Resize each split direction and the main window; confirm the child WebView
   follows only its browser viewport.
4. Repeat at 100%, 125%, and 150% scale, including moving the window between
   monitors with different scale factors.
5. Run the spike probes against a loaded localhost page; require a successful
   `Runtime.evaluate` result and non-empty PNG capture.
6. Use the browser toolbar DevTools action (F12 affordance); confirm DevTools is
   attached to that browser tab, not the CC-Panes main WebView.
7. Switch tabs/layouts and close the browser tab; confirm the child is hidden and
   destroyed with no stale overlay.

Any failure in items 1-6 changes the runtime verdict to **NO-GO** and should stop
merge/release acceptance; the satellite-window fallback requires a separate plan.
