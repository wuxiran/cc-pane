//! TUI 应用主循环

use anyhow::Result;
use crossterm::event::{
    self, DisableMouseCapture, EnableMouseCapture, Event as CrosstermEvent, KeyCode,
    KeyModifiers, MouseButton, MouseEventKind,
};
use portable_pty::PtySize;
use ratatui::DefaultTerminal;
use std::io::Write;
use std::time::Duration;
use tokio::sync::mpsc;

use crate::git;
use crate::ipc;
use crate::models::{Action, Event};
use crate::pty::PtyManager;
use crate::session;
use crate::terminal::Terminal;
use crate::ui;
use crate::workspace::Workspace;

/// Claude 状态
#[derive(Debug, Clone, Default)]
pub struct ClaudeStatus {
    pub status: String,
    pub message: Option<String>,
}

/// 上下文菜单状态
#[derive(Debug, Clone, Default)]
pub struct ContextMenu {
    pub visible: bool,
    pub project_index: usize,
    pub x: u16,
    pub y: u16,
    pub selected: usize,
}

/// 会话恢复对话框状态
#[derive(Debug, Clone, Default)]
pub struct SessionDialog {
    pub visible: bool,
    pub selected: usize,
    pub session_info: Option<String>,
    pub session_id: Option<String>,
}

/// 应用状态
pub struct App {
    workspace: Workspace,
    project_branches: Vec<(String, Option<String>)>,
    terminal: Terminal,
    pty: Option<PtyManager>,
    event_rx: mpsc::UnboundedReceiver<Event>,
    event_tx: mpsc::UnboundedSender<Event>,
    should_quit: bool,
    exit_code: i32,
    port: u16,
    pub claude_status: ClaudeStatus,
    pub context_menu: ContextMenu,
    pub session_dialog: SessionDialog,
    header_height: u16,
}

impl App {
    /// 创建新的应用实例
    pub fn new(workspace: Workspace, port: u16) -> Self {
        let (event_tx, event_rx) = mpsc::unbounded_channel();

        // 收集项目分支信息
        let project_branches: Vec<_> = workspace
            .projects
            .iter()
            .map(|p| {
                let name = p.alias.clone().unwrap_or_else(|| p.path.clone());
                let branch = git::get_branch(&p.path);
                (name, branch)
            })
            .collect();

        Self {
            workspace,
            project_branches,
            terminal: Terminal::new(24, 80),
            pty: None,
            event_rx,
            event_tx,
            should_quit: false,
            exit_code: 0,
            port,
            claude_status: ClaudeStatus::default(),
            context_menu: ContextMenu::default(),
            session_dialog: SessionDialog::default(),
            header_height: 0,
        }
    }

