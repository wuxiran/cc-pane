<h1 align="center">
  <a href="https://github.com/wuxiran/cc-pane"><img src="../../src-tauri/icons/icon.png" alt="CC-Panes" width="64" valign="middle" /></a> CC-Panes
</h1>

<p align="center">
  <a href="https://github.com/wuxiran/cc-pane/releases/latest"><img src="https://img.shields.io/github/v/release/wuxiran/cc-pane?display_name=tag&amp;sort=semver" alt="최신 릴리스" /></a>
  <a href="https://github.com/wuxiran/cc-pane/releases"><img src="https://img.shields.io/github/downloads/wuxiran/cc-pane/total?label=downloads&amp;color=success" alt="다운로드" /></a>
  <img src="https://img.shields.io/badge/license-GPL--3.0-08C?style=flat" alt="GPL-3.0 라이선스" />
  <img src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-4493F8?style=flat-square" alt="Windows, macOS, Linux" />
</p>

<p align="center">
  <sub><a href="../../README.md">English</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a> · <strong>한국어</strong> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a> · <a href="README.pt.md">Português</a></sub>
</p>

<p align="center">
  <strong>병렬 AI 코딩을 위한 데스크톱 커맨드 센터.</strong><br />
  CLI 에이전트를 나란히 실행하고, 워크스페이스와 세션을 정리한 뒤 MCP, 계획, Skill, Git, 로컬 히스토리로 작업을 조율합니다.
</p>

<h3 align="center"><a href="https://github.com/wuxiran/cc-pane/releases/latest"><ins>CC-Panes 다운로드</ins></a></h3>

<p align="center">
  <picture>
    <source srcset="../assets/readme-recordings/readme-hero.gif" type="image/gif" />
    <img src="../assets/readme-recordings/readme-hero.jpg" alt="사용량, 프로젝트, 세션을 보여주는 CC-Panes 커맨드 센터" width="960" />
  </picture>
</p>

<p align="center"><sub>아래 제품 화면은 실제 CC-Panes 데스크톱 상호작용을 녹화한 것입니다.</sub></p>

## 주요 기능

