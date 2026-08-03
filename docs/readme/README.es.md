<h1 align="center">
  <a href="https://github.com/wuxiran/cc-pane"><img src="../../src-tauri/icons/icon.png" alt="CC-Panes" width="64" valign="middle" /></a> CC-Panes
</h1>

<p align="center">
  <a href="https://github.com/wuxiran/cc-pane/releases/latest"><img src="https://img.shields.io/github/v/release/wuxiran/cc-pane?display_name=tag&amp;sort=semver" alt="Última versión" /></a>
  <a href="https://github.com/wuxiran/cc-pane/releases"><img src="https://img.shields.io/github/downloads/wuxiran/cc-pane/total?label=downloads&amp;color=success" alt="Descargas" /></a>
  <img src="https://img.shields.io/badge/license-GPL--3.0-08C?style=flat" alt="Licencia GPL-3.0" />
  <img src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-4493F8?style=flat-square" alt="Windows, macOS y Linux" />
</p>

<p align="center">
  <sub><a href="../../README.md">English</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <strong>Español</strong> · <a href="README.fr.md">Français</a> · <a href="README.pt.md">Português</a></sub>
</p>

<p align="center">
  <strong>El centro de mando de escritorio para coding AI en paralelo.</strong><br />
  Ejecuta agentes CLI lado a lado, organiza workspaces y sesiones, y coordina el trabajo con MCP, planes, skills, Git e historial local.
</p>

<h3 align="center"><a href="https://github.com/wuxiran/cc-pane/releases/latest"><ins>Descargar CC-Panes</ins></a></h3>

<p align="center">
  <picture>
    <source srcset="../assets/readme-recordings/readme-hero.gif" type="image/gif" />
    <img src="../assets/readme-recordings/readme-hero.jpg" alt="Centro de mando de CC-Panes con uso, proyectos y sesiones" width="960" />
  </picture>
</p>

<p align="center"><sub>Las capturas siguientes se grabaron de interacciones reales de CC-Panes en escritorio.</sub></p>

## Funciones

<table>
<tr>
<td width="50%" valign="middle">
<h3>Centro de mando del workspace</h3>
<p>Consulta sesiones activas, proyectos recientes, CLIs disponibles, tendencias de uso y el contexto del workspace en una sola vista de escritorio local. Muévete entre workspace, proyecto, tarea y terminal sin perder el hilo del trabajo.</p>
<p><a href="../guide/03-core-concepts.md">Guía →</a></p>
</td>
<td width="50%">
<a href="../guide/03-core-concepts.md"><picture><source srcset="../assets/readme-recordings/readme-hero.gif" type="image/gif" /><img src="../assets/readme-recordings/readme-hero.jpg" alt="Panel de workspace de CC-Panes con proyectos y sesiones" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Providers y perfiles de lanzamiento</h3>
<p>Elige CLI, provider, conjunto MCP, skills, runtime y política de permisos como un perfil de lanzamiento reutilizable. Mantén flujos locales, WSL y SSH bajo el mismo modelo de workspace.</p>
<p><a href="../guide/10-settings.md">Guía de ajustes →</a></p>
</td>
<td width="50%">
<a href="../guide/10-settings.md"><picture><source srcset="../assets/readme-recordings/provider-profiles.gif" type="image/gif" /><img src="../assets/readme-recordings/provider-profiles.jpg" alt="Perfiles de provider y configuración de lanzamiento en CC-Panes" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Orquestación de agentes</h3>
<p>Convierte una tarea acotada en una ejecución coordinada. El MCP integrado <code>ccpanes</code> permite que un leader despache workers, observe el progreso, recoja resultados y mantenga planes y Todos cerca de las sesiones que hacen el trabajo.</p>
<p><a href="../guide/mcp-orchestration.md">Guía de orquestación MCP →</a></p>
</td>
<td width="50%">
<a href="../guide/mcp-orchestration.md"><picture><source srcset="../assets/readme-recordings/agent-orchestration.gif" type="image/gif" /><img src="../assets/readme-recordings/agent-orchestration.jpg" alt="TodoList y panel de orquestación en CC-Panes" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Skills y herramientas compartidas</h3>
<p>Explora flujos reutilizables, gestiona skills globales y adjunta servicios MCP compartidos a los perfiles que los necesitan. CC-Panes también muestra skills de CLI instalados sin forzarlos en cada sesión.</p>
<p><a href="../guide/18-skills.md">Guía de skills →</a></p>
</td>
<td width="50%">
<a href="../guide/18-skills.md"><picture><source srcset="../assets/readme-recordings/skills-and-mcp.gif" type="image/gif" /><img src="../assets/readme-recordings/skills-and-mcp.jpg" alt="Centro de recursos de CC-Panes con skills reutilizables" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Divisiones y pestañas de terminal</h3>
<p>Sesiones PTY reales con diseños horizontales y verticales flexibles, scrollback y diseños de paneles guardados en una sola ventana.</p>
<p><a href="../guide/05-terminal-and-panes.md">Guía →</a></p>
</td>
<td width="50%">
<a href="../guide/05-terminal-and-panes.md"><picture><source srcset="../assets/readme-recordings/terminal-splits.gif" type="image/gif" /><img src="../assets/readme-recordings/terminal-splits.jpg" alt="Lanzador de terminal y sesiones multi-pestaña en CC-Panes" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Reanudación y acceso remoto</h3>
<p>Vuelve a abrir trabajo anterior y conéctate desde escritorio, web o Android. Conserva el mismo modelo de workspace entre clientes.</p>
<p><a href="../guide/14-resume.md">Guía →</a></p>
</td>
<td width="50%">
<a href="../guide/14-resume.md"><picture><source srcset="../assets/readme-recordings/resume-remote.gif" type="image/gif" /><img src="../assets/readme-recordings/resume-remote.jpg" alt="Panel de inicio y ajustes de acceso web remoto en CC-Panes" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Git e historial local</h3>
<p>Inspecciona ramas y worktrees, luego usa instantáneas etiquetadas, diffs y puntos de restauración sin salir del workspace.</p>
<p><a href="../guide/07-git-worktree.md">Guía →</a></p>
</td>
<td width="50%">
<a href="../guide/07-git-worktree.md"><picture><source srcset="../assets/readme-recordings/git-history.gif" type="image/gif" /><img src="../assets/readme-recordings/git-history.jpg" alt="Herramientas de workspace e historial de proyecto en CC-Panes" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Superficies de planificación</h3>
<p>Todos, diarios, planes, specs, resúmenes de sesión y memoria persistente permanecen junto a los agentes que hacen el trabajo.</p>
<p><a href="../guide/09-todo-journal-memory.md">Guía →</a></p>
</td>
<td width="50%">
<a href="../guide/09-todo-journal-memory.md"><picture><source srcset="../assets/readme-recordings/planning-surfaces.gif" type="image/gif" /><img src="../assets/readme-recordings/planning-surfaces.jpg" alt="Superficie de planificación TodoList en CC-Panes" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Desarrollo consciente del workspace</h3>
<p>Explorador de archivos, editor Monaco, previsualizaciones Markdown e imagen, hooks de proyecto y adaptadores CLI en el mismo shell.</p>
<p><a href="../guide/06-files-and-editor.md">Guía →</a></p>
</td>
<td width="50%">
<a href="../guide/06-files-and-editor.md"><picture><source srcset="../assets/readme-recordings/files-editor.gif" type="image/gif" /><img src="../assets/readme-recordings/files-editor.jpg" alt="Explorador y flujo de edición en CC-Panes" width="100%" /></picture></a>
</td>
</tr>
</table>

