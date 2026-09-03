<h1 align="center">
  <a href="https://github.com/wuxiran/cc-pane"><img src="../../src-tauri/icons/icon.png" alt="CC-Panes" width="64" valign="middle" /></a> CC-Panes
</h1>

<p align="center">
  <a href="https://github.com/wuxiran/cc-pane/releases/latest"><img src="https://img.shields.io/github/v/release/wuxiran/cc-pane?display_name=tag&amp;sort=semver" alt="Dernière version" /></a>
  <a href="https://github.com/wuxiran/cc-pane/releases"><img src="https://img.shields.io/github/downloads/wuxiran/cc-pane/total?label=downloads&amp;color=success" alt="Téléchargements" /></a>
  <img src="https://img.shields.io/badge/license-GPL--3.0-08C?style=flat" alt="Licence GPL-3.0" />
  <img src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-4493F8?style=flat-square" alt="Windows, macOS et Linux" />
</p>

<p align="center">
  <sub><a href="../../README.md">English</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.es.md">Español</a> · <strong>Français</strong> · <a href="README.pt.md">Português</a></sub>
</p>

<p align="center">
  <strong>Le centre de commande de bureau pour le coding AI en parallèle.</strong><br />
  Lancez des agents CLI côte à côte, organisez leurs workspaces et sessions, puis coordonnez le travail via MCP, plans, skills, Git et historique local.
</p>

<h3 align="center"><a href="https://github.com/wuxiran/cc-pane/releases/latest"><ins>Télécharger CC-Panes</ins></a></h3>

<p align="center">
  <picture>
    <source srcset="../assets/readme-recordings/readme-hero.gif" type="image/gif" />
    <img src="../assets/readme-recordings/readme-hero.jpg" alt="Centre de commande CC-Panes avec usage, projets et sessions" width="960" />
  </picture>
</p>

<p align="center"><sub>Les captures ci-dessous proviennent d’interactions réelles sur le bureau CC-Panes.</sub></p>

## Fonctionnalités