    /// 运行应用
    pub fn run(mut self, mut term: DefaultTerminal) -> Result<i32> {
        // 启用鼠标捕获
        crossterm::execute!(std::io::stdout(), EnableMouseCapture)?;

        // 启动 IPC 服务端
        ipc::start_server(self.port, self.event_tx.clone())?;

        // 获取初始终端大小
        let size = term.size()?;
        let area = ratatui::layout::Rect::new(0, 0, size.width, size.height);
        let (cols, rows) = ui::terminal_inner_size(area, self.project_branches.len());

        // 计算并保存 header 高度
        self.header_height = ui::header_height(self.project_branches.len());

        // 调整虚拟终端大小
        self.terminal.resize(rows, cols);

        // 获取工作空间目录
        let workspace_dir = std::env::var("CC_PANES_WORKSPACE_DIR")
            .unwrap_or_else(|_| ".".to_string());

        // 检查是否有活跃会话
        let mut resume_session_id: Option<String> = None;
        if let Ok(Some(state)) = session::load_session(&workspace_dir) {
            if state.status == session::SessionStatus::Active {
                self.session_dialog = SessionDialog {
                    visible: true,
                    selected: 0,
                    session_info: Some(state.started_at.clone()),
                    session_id: Some(state.session_id.clone()),
                };

                // 等待用户选择
                while self.session_dialog.visible && !self.should_quit {
                    term.draw(|frame| {
                        ui::render(
                            frame,
                            &self.workspace,
                            &self.project_branches,
                            &self.terminal,
                            &self.claude_status,
                            &self.context_menu,
                            &self.session_dialog,
                        );
                    })?;

                    if event::poll(Duration::from_millis(50))? {
                        if let CrosstermEvent::Key(key) = event::read()? {
                            match key.code {
                                KeyCode::Up => {
                                    if self.session_dialog.selected > 0 {
                                        self.session_dialog.selected -= 1;
                                    }
                                }
                                KeyCode::Down => {
                                    if self.session_dialog.selected < 1 {
                                        self.session_dialog.selected += 1;
                                    }
                                }
                                KeyCode::Enter => {
                                    if self.session_dialog.selected == 0 {
                                        resume_session_id = self.session_dialog.session_id.clone();
                                    } else {
                                        // 选择新会话，标记旧会话为 abandoned
                                        if let Ok(Some(mut old_state)) = session::load_session(&workspace_dir) {
                                            old_state.status = session::SessionStatus::Abandoned;
                                            let _ = session::save_session(&workspace_dir, &old_state);
                                        }
                                    }
                                    self.session_dialog.visible = false;
                                }
                                KeyCode::Esc => {
                                    self.session_dialog.visible = false;
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
        }

        // 启动 Claude 进程
        let project_paths: Vec<String> = self
            .workspace
            .projects
            .iter()
            .map(|p| p.path.clone())
            .collect();

        self.pty = Some(PtyManager::spawn_claude(
            &workspace_dir,
            &project_paths,
            resume_session_id.as_deref(),
            PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            },
            self.event_tx.clone(),
        )?);

        // 主循环
        while !self.should_quit {
            // 渲染
            term.draw(|frame| {
                ui::render(
                    frame,
                    &self.workspace,
                    &self.project_branches,
                    &self.terminal,
                    &self.claude_status,
                    &self.context_menu,
                    &self.session_dialog,
                );
            })?;

            // 处理事件
            self.handle_events()?;
        }

        // 禁用鼠标捕获
        crossterm::execute!(std::io::stdout(), DisableMouseCapture)?;

        Ok(self.exit_code)
    }

    /// 处理事件
    fn handle_events(&mut self) -> Result<()> {
        // 先处理 crossterm 事件（非阻塞）
        if event::poll(Duration::from_millis(10))? {
            match event::read()? {
                CrosstermEvent::Key(key) => {
                    let action = self.handle_key(key);
                    self.execute_action(action)?;
                }
                CrosstermEvent::Mouse(mouse) => {
                    let action = self.handle_mouse(mouse);
                    self.execute_action(action)?;
                }
                CrosstermEvent::Resize(w, h) => {
                    self.handle_resize(w, h)?;
                }
                _ => {}
            }
        }

        // 处理 PTY 事件（非阻塞）
        while let Ok(event) = self.event_rx.try_recv() {
            match event {
                Event::PtyOutput(data) => {
                    self.terminal.process(&data);
                }
                Event::PtyExit(code) => {
                    self.exit_code = code;
                    self.should_quit = true;
                }
                Event::StatusNotify(notify) => {
                    self.claude_status = ClaudeStatus {
                        status: notify.status,
                        message: notify.message,
                    };
                }
                _ => {}
            }
        }

        Ok(())
    }

    /// 处理键盘输入
    fn handle_key(&mut self, key: event::KeyEvent) -> Action {
        // 如果菜单可见，处理菜单导航
        if self.context_menu.visible {
            return match key.code {
                KeyCode::Esc => Action::HideMenu,
                KeyCode::Up => {
                    if self.context_menu.selected > 0 {
                        self.context_menu.selected -= 1;
                    }
                    Action::None
                }
                KeyCode::Down => {
                    if self.context_menu.selected < 2 {
                        self.context_menu.selected += 1;
                    }
                    Action::None
                }
                KeyCode::Enter => {
                    let idx = self.context_menu.project_index;
                    match self.context_menu.selected {
                        0 => Action::OpenProjectPath(idx),
                        1 => Action::CopyFullPath(idx),
                        2 => Action::CopyRelativePath(idx),
                        _ => Action::None,
                    }
                }
                _ => Action::HideMenu,
            };
        }

        // 将按键转换为字节发送给 PTY
        let bytes = key_to_bytes(key);
        if !bytes.is_empty() {
            Action::SendBytes(bytes)
        } else {
            Action::None
        }
    }

    /// 处理鼠标事件
    fn handle_mouse(&mut self, mouse: event::MouseEvent) -> Action {
        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                // 如果菜单可见，检查是否点击了菜单项
                if self.context_menu.visible {
                    let menu_x = self.context_menu.x;
                    let menu_y = self.context_menu.y;
                    let menu_width = 20;
                    let menu_height = 3;

                    if mouse.column >= menu_x
                        && mouse.column < menu_x + menu_width
                        && mouse.row >= menu_y
                        && mouse.row < menu_y + menu_height
                    {
                        let selected = (mouse.row - menu_y) as usize;
                        let idx = self.context_menu.project_index;
                        return match selected {
                            0 => Action::OpenProjectPath(idx),
                            1 => Action::CopyFullPath(idx),
                            2 => Action::CopyRelativePath(idx),
                            _ => Action::HideMenu,
                        };
                    }
                    return Action::HideMenu;
                }

                // 检查是否点击了项目列表区域
                // 项目列表从第 2 行开始（标题行之后），在 header 区域内
                let project_start_row = 2; // 边框 + 标题后
                let project_end_row = project_start_row + self.project_branches.len() as u16;

                if mouse.row >= project_start_row && mouse.row < project_end_row {
                    let project_index = (mouse.row - project_start_row) as usize;
                    if project_index < self.workspace.projects.len() {
                        return Action::ShowProjectMenu(project_index, mouse.column, mouse.row);
                    }
                }
            }
            MouseEventKind::Down(MouseButton::Right) => {
                // 右键也可以打开菜单
                if self.context_menu.visible {
                    return Action::HideMenu;
                }

                let project_start_row = 2;
                let project_end_row = project_start_row + self.project_branches.len() as u16;

                if mouse.row >= project_start_row && mouse.row < project_end_row {
                    let project_index = (mouse.row - project_start_row) as usize;
                    if project_index < self.workspace.projects.len() {
                        return Action::ShowProjectMenu(project_index, mouse.column, mouse.row);
                    }
                }
            }
            _ => {}
        }
        Action::None
    }

    /// 执行动作
    fn execute_action(&mut self, action: Action) -> Result<()> {
        match action {
            Action::SendBytes(bytes) => {
                if let Some(ref mut pty) = self.pty {
                    pty.write(&bytes)?;
                }
            }
            Action::ResizePty(cols, rows) => {
                if let Some(ref pty) = self.pty {
                    pty.resize(cols, rows)?;
                }
                self.terminal.resize(rows, cols);
            }
            Action::Quit => {
                self.should_quit = true;
            }
            Action::ShowProjectMenu(idx, x, y) => {
                self.context_menu = ContextMenu {
                    visible: true,
                    project_index: idx,
                    x,
                    y,
                    selected: 0,
                };
            }
            Action::HideMenu => {
                self.context_menu.visible = false;
            }
            Action::OpenProjectPath(idx) => {
                self.context_menu.visible = false;
                if let Some(project) = self.workspace.projects.get(idx) {
                    let _ = open_in_explorer(&project.path);
                }
            }
            Action::CopyFullPath(idx) => {
                self.context_menu.visible = false;
                if let Some(project) = self.workspace.projects.get(idx) {
                    let full_path = std::fs::canonicalize(&project.path)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|_| project.path.clone());
                    let _ = copy_to_clipboard(&full_path);
                }
            }
            Action::CopyRelativePath(idx) => {
                self.context_menu.visible = false;
                if let Some(project) = self.workspace.projects.get(idx) {
                    let _ = copy_to_clipboard(&project.path);
                }
            }
            Action::None => {}
        }
        Ok(())
    }

    /// 处理窗口大小变化
    fn handle_resize(&mut self, width: u16, height: u16) -> Result<()> {
        let (cols, rows) = ui::terminal_inner_size(
            ratatui::layout::Rect::new(0, 0, width, height),
            self.project_branches.len(),
        );
        self.execute_action(Action::ResizePty(cols, rows))
    }
}

/// 将按键事件转换为字节序列
fn key_to_bytes(key: event::KeyEvent) -> Vec<u8> {
    let mut bytes = Vec::new();

    // 处理 Ctrl 修饰符
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        match key.code {
            KeyCode::Char(c) => {
                // Ctrl+A = 1, Ctrl+B = 2, ..., Ctrl+Z = 26
                let ctrl_code = (c.to_ascii_lowercase() as u8).wrapping_sub(b'a' - 1);
                if ctrl_code <= 26 {
                    bytes.push(ctrl_code);
                }
            }
            _ => {}
        }
        return bytes;
    }

    match key.code {
        KeyCode::Char(c) => {
            let mut buf = [0u8; 4];
            bytes.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
        }
        KeyCode::Enter => bytes.push(b'\r'),
        KeyCode::Backspace => bytes.push(0x7f),
        KeyCode::Tab => bytes.push(b'\t'),
        KeyCode::Esc => bytes.push(0x1b),
        KeyCode::Up => bytes.extend_from_slice(b"\x1b[A"),
        KeyCode::Down => bytes.extend_from_slice(b"\x1b[B"),
        KeyCode::Right => bytes.extend_from_slice(b"\x1b[C"),
        KeyCode::Left => bytes.extend_from_slice(b"\x1b[D"),
        KeyCode::Home => bytes.extend_from_slice(b"\x1b[H"),
        KeyCode::End => bytes.extend_from_slice(b"\x1b[F"),
        KeyCode::PageUp => bytes.extend_from_slice(b"\x1b[5~"),
        KeyCode::PageDown => bytes.extend_from_slice(b"\x1b[6~"),
        KeyCode::Delete => bytes.extend_from_slice(b"\x1b[3~"),
        KeyCode::Insert => bytes.extend_from_slice(b"\x1b[2~"),
        KeyCode::F(n) => {
            let seq = match n {
                1 => b"\x1bOP".as_slice(),
                2 => b"\x1bOQ",
                3 => b"\x1bOR",
                4 => b"\x1bOS",
                5 => b"\x1b[15~",
                6 => b"\x1b[17~",
                7 => b"\x1b[18~",
                8 => b"\x1b[19~",
                9 => b"\x1b[20~",
                10 => b"\x1b[21~",
                11 => b"\x1b[23~",
                12 => b"\x1b[24~",
                _ => b"",
            };
            bytes.extend_from_slice(seq);
        }
        _ => {}
    }

    bytes
}

/// 在文件管理器中打开路径
fn open_in_explorer(path: &str) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()?;
    }
    Ok(())
}

/// 复制文本到剪贴板
fn copy_to_clipboard(text: &str) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        use std::process::{Command, Stdio};
        let mut child = Command::new("clip")
            .stdin(Stdio::piped())
            .spawn()?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(text.as_bytes())?;
        }
        child.wait()?;
    }
    #[cfg(target_os = "macos")]
    {
        use std::process::{Command, Stdio};
        let mut child = Command::new("pbcopy")
            .stdin(Stdio::piped())
            .spawn()?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(text.as_bytes())?;
        }
        child.wait()?;
    }
    #[cfg(target_os = "linux")]
    {
        use std::process::{Command, Stdio};
        let mut child = Command::new("xclip")
            .args(["-selection", "clipboard"])
            .stdin(Stdio::piped())
            .spawn()?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(text.as_bytes())?;
        }
        child.wait()?;
    }
    Ok(())
}
