# Interface shape visual checklist

This checklist verifies the six color themes and six interface shapes without treating the terminal or editor as decorative surfaces. Run it in the Windows desktop build because WebView2 blur, wallpaper composition, native window chrome, and PTY-backed terminal rendering cannot be signed off by unit tests alone.

## Preconditions

- Run `npm run tauri:dev` on the Windows host.
- Open at least one terminal tab, the file explorer, Settings, a dialog, and an input field.
- Use a readable terminal sample containing normal text, ANSI colors, a selection, and a visible cursor.
- Repeat the Glass and Carbon checks once with no wallpaper and once with a wallpaper.
- Test at 1280 x 720 and one larger working size; record the second size below.

## Full combination scan

Each cell must be checked once. Record `pass`, `fail: <reason>`, or `blocked: <reason>`.

| Color theme | Soft | Slab | Sharp | Glass | Panel | Carbon |
|---|---|---|---|---|---|---|
| Midnight blue (`deep-ink`) | pending | pending | pending | pending | pending | pending |
| Neon violet (`cyber-purple`) | pending | pending | pending | pending | pending | pending |
| Molten gold (`amber-gold`) | pending | pending | pending | pending | pending | pending |
| Snow white (`classic-white`) | pending | pending | pending | pending | pending | pending |
| Warm mist (`warm-gray`) | pending | pending | pending | pending | pending | pending |
| Clear sky (`sky-blue`) | pending | pending | pending | pending | pending | pending |

## Per-combination checks

- The title bar, activity bar, sidebar, tab bar, status bar, settings surfaces, dialog, buttons, and inputs visibly follow the selected shape.
- Text, icons, focus rings, selected states, status states, and disabled controls remain readable.
- No label, badge, button, or preview clips or overlaps at either window size.
- Changing shape leaves the selected color theme unchanged; changing color leaves the selected shape unchanged.
- Terminal, Monaco, Mermaid, and other content canvases have no decorative texture, blur, new radius, or reduced contrast.
- Pane dimensions, typography, terminal theme, and status meaning remain unchanged.

## Shape-specific checks

- Soft matches the pre-change visual treatment and is used for legacy or invalid settings.
- Slab has tighter corners and restrained edge depth without creating double borders.
- Sharp removes container rounding without clipping focus rings or menus.
- Glass blurs translucent chrome while terminal and input backgrounds remain solid.
- Panel uses square corners and clearer dividers without changing pane sizes.
- Carbon texture stays low contrast, follows the active color tokens, and never reaches terminal or editor content.
- When WebView2 reports no `backdrop-filter` support, Glass and Carbon retain translucent surfaces and Settings shows the neutral fallback message.

## Interaction and persistence

- Every shape card is keyboard reachable, has a visible focus ring, and exposes its selected state without color alone.
- The restore action selects Soft, shows the completion toast, and persists after restarting the app.
- The feature tip shows all six previews; its action opens Settings at the Interface shape section.
- A desktop restart and a Web settings reload restore the same shape.
- The ccchan, popup, and WebGL diagnostic windows remain Soft and do not overwrite the main-window shape cache.

## Sign-off record

| Field | Value |
|---|---|
| Windows host | Windows PowerShell; repository at `F:\C26\demo\cc-pane-new` |
| WebView2 version | pending |
| Window sizes | `1280 x 720`; larger size pending |
| Commit or working tree | `498744b` plus the uncommitted appearance change |
| Tester | Codex automated checks; desktop visual signer pending |
| Date | 2026-08-06 |
| Result | blocked: no connected browser or desktop visual harness; 36-cell matrix remains pending |
| Notes / screenshots | Vite preview is running at `http://127.0.0.1:5173`; no screenshot evidence captured |