<table>
<tr>
<td width="50%" valign="middle">
<h3>Centre de commande du workspace</h3>
<p>Voyez les sessions actives, les projets récents, les CLI disponibles, les tendances d’usage et le contexte du workspace dans une seule vue de bureau locale. Passez d’un workspace, d’un projet, d’une tâche et d’un terminal sans perdre le fil du travail.</p>
<p><a href="../guide/03-core-concepts.md">Guide →</a></p>
</td>
<td width="50%">
<a href="../guide/03-core-concepts.md"><picture><source srcset="../assets/readme-recordings/readme-hero.gif" type="image/gif" /><img src="../assets/readme-recordings/readme-hero.jpg" alt="Tableau de bord workspace CC-Panes avec projets et sessions" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Providers et profils de lancement</h3>
<p>Choisissez un CLI, un provider, un ensemble MCP, des skills, un runtime et une politique de permissions comme un profil de lancement réutilisable. Gardez les flux locaux, WSL et SSH sous le même modèle de workspace.</p>
<p><a href="../guide/10-settings.md">Guide des réglages →</a></p>
</td>
<td width="50%">
<a href="../guide/10-settings.md"><picture><source srcset="../assets/readme-recordings/provider-profiles.gif" type="image/gif" /><img src="../assets/readme-recordings/provider-profiles.jpg" alt="Profils provider et configuration de lancement dans CC-Panes" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Orchestration d’agents</h3>
<p>Transformez une tâche bornée en une exécution coordonnée. Le MCP intégré <code>ccpanes</code> permet à un leader de dispatcher des workers, d’observer leur progression, de collecter les résultats et de garder plans et Todos près des sessions qui font le travail.</p>
<p><a href="../guide/mcp-orchestration.md">Guide d’orchestration MCP →</a></p>
</td>
<td width="50%">
<a href="../guide/mcp-orchestration.md"><picture><source srcset="../assets/readme-recordings/agent-orchestration.gif" type="image/gif" /><img src="../assets/readme-recordings/agent-orchestration.jpg" alt="TodoList et panneau d’orchestration dans CC-Panes" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Skills et outillage partagé</h3>
<p>Parcourez des workflows réutilisables, gérez des skills globaux et attachez des services MCP partagés aux profils qui en ont besoin. CC-Panes affiche aussi les skills CLI installés sans les forcer dans chaque session.</p>
<p><a href="../guide/18-skills.md">Guide des skills →</a></p>
</td>
<td width="50%">
<a href="../guide/18-skills.md"><picture><source srcset="../assets/readme-recordings/skills-and-mcp.gif" type="image/gif" /><img src="../assets/readme-recordings/skills-and-mcp.jpg" alt="Centre de ressources CC-Panes listant des skills réutilisables" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Splits et onglets de terminal</h3>
<p>De vraies sessions PTY avec des layouts horizontaux et verticaux flexibles, un scrollback et des layouts de panneaux sauvegardés dans une seule fenêtre.</p>
<p><a href="../guide/05-terminal-and-panes.md">Guide →</a></p>
</td>
<td width="50%">
<a href="../guide/05-terminal-and-panes.md"><picture><source srcset="../assets/readme-recordings/terminal-splits.gif" type="image/gif" /><img src="../assets/readme-recordings/terminal-splits.jpg" alt="Lanceur de terminal et sessions multi-onglets dans CC-Panes" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Reprise et accès distant</h3>
<p>Rouvrez un travail précédent et connectez-vous depuis le bureau, le web ou Android. Conservez le même modèle de workspace entre clients.</p>
<p><a href="../guide/14-resume.md">Guide →</a></p>
</td>
<td width="50%">
<a href="../guide/14-resume.md"><picture><source srcset="../assets/readme-recordings/resume-remote.gif" type="image/gif" /><img src="../assets/readme-recordings/resume-remote.jpg" alt="Tableau de bord d’accueil et réglages d’accès web distant dans CC-Panes" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Git et historique local</h3>
<p>Inspectez branches et worktrees, puis utilisez des snapshots étiquetés, des diffs et des points de restauration sans quitter le workspace.</p>
<p><a href="../guide/07-git-worktree.md">Guide →</a></p>
</td>
<td width="50%">
<a href="../guide/07-git-worktree.md"><picture><source srcset="../assets/readme-recordings/git-history.gif" type="image/gif" /><img src="../assets/readme-recordings/git-history.jpg" alt="Outils de workspace et historique de projet dans CC-Panes" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Surfaces de planification</h3>
<p>Todos, journaux, plans, specs, résumés de session et mémoire persistante restent à côté des agents qui font le travail.</p>
<p><a href="../guide/09-todo-journal-memory.md">Guide →</a></p>
</td>
<td width="50%">
<a href="../guide/09-todo-journal-memory.md"><picture><source srcset="../assets/readme-recordings/planning-surfaces.gif" type="image/gif" /><img src="../assets/readme-recordings/planning-surfaces.jpg" alt="Surface de planification TodoList dans CC-Panes" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Développement orienté workspace</h3>
<p>Explorateur de fichiers, éditeur Monaco, previews Markdown et image, hooks de projet et adaptateurs CLI dans le même shell.</p>
<p><a href="../guide/06-files-and-editor.md">Guide →</a></p>
</td>
<td width="50%">
<a href="../guide/06-files-and-editor.md"><picture><source srcset="../assets/readme-recordings/files-editor.gif" type="image/gif" /><img src="../assets/readme-recordings/files-editor.jpg" alt="Explorateur et flux d’édition dans CC-Panes" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Accès Web</h3>
<p>Connectez-vous à un workspace depuis n’importe quel navigateur. Gardez les sessions synchronisées entre desktop, web et Android avec le même modèle de workspace.</p>
<p><a href="../guide/16-web-and-mobile.md">Guide →</a></p>
</td>
<td width="50%">
<a href="../guide/16-web-and-mobile.md"><picture><source srcset="../assets/readme-recordings/web-access.gif" type="image/gif" /><img src="../assets/readme-recordings/web-access.jpg" alt="Accès navigateur à un workspace CC-Panes" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">
<h3>Paramètres de fond</h3>
<p>Personnalisez le shell avec thèmes, fond d’écran, opacité et effets de fenêtre. Enregistrez les apparences comme presets réutilisables entre workspaces.</p>
<p><a href="../guide/10-settings.md">Guide →</a></p>
</td>
<td width="50%">
<a href="../guide/10-settings.md"><picture><source srcset="../assets/readme-recordings/background-settings.gif" type="image/gif" /><img src="../assets/readme-recordings/background-settings.jpg" alt="Paramètres de fond et d’apparence dans CC-Panes" width="100%" /></picture></a>
</td>
</tr>
</table>