<table>
<tr>
<td width="50%" valign="middle">
<h3>워크스페이스 커맨드 센터</h3>
<p>활성 세션, 최근 프로젝트, 사용 가능한 CLI, 사용량 추세, 워크스페이스 맥락을 하나의 로컬 데스크톱 화면에서 확인하세요. 워크스페이스, 프로젝트, 작업, 터미널을 오가며 작업 흐름을 유지합니다.</p>
<p><a href="../guide/03-core-concepts.md">가이드 →</a></p>
</td>
<td width="50%">
<a href="../guide/03-core-concepts.md"><picture><source srcset="../assets/readme-recordings/readme-hero.gif" type="image/gif" /><img src="../assets/readme-recordings/readme-hero.jpg" alt="프로젝트와 세션이 있는 CC-Panes 대시보드" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Provider와 실행 프로필</h3>
<p>CLI, Provider, MCP, Skill, 런타임, 권한 정책을 재사용 가능한 실행 프로필로 묶습니다. 로컬, WSL, SSH 워크플로를 같은 워크스페이스 모델로 유지합니다.</p>
<p><a href="../guide/10-settings.md">설정 가이드 →</a></p>
</td>
<td width="50%">
<a href="../guide/10-settings.md"><picture><source srcset="../assets/readme-recordings/provider-profiles.gif" type="image/gif" /><img src="../assets/readme-recordings/provider-profiles.jpg" alt="CC-Panes의 Provider 프로필과 실행 설정" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Agent 오케스트레이션</h3>
<p>경계가 있는 작업을 조율된 실행으로 바꿉니다. 내장 <code>ccpanes</code> MCP로 Leader가 Worker를 배치하고, 진행을 관찰하며, 결과를 수집하고, 계획과 Todo를 실행 세션 옆에 둡니다.</p>
<p><a href="../guide/mcp-orchestration.md">MCP 오케스트레이션 가이드 →</a></p>
</td>
<td width="50%">
<a href="../guide/mcp-orchestration.md"><picture><source srcset="../assets/readme-recordings/agent-orchestration.gif" type="image/gif" /><img src="../assets/readme-recordings/agent-orchestration.jpg" alt="CC-Panes의 TodoList와 에이전트 오케스트레이션 패널" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Skill과 공유 도구</h3>
<p>재사용 워크플로를 탐색하고, 전역 Skill을 관리하며, 필요한 프로필에 공유 MCP를 연결합니다. 설치된 CLI Skill도 보여 주지만 모든 세션에 강제 주입하지는 않습니다.</p>
<p><a href="../guide/18-skills.md">Skills 가이드 →</a></p>
</td>
<td width="50%">
<a href="../guide/18-skills.md"><picture><source srcset="../assets/readme-recordings/skills-and-mcp.gif" type="image/gif" /><img src="../assets/readme-recordings/skills-and-mcp.jpg" alt="CC-Panes 리소스 센터의 재사용 Skill 목록" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>터미널 분할과 탭</h3>
<p>실제 PTY 세션을 유연한 가로/세로 레이아웃, 스크롤백, 저장된 페인 레이아웃과 함께 한 창에서 사용합니다.</p>
<p><a href="../guide/05-terminal-and-panes.md">가이드 →</a></p>
</td>
<td width="50%">
<a href="../guide/05-terminal-and-panes.md"><picture><source srcset="../assets/readme-recordings/terminal-splits.gif" type="image/gif" /><img src="../assets/readme-recordings/terminal-splits.jpg" alt="CC-Panes 터미널 런처와 다중 탭 세션" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>재개와 원격 접근</h3>
<p>이전 작업을 다시 열고 데스크톱, 웹, Android에서 연결합니다. 클라이언트 전반에서 같은 워크스페이스 모델을 유지합니다.</p>
<p><a href="../guide/14-resume.md">가이드 →</a></p>
</td>
<td width="50%">
<a href="../guide/14-resume.md"><picture><source srcset="../assets/readme-recordings/resume-remote.gif" type="image/gif" /><img src="../assets/readme-recordings/resume-remote.jpg" alt="CC-Panes 홈 대시보드와 원격 웹 접근 설정" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Git과 로컬 히스토리</h3>
<p>브랜치와 worktree를 살펴보고, 레이블된 스냅샷, diff, 복원 지점을 워크스페이스를 떠나지 않고 사용합니다.</p>
<p><a href="../guide/07-git-worktree.md">가이드 →</a></p>
</td>
<td width="50%">
<a href="../guide/07-git-worktree.md"><picture><source srcset="../assets/readme-recordings/git-history.gif" type="image/gif" /><img src="../assets/readme-recordings/git-history.jpg" alt="CC-Panes의 워크스페이스 도구와 프로젝트 히스토리" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>계획 서피스</h3>
<p>Todo, 저널, Plan, Spec, 세션 요약, 지속 Memory를 작업을 수행하는 에이전트 옆에 둡니다.</p>
<p><a href="../guide/09-todo-journal-memory.md">가이드 →</a></p>
</td>
<td width="50%">
<a href="../guide/09-todo-journal-memory.md"><picture><source srcset="../assets/readme-recordings/planning-surfaces.gif" type="image/gif" /><img src="../assets/readme-recordings/planning-surfaces.jpg" alt="CC-Panes의 TodoList 계획 서피스" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>워크스페이스 인식 개발</h3>
<p>파일 브라우저, Monaco 편집기, Markdown/이미지 미리보기, 프로젝트 hooks, CLI 어댑터를 같은 셸에 둡니다.</p>
<p><a href="../guide/06-files-and-editor.md">가이드 →</a></p>
</td>
<td width="50%">
<a href="../guide/06-files-and-editor.md"><picture><source srcset="../assets/readme-recordings/files-editor.gif" type="image/gif" /><img src="../assets/readme-recordings/files-editor.jpg" alt="CC-Panes 탐색기와 편집 워크플로" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>웹 접속</h3>
<p>어느 브라우저에서든 워크스페이스에 접속하세요. 데스크톱·웹·Android가 동일한 워크스페이스 모델로 세션을 동기화합니다.</p>
<p><a href="../guide/16-web-and-mobile.md">가이드 →</a></p>
</td>
<td width="50%">
<a href="../guide/16-web-and-mobile.md"><picture><source srcset="../assets/readme-recordings/web-access.gif" type="image/gif" /><img src="../assets/readme-recordings/web-access.jpg" alt="브라우저로 CC-Panes 워크스페이스에 접속" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>배경 설정</h3>
<p>테마, 배경화면, 불투명도, 창 효과로 셸을 개인화하세요. 외관을 재사용 가능한 프리셋으로 저장해 워크스페이스 간에 사용합니다.</p>
<p><a href="../guide/10-settings.md">가이드 →</a></p>
</td>
<td width="50%">
<a href="../guide/10-settings.md"><picture><source srcset="../assets/readme-recordings/background-settings.gif" type="image/gif" /><img src="../assets/readme-recordings/background-settings.jpg" alt="CC-Panes의 배경 및 외관 설정" width="100%" /></picture></a>
</td>
</tr>
</table>

