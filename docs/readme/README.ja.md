<h1 align="center">
  <a href="https://github.com/wuxiran/cc-pane"><img src="../../src-tauri/icons/icon.png" alt="CC-Panes" width="64" valign="middle" /></a> CC-Panes
</h1>

<p align="center">
  <a href="https://github.com/wuxiran/cc-pane/releases/latest"><img src="https://img.shields.io/github/v/release/wuxiran/cc-pane?display_name=tag&amp;sort=semver" alt="最新リリース" /></a>
  <a href="https://github.com/wuxiran/cc-pane/releases"><img src="https://img.shields.io/github/downloads/wuxiran/cc-pane/total?label=downloads&amp;color=success" alt="ダウンロード数" /></a>
  <img src="https://img.shields.io/badge/license-GPL--3.0-08C?style=flat" alt="GPL-3.0 ライセンス" />
  <img src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-4493F8?style=flat-square" alt="Windows、macOS、Linux" />
</p>

<p align="center">
  <sub><a href="../../README.md">English</a> · <a href="README.zh-CN.md">中文</a> · <strong>日本語</strong> · <a href="README.ko.md">한국어</a> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a> · <a href="README.pt.md">Português</a></sub>
</p>

<p align="center">
  <strong>並列 AI コーディングのためのデスクトップコマンドセンター。</strong><br />
  CLI エージェントを並べて実行し、ワークスペースとセッションを整理し、MCP・計画・Skill・Git・ローカル履歴で協調します。
</p>

<h3 align="center"><a href="https://github.com/wuxiran/cc-pane/releases/latest"><ins>CC-Panes をダウンロード</ins></a></h3>

<p align="center">
  <picture>
    <source srcset="../assets/readme-recordings/readme-hero.gif" type="image/gif" />
    <img src="../assets/readme-recordings/readme-hero.jpg" alt="利用量・プロジェクト・セッションを示す CC-Panes コマンドセンター" width="960" />
  </picture>
</p>

<p align="center"><sub>以下の製品画面は実際の CC-Panes デスクトップ操作から録画しています。</sub></p>

## 主な機能