**Également inclus :**

- Hooks de projet et adaptateurs CLI pour l’injection de provider, la config MCP, le resume et les événements de cycle de vie.
- Extras de workflow bureau : captures d’écran, tray, mode mini, palette de commandes, thèmes et monitoring des ressources.

---

## Agents CLI pris en charge

CC-Panes fonctionne avec tout agent CLI qui s’exécute dans un terminal. Les adaptateurs de première classe ajoutent l’injection de provider, le MCP, le resume, les flags de workspace, les system prompts et les hooks de projet lorsque chaque CLI le permet.

<p>
  <kbd>Claude Code</kbd> &nbsp;
  <kbd>Codex</kbd> &nbsp;
  <kbd>Gemini CLI</kbd> &nbsp;
  <kbd>Kimi</kbd> &nbsp;
  <kbd>Grok</kbd> &nbsp;
  <kbd>OpenCode</kbd> &nbsp;
  <kbd>Cursor</kbd> &nbsp;
  <kbd>+ any terminal CLI</kbd>
</p>

---

## Installation

### Bureau — Windows, macOS, Linux

- **[Télécharger la dernière version](https://github.com/wuxiran/cc-pane/releases/latest)**
- Consultez la [page des releases](https://github.com/wuxiran/cc-pane/releases) pour les installateurs et formats actuels.

Les versions stables incluent le mise à jour in-app. Les pre-releases sont disponibles en installation manuelle depuis la page des releases.

### Premier lancement

1. Installez au moins un CLI supporté et assurez-vous qu’il est disponible dans votre `PATH`.
2. Ouvrez CC-Panes, créez ou importez un workspace, ajoutez un projet et lancez une session.
3. Divisez le terminal lorsque la tâche gagne à être parallèle, ou utilisez la vue d’orchestration pour dispatcher des sous-tâches bornées.

Pour le parcours complet, voir le [guide utilisateur](../guide/README.md). Pour le web et Android, voir le [guide web et mobile](../guide/16-web-and-mobile.md).

---

## Communauté et support

- **Issues :** [github.com/wuxiran/cc-pane/issues](https://github.com/wuxiran/cc-pane/issues)
- **Discussions :** [github.com/wuxiran/cc-pane/discussions](https://github.com/wuxiran/cc-pane/discussions)
- **WeChat :** ajoutez `yemaofeng66` et indiquez `CC-Panes chat` ou `CC-Panes bug feedback`.

<p>
  <img src="../assets/images/wechat-bug-feedback.png" alt="Groupe WeChat de feedback bugs CC-Panes" width="160" />
</p>

---

## Développement

Voir [CONTRIBUTING.md](https://github.com/wuxiran/cc-pane/blob/main/CONTRIBUTING.md) pour le guide de contribution.

```bash
git clone https://github.com/wuxiran/cc-pane.git
cd cc-pane
npm install
npm run tauri:dev
```

Vérifications utiles :

```bash
npx tsc --noEmit
npm run build
npm run test:run
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
```

`npm run tauri:dev` utilise `com.ccpanes.dev` et `~/.cc-panes-dev/`. Les builds release utilisent `com.ccpanes.app` et `~/.cc-panes/`.

## Licence

CC-Panes est libre et open source sous la [licence GPL-3.0](https://github.com/wuxiran/cc-pane/blob/main/LICENSE).

## Remerciements

Communauté et soutien: [Linux.do](https://linux.do) | [Sponsor relay hub](https://hub.nocannobb.com)

Construit avec: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | [Tauri](https://tauri.app/) | [xterm.js](https://xtermjs.org/) | [portable-pty](https://github.com/wez/wezterm/tree/main/pty) | [Allotment](https://github.com/johnwalley/allotment) | [shadcn/ui](https://ui.shadcn.com/)