**También incluye:**

- Hooks de proyecto y adaptadores CLI para inyección de provider, configuración MCP, resume y eventos de ciclo de vida.
- Extras de flujo de escritorio: capturas, bandeja, modo mini, paleta de comandos, temas y monitor de recursos.

---

## Agentes CLI compatibles

CC-Panes funciona con cualquier agente CLI que se ejecute en una terminal. Los adaptadores de primera clase añaden inyección de provider, MCP, resume, flags de workspace, system prompts y hooks de proyecto donde cada CLI lo soporte.

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

## Instalación

### Escritorio — Windows, macOS, Linux

- **[Descarga la última versión](https://github.com/wuxiran/cc-pane/releases/latest)**
- Consulta la [página de releases](https://github.com/wuxiran/cc-pane/releases) para instaladores y formatos actuales.

Las versiones estables incluyen el actualizador in-app. Las pre-releases están disponibles para instalación manual desde la página de releases.

### Primer arranque

1. Instala al menos un CLI compatible y asegúrate de que esté en tu `PATH`.
2. Abre CC-Panes, crea o importa un workspace, añade un proyecto y lanza una sesión.
3. Divide la terminal cuando la tarea se beneficie del trabajo en paralelo, o usa la vista de orquestación para despachar subtareas acotadas.

Para la guía completa, consulta la [guía de usuario](../guide/README.md). Para web y Android, consulta la [guía web y móvil](../guide/16-web-and-mobile.md).

---

## Comunidad y soporte

- **Issues:** [github.com/wuxiran/cc-pane/issues](https://github.com/wuxiran/cc-pane/issues)
- **Discussions:** [github.com/wuxiran/cc-pane/discussions](https://github.com/wuxiran/cc-pane/discussions)
- **WeChat:** añade `yemaofeng66` y menciona `CC-Panes chat` o `CC-Panes bug feedback`.

<p>
  <img src="../assets/images/wechat-bug-feedback.png" alt="Grupo WeChat de feedback de bugs de CC-Panes" width="160" />
</p>

---

## Desarrollo

Consulta [CONTRIBUTING.md](../../CONTRIBUTING.md) para la guía de contribución.

```bash
git clone https://github.com/wuxiran/cc-pane.git
cd cc-pane
npm install
npm run tauri:dev
```

Comprobaciones útiles:

```bash
npx tsc --noEmit
npm run build
npm run test:run
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
```

`npm run tauri:dev` usa `com.ccpanes.dev` y `~/.cc-panes-dev/`. Las builds de release usan `com.ccpanes.app` y `~/.cc-panes/`.

## Licencia

CC-Panes es software libre y de código abierto bajo la [licencia GPL-3.0](../../LICENSE).

## Agradecimientos

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) | [Tauri](https://tauri.app/) | [xterm.js](https://xtermjs.org/) | [portable-pty](https://github.com/wez/wezterm/tree/main/pty) | [Allotment](https://github.com/johnwalley/allotment) | [shadcn/ui](https://ui.shadcn.com/)