<table>
<tr>
<td width="50%" valign="middle">
<h3>ワークスペース コマンドセンター</h3>
<p>アクティブセッション、最近のプロジェクト、利用可能な CLI、利用量の推移、ワークスペース文脈を一つのローカルデスクトップ画面で確認できます。ワークスペース、プロジェクト、タスク、ターミナルを行き来しても作業の流れを失いません。</p>
<p><a href="../guide/03-core-concepts.md">ガイド →</a></p>
</td>
<td width="50%">
<a href="../guide/03-core-concepts.md"><picture><source srcset="../assets/readme-recordings/readme-hero.gif" type="image/gif" /><img src="../assets/readme-recordings/readme-hero.jpg" alt="プロジェクトとセッションを示す CC-Panes ダッシュボード" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Provider と起動プロファイル</h3>
<p>CLI、Provider、MCP、Skill、実行環境、権限ポリシーを再利用可能な起動プロファイルにまとめます。本機、WSL、SSH のワークフローを同じワークスペースモデルで扱えます。</p>
<p><a href="../guide/10-settings.md">設定ガイド →</a></p>
</td>
<td width="50%">
<a href="../guide/10-settings.md"><picture><source srcset="../assets/readme-recordings/provider-profiles.gif" type="image/gif" /><img src="../assets/readme-recordings/provider-profiles.jpg" alt="CC-Panes の Provider と起動設定" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Agent オーケストレーション</h3>
<p>境界のあるタスクを協調実行に変えます。内蔵 <code>ccpanes</code> MCP により Leader が Worker を派遣し、進捗を観察し、結果を集め、計画と Todo を実行セッションの近くに保てます。</p>
<p><a href="../guide/mcp-orchestration.md">MCP オーケストレーションガイド →</a></p>
</td>
<td width="50%">
<a href="../guide/mcp-orchestration.md"><picture><source srcset="../assets/readme-recordings/agent-orchestration.gif" type="image/gif" /><img src="../assets/readme-recordings/agent-orchestration.jpg" alt="CC-Panes の TodoList とオーケストレーション" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Skill と共有ツール</h3>
<p>再利用可能なワークフローを閲覧し、グローバル Skill を管理し、必要なプロファイルへ共有 MCP を接続します。インストール済み CLI Skill も表示しますが、すべてのセッションへ強制注入はしません。</p>
<p><a href="../guide/18-skills.md">Skills ガイド →</a></p>
</td>
<td width="50%">
<a href="../guide/18-skills.md"><picture><source srcset="../assets/readme-recordings/skills-and-mcp.gif" type="image/gif" /><img src="../assets/readme-recordings/skills-and-mcp.jpg" alt="CC-Panes リソースセンターの Skill 一覧" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>端末分割とタブ</h3>
<p>実 PTY セッションを、柔軟な水平・垂直レイアウト、スクロールバック、保存済みペインレイアウトとして一つのウィンドウで扱えます。</p>
<p><a href="../guide/05-terminal-and-panes.md">ガイド →</a></p>
</td>
<td width="50%">
<a href="../guide/05-terminal-and-panes.md"><picture><source srcset="../assets/readme-recordings/terminal-splits.gif" type="image/gif" /><img src="../assets/readme-recordings/terminal-splits.jpg" alt="CC-Panes のターミナル起動と複数タブ" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>再開とリモートアクセス</h3>
<p>以前の作業を開き直し、デスクトップ、Web、Android から接続できます。クライアントをまたいでも同じワークスペースモデルを維持します。</p>
<p><a href="../guide/14-resume.md">ガイド →</a></p>
</td>
<td width="50%">
<a href="../guide/14-resume.md"><picture><source srcset="../assets/readme-recordings/resume-remote.gif" type="image/gif" /><img src="../assets/readme-recordings/resume-remote.jpg" alt="CC-Panes のホームとリモート Web 設定" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Git とローカル履歴</h3>
<p>ブランチと worktree を確認し、ラベル付きスナップショット、diff、復元点をワークスペースから離れずに使えます。</p>
<p><a href="../guide/07-git-worktree.md">ガイド →</a></p>
</td>
<td width="50%">
<a href="../guide/07-git-worktree.md"><picture><source srcset="../assets/readme-recordings/git-history.gif" type="image/gif" /><img src="../assets/readme-recordings/git-history.jpg" alt="CC-Panes の Git とプロジェクト履歴" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>計画サーフェス</h3>
<p>Todo、ジャーナル、Plan、Spec、セッション要約、永続 Memory を、作業中のエージェントのすぐそばに置けます。</p>
<p><a href="../guide/09-todo-journal-memory.md">ガイド →</a></p>
</td>
<td width="50%">
<a href="../guide/09-todo-journal-memory.md"><picture><source srcset="../assets/readme-recordings/planning-surfaces.gif" type="image/gif" /><img src="../assets/readme-recordings/planning-surfaces.jpg" alt="CC-Panes の TodoList 計画サーフェス" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>ワークスペース対応の開発</h3>
<p>ファイルブラウザ、Monaco エディタ、Markdown / 画像プレビュー、プロジェクト hooks、CLI アダプタを同じシェルにまとめます。</p>
<p><a href="../guide/06-files-and-editor.md">ガイド →</a></p>
</td>
<td width="50%">
<a href="../guide/06-files-and-editor.md"><picture><source srcset="../assets/readme-recordings/files-editor.gif" type="image/gif" /><img src="../assets/readme-recordings/files-editor.jpg" alt="CC-Panes のエクスプローラと編集ワークフロー" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Web アクセス</h3>
<p>任意のブラウザからワークスペースに接続。デスクトップ、Web、Android で同じワークスペースモデルによりセッションを同期します。</p>
<p><a href="../guide/16-web-and-mobile.md">ガイド →</a></p>
</td>
<td width="50%">
<a href="../guide/16-web-and-mobile.md"><picture><source srcset="../assets/readme-recordings/web-access.gif" type="image/gif" /><img src="../assets/readme-recordings/web-access.jpg" alt="ブラウザから CC-Panes ワークスペースにアクセス" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>背景設定</h3>
<p>テーマ、壁紙、不透明度、ウィンドウ効果でシェルをカスタマイズ。見た目を再利用可能なプリセットとして保存し、ワークスペース間で使い回せます。</p>
<p><a href="../guide/10-settings.md">ガイド →</a></p>
</td>
<td width="50%">
<a href="../guide/10-settings.md"><picture><source srcset="../assets/readme-recordings/background-settings.gif" type="image/gif" /><img src="../assets/readme-recordings/background-settings.jpg" alt="CC-Panes の背景と外観設定" width="100%" /></picture></a>
</td>
</tr>
</table>

