//! Exercises the production BrowserTabManager against an owned local fixture.
//! No production setup, user profile, daemon, or desktop capture is involved.
//! Run: cargo run -p cc-panes --example browser_macos_smoke -- /absolute/evidence/dir

#[cfg(target_os = "macos")]
mod macos {
    use cc_panes_lib::services::{BrowserBounds, BrowserTabManager};
    use cc_panes_lib::utils::AppResult;
    use serde_json::{json, Value};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::Duration;
    use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

    const TAB: &str = "owned-browser-acceptance";
    const HTML: &str = r#"<!doctype html><meta charset="utf-8"><title>CC-Panes owned browser fixture</title>
<style>body{margin:0;background:#1375cb}button{position:absolute;left:20px;top:20px;width:100px;height:50px}#red{position:absolute;left:200px;top:100px;width:80px;height:80px;background:#e31c2c}</style>
<button id="click">Click fixture</button><div id="red"></div>
<script>window.fixture={clicks:0,trusted:false};document.getElementById('click').onclick=e=>{fixture.clicks++;fixture.trusted=e.isTrusted};</script>"#;

    fn serve_fixture() -> std::io::Result<String> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let url = format!("http://{}/", listener.local_addr()?);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut request = [0; 1024];
                if stream.read(&mut request).is_err() {
                    continue;
                }
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", HTML.len(), HTML);
                let _ = stream.write_all(response.as_bytes());
            }
        });
        Ok(url)
    }

    async fn evaluate(
        manager: &BrowserTabManager,
        app: &AppHandle,
        script: &str,
    ) -> AppResult<Value> {
        serde_json::from_str(&manager.evaluate(app, TAB, script).await?)
            .map_err(|error| error.to_string().into())
    }

    async fn run(
        manager: Arc<BrowserTabManager>,
        app: AppHandle,
        dir: PathBuf,
        url: String,
    ) -> AppResult<Value> {
        manager.create(
            &app,
            TAB,
            &url,
            BrowserBounds::try_new(20.0, 20.0, 600.0, 400.0)?,
            true,
        )?;
        for _ in 0..100 {
            let value = evaluate(&manager, &app, "typeof window.fixture === 'object'").await?;
            if value["result"]["value"] == true {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let initial = evaluate(
            &manager,
            &app,
            "Promise.resolve({title:document.title, ready:!!window.fixture, number:42})",
        )
        .await?;
        if initial["result"]["value"]["ready"] != true || initial["result"]["value"]["number"] != 42
        {
            return Err(format!("fixture did not finish loading: {initial}").into());
        }
        let exception =
            evaluate(&manager, &app, "throw new Error('owned fixture exception')").await?;
        if !exception["exceptionDetails"]["text"]
            .as_str()
            .is_some_and(|text| text.contains("owned fixture exception"))
        {
            return Err("JavaScript exception was not returned".into());
        }
        let statement = evaluate(&manager, &app, "window.statementExecutions = (window.statementExecutions || 0) + 1; window.statementExecutions").await?;
        if statement["result"]["value"] != 1 {
            return Err(format!(
                "statement completion or execution count is incorrect: {statement}"
            )
            .into());
        }
        manager.click(&app, TAB, 50.0, 40.0).await?;
        let clicked = evaluate(
            &manager,
            &app,
            "new Promise(resolve => setTimeout(() => resolve(window.fixture), 50))",
        )
        .await?;
        if clicked["result"]["value"]["clicks"] != 1
            || clicked["result"]["value"]["trusted"] != true
        {
            return Err(format!("native trusted click failed: {clicked}").into());
        }
        if manager.click(&app, TAB, 10_000.0, 10_000.0).await.is_ok() {
            return Err("out-of-bounds click unexpectedly succeeded".into());
        }
        let timeout_started = std::time::Instant::now();
        // Keep the resolver reachable: WebKit detects abandoned Promises and
        // reports a JavaScript exception before the host timeout otherwise.
        let timeout = match manager
            .evaluate(
                &app,
                TAB,
                "new Promise(resolve => { window.fixtureResolve = resolve; })",
            )
            .await
        {
            Err(error) => error,
            Ok(result) => {
                return Err(
                    format!("reachable unresolved Promise did not time out: {result}").into(),
                )
            }
        };
        if !timeout.to_string().contains("timed out") {
            return Err(timeout);
        }
        let timeout_ms = timeout_started.elapsed().as_millis();
        evaluate(
            &manager,
            &app,
            "window.fixtureResolve(); delete window.fixtureResolve",
        )
        .await?;
        let image = manager.screenshot(&app, TAB, &dir).await?;
        let dimensions = verify_image(&image)?;
        manager.set_visible(&app, TAB, false, false)?;
        let hidden_image = manager.screenshot(&app, TAB, &dir).await?;
        verify_image(&hidden_image)?;
        let view = app
            .webviews()
            .into_values()
            .find(|view| view.label().starts_with("browser-"))
            .ok_or("fixture webview disappeared")?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        view.with_webview(move |platform| {
            let wk = unsafe { &*platform.inner().cast::<objc2_web_kit::WKWebView>() };
            let _ = sender.send(wk.isHidden());
        })
        .map_err(|error| error.to_string())?;
        if !tokio::time::timeout(Duration::from_secs(2), receiver)
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?
        {
            return Err("hidden screenshot left the fixture visible".into());
        }
        manager.close(&app, TAB)?;
        if manager.evaluate(&app, TAB, "1").await.is_ok() {
            return Err("closed browser tab unexpectedly evaluated".into());
        }
        Ok(
            json!({"success": true, "backend":"WKWebView", "promise":initial, "exception":exception, "statement":statement, "evaluationTimeoutMs":timeout_ms,
            "nativeClick":clicked, "png":image, "pngDimensions":dimensions, "hiddenPng":hidden_image,
            "hiddenStateRestored":true, "outOfBoundsRejected":true, "closedTabRejected":true}),
        )
    }

    fn verify_image(path: &Path) -> AppResult<(u32, u32)> {
        let image = image::open(path)
            .map_err(|error| error.to_string())?
            .to_rgb8();
        let (width, height) = image.dimensions();
        if width < 600 || height < 400 || width * 2 != height * 3 {
            return Err(
                format!("unexpected fixture screenshot dimensions: {width}x{height}").into(),
            );
        }
        let red = image.get_pixel(width * 240 / 600, height * 140 / 400).0;
        let blue = image.get_pixel(width * 400 / 600, height * 200 / 400).0;
        if red[0] < 180 || red[1] > 80 || blue[2] < 160 || blue[0] > 70 {
            return Err(format!(
                "fixture screenshot pixels do not match: red={red:?}, blue={blue:?}"
            )
            .into());
        }
        Ok((width, height))
    }

    pub fn main() {
        let dir = std::env::args()
            .nth(1)
            .map(PathBuf::from)
            .expect("provide an evidence directory");
        std::fs::create_dir_all(&dir).expect("create evidence directory");
        let url = serve_fixture().expect("start local fixture server");
        let manager = Arc::new(BrowserTabManager::default());
        let mut context = tauri::generate_context!();
        context.config_mut().identifier = "com.ccpanes.browser-acceptance".into();
        context.config_mut().app.windows.clear();
        tauri::Builder::default()
            .setup(move |app| {
                WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                    .title("CC-Panes owned browser acceptance fixture")
                    .inner_size(640.0, 460.0)
                    .build()?;
                let handle = app.handle().clone();
                let manager = Arc::clone(&manager);
                tauri::async_runtime::spawn(async move {
                    let result = tokio::time::timeout(
                        Duration::from_secs(35),
                        run(manager, handle.clone(), dir.clone(), url),
                    )
                    .await;
                    let report = match result {
                        Ok(Ok(report)) => report,
                        Ok(Err(error)) => json!({"success":false,"error":error.to_string()}),
                        Err(error) => json!({"success":false,"error":error.to_string()}),
                    };
                    let status = if report["success"] == true { 0 } else { 1 };
                    let serialized = serde_json::to_string_pretty(&report).unwrap();
                    let _ = std::fs::write(dir.join("browser-macos-smoke.json"), &serialized);
                    println!("{serialized}");
                    handle.exit(status);
                });
                Ok(())
            })
            .run(context)
            .expect("run owned browser fixture");
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    macos::main();
    #[cfg(not(target_os = "macos"))]
    eprintln!("browser_macos_smoke requires macOS");
}
