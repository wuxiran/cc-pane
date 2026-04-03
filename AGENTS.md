# Repository Environment Boundary

- This repository supports development and verification across multiple environments, including WSL, Linux, Windows, and CI.
- When platform behavior matters, separate guidance into `current-environment-verifiable` and `Windows-host-required`.
- Do not claim Windows desktop behavior is verified from WSL or non-Windows environments alone.
- Windows-host-required validation includes app startup on Windows, WebView2 behavior, tray behavior, global shortcuts, screenshot flow, updater or installer behavior, and Win32 or Windows PTY specifics.
- When working from WSL, prefer editing and preflight checks there, then validate Windows desktop behavior on the Windows host using the same branch or a built installer.