**その他:**

- Provider 注入、MCP 設定、Resume、ライフサイクルイベント向けのプロジェクト hooks と CLI アダプタ。
- デスクトップ向け拡張：スクリーンショット、トレイ、ミニモード、コマンドパレット、テーマ、リソース監視。

---

## 対応 CLI Agent

CC-Panes はターミナルで動く任意の CLI エージェントに対応します。一等アダプタは、各 CLI がサポートする範囲で Provider 注入、MCP、Resume、ワークスペース引数、システムプロンプト、プロジェクト hooks を追加します。

<p>
  <kbd>Claude Code</kbd> &nbsp;
  <kbd>Codex</kbd> &nbsp;
  <kbd>Gemini CLI</kbd> &nbsp;
  <kbd>Kimi</kbd> &nbsp;
  <kbd>GLM</kbd> &nbsp;
  <kbd>Grok</kbd> &nbsp;
  <kbd>OpenCode</kbd> &nbsp;
  <kbd>Cursor</kbd> &nbsp;
  <kbd>+ any terminal CLI</kbd>
</p>

---

## インストール

### デスクトップ — Windows、macOS、Linux

- **[最新リリースをダウンロード](https://github.com/wuxiran/cc-pane/releases/latest)**
- 現在のインストーラとパッケージ形式は [リリースページ](https://github.com/wuxiran/cc-pane/releases) を参照してください。

安定版にはアプリ内アップデータが含まれます。プレリリースはリリースページから手動インストールできます。

### 初回起動

1. 対応 CLI を 1 つ以上インストールし、`PATH` から利用できるようにします。
2. CC-Panes を開き、ワークスペースを作成または取り込み、プロジェクトを追加し、セッションを起動します。
3. 並列作業に向く場合はターミナルを分割するか、オーケストレーションビューで境界のあるサブタスクを派遣します。

詳細は[ユーザーガイド](../guide/README.md)。Web / Android は [Web とモバイルのガイド](../guide/16-web-and-mobile.md)。

---

## コミュニティとサポート

- **Issues:** [github.com/wuxiran/cc-pane/issues](https://github.com/wuxiran/cc-pane/issues)
- **Discussions:** [github.com/wuxiran/cc-pane/discussions](https://github.com/wuxiran/cc-pane/discussions)
- **WeChat:** `yemaofeng66` を追加し、`CC-Panes chat` または `CC-Panes bug feedback` と伝えてください。

<p>
  <img src="../assets/images/wechat-bug-feedback.png" alt="CC-Panes bug feedback WeChat group" width="160" />
</p>

---

## 開発

貢献ガイドは [CONTRIBUTING.md](https://github.com/wuxiran/cc-pane/blob/main/CONTRIBUTING.md) を参照してください。

```bash
git clone https://github.com/wuxiran/cc-pane.git
cd cc-pane
npm install
npm run tauri:dev
```

便利なチェック:

```bash
npx tsc --noEmit
npm run build
npm run test:run
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
```

`npm run tauri:dev` は `com.ccpanes.dev` と `~/.cc-panes-dev/` を使います。リリースビルドは `com.ccpanes.app` と `~/.cc-panes/` を使います。

## ライセンス

CC-Panes は [GPL-3.0](https://github.com/wuxiran/cc-pane/blob/main/LICENSE) で公開されている無料のオープンソースです。

## 謝辞

コミュニティと支援: [Linux.do](https://linux.do) | [Sponsor relay hub](https://hub.nocannobb.com)

使用技術: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | [Tauri](https://tauri.app/) | [xterm.js](https://xtermjs.org/) | [portable-pty](https://github.com/wez/wezterm/tree/main/pty) | [Allotment](https://github.com/johnwalley/allotment) | [shadcn/ui](https://ui.shadcn.com/)