**추가로 포함:**

- Provider 주입, MCP 설정, Resume, 수명 주기 이벤트를 위한 프로젝트 hooks와 CLI 어댑터.
- 데스크톱 워크플로 확장: 스크린샷, 트레이, 미니 모드, 명령 팔레트, 테마, 리소스 모니터링.

---

## 지원 CLI Agent

CC-Panes는 터미널에서 실행되는 모든 CLI 에이전트와 함께 동작합니다. 일급 어댑터는 각 CLI가 지원하는 범위에서 Provider 주입, MCP 설정, Resume, 워크스페이스 플래그, 시스템 프롬프트, 프로젝트 hooks를 추가합니다.

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

## 설치

### 데스크톱 — Windows, macOS, Linux

- **[최신 릴리스 다운로드](https://github.com/wuxiran/cc-pane/releases/latest)**
- 현재 설치 프로그램과 패키지 형식은 [릴리스 페이지](https://github.com/wuxiran/cc-pane/releases)를 확인하세요.

안정 버전에는 인앱 업데이터가 포함됩니다. 프리릴리스는 릴리스 페이지에서 수동 설치할 수 있습니다.

### 첫 실행

1. 지원 CLI를 하나 이상 설치하고 `PATH`에서 사용할 수 있게 합니다.
2. CC-Panes를 열고 워크스페이스를 만들거나 가져온 뒤 프로젝트를 추가하고 세션을 실행합니다.
3. 병렬 작업이 필요하면 터미널을 분할하거나 오케스트레이션 뷰에서 경계 있는 하위 작업을 배치합니다.

전체 안내는 [사용자 가이드](../guide/README.md)를, 웹/Android 설정은 [웹 및 모바일 가이드](../guide/16-web-and-mobile.md)를 보세요.

---

## 커뮤니티와 지원

- **Issues:** [github.com/wuxiran/cc-pane/issues](https://github.com/wuxiran/cc-pane/issues)
- **Discussions:** [github.com/wuxiran/cc-pane/discussions](https://github.com/wuxiran/cc-pane/discussions)
- **WeChat:** `yemaofeng66`을 추가하고 `CC-Panes chat` 또는 `CC-Panes bug feedback`를 남겨 주세요.

<p>
  <img src="../assets/images/wechat-bug-feedback.png" alt="CC-Panes bug feedback WeChat group" width="160" />
</p>

---

## 개발

기여 안내는 [CONTRIBUTING.md](https://github.com/wuxiran/cc-pane/blob/main/CONTRIBUTING.md)를 참고하세요.

```bash
git clone https://github.com/wuxiran/cc-pane.git
cd cc-pane
npm install
npm run tauri:dev
```

유용한 검사:

```bash
npx tsc --noEmit
npm run build
npm run test:run
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
```

`npm run tauri:dev`는 `com.ccpanes.dev`와 `~/.cc-panes-dev/`를 사용합니다. 릴리스 빌드는 `com.ccpanes.app`와 `~/.cc-panes/`를 사용합니다.

## 라이선스

CC-Panes는 [GPL-3.0](https://github.com/wuxiran/cc-pane/blob/main/LICENSE) 라이선스의 무료 오픈 소스입니다.

## 감사

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) | [Tauri](https://tauri.app/) | [xterm.js](https://xtermjs.org/) | [portable-pty](https://github.com/wez/wezterm/tree/main/pty) | [Allotment](https://github.com/johnwalley/allotment) | [shadcn/ui](https://ui.shadcn.com/)
