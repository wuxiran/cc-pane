//! UI 渲染模块

use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use ratatui::Frame;

use crate::app::{ClaudeStatus, ContextMenu, SessionDialog};
use crate::terminal::Terminal;
use crate::workspace::Workspace;

/// 渲染整个界面
pub fn render(
    frame: &mut Frame,
    workspace: &Workspace,
    project_branches: &[(String, Option<String>)],
    terminal: &Terminal,
    claude_status: &ClaudeStatus,
    context_menu: &ContextMenu,
    session_dialog: &SessionDialog,
) {
    let chunks = Layout::vertical([
        Constraint::Length(header_height(project_branches.len())),
        Constraint::Min(10),
        Constraint::Length(1),  // 状态栏
    ])
    .split(frame.area());

    render_header(frame, chunks[0], workspace, project_branches);
    render_terminal(frame, chunks[1], terminal);
    render_status_bar(frame, chunks[2], claude_status);

    // 渲染上下文菜单（如果可见）
    if context_menu.visible {
        render_context_menu(frame, context_menu);
    }

    // 渲染会话恢复对话框（如果可见）
    if session_dialog.visible {
        render_session_dialog(frame, session_dialog);
    }
}

/// 计算头部高度
pub fn header_height(project_count: usize) -> u16 {
    // 标题行 + 项目列表 + 边框
    (3 + project_count.max(1)) as u16
}

/// 渲染头部工作空间信息
fn render_header(
    frame: &mut Frame,
    area: Rect,
    workspace: &Workspace,
    project_branches: &[(String, Option<String>)],
) {
    let mut lines = Vec::new();

    if project_branches.is_empty() {
        lines.push(Line::from("  (无项目)"));
    } else {
        for (name, branch) in project_branches {
            let branch_span = if let Some(b) = branch {
                Span::styled(format!(" [{}]", b), Style::default().fg(Color::Cyan))
            } else {
                Span::raw("")
            };
            lines.push(Line::from(vec![
                Span::raw("  • "),
                Span::raw(name.clone()),
                branch_span,
            ]));
        }
    }

    let title = format!(" CC-Panes: {} ", workspace.name);
    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Blue));

    let paragraph = Paragraph::new(lines).block(block);
    frame.render_widget(paragraph, area);
}

/// 渲染终端输出区域
fn render_terminal(frame: &mut Frame, area: Rect, terminal: &Terminal) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::DarkGray));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    // 获取终端内容
    let lines = terminal.screen_lines();
    let paragraph = Paragraph::new(lines);
    frame.render_widget(paragraph, inner);

    // 渲染光标
    if terminal.cursor_visible() {
        let (row, col) = terminal.cursor_position();
        let cursor_x = inner.x + col;
        let cursor_y = inner.y + row;
        if cursor_x < inner.right() && cursor_y < inner.bottom() {
            frame.set_cursor_position((cursor_x, cursor_y));
        }
    }
}

/// 计算终端区域的内部大小（用于 PTY 大小调整）
pub fn terminal_inner_size(total_area: Rect, project_count: usize) -> (u16, u16) {
    let header_h = header_height(project_count);
    let terminal_h = total_area.height.saturating_sub(header_h);
    // 减去边框
    let inner_h = terminal_h.saturating_sub(2);
    let inner_w = total_area.width.saturating_sub(2);
    (inner_w, inner_h)
}

/// 渲染状态栏
fn render_status_bar(frame: &mut Frame, area: Rect, status: &ClaudeStatus) {
    let (icon, text, color) = if status.status.is_empty() {
        ("⏳", "Working...".to_string(), Color::Yellow)
    } else {
        let (icon, color) = match status.status.as_str() {
            "completed" => ("✓", Color::Green),
            "failed" | "error" => ("✗", Color::Red),
            "blocked" => ("⊘", Color::Magenta),
            "waiting" => ("⏳", Color::Yellow),
            "permission" => ("🔐", Color::Magenta),
            _ => ("●", Color::Yellow),
        };
        let text = match &status.message {
            Some(msg) => format!("[{}] {}", status.status, msg),
            None => format!("[{}]", status.status),
        };
        (icon, text, color)
    };

    let line = Line::from(vec![
        Span::styled(" Status: ", Style::default().fg(Color::DarkGray)),
        Span::styled(format!("{} ", icon), Style::default().fg(color)),
        Span::styled(text, Style::default().fg(color)),
    ]);

    let paragraph = Paragraph::new(line);
    frame.render_widget(paragraph, area);
}

/// 渲染上下文菜单
fn render_context_menu(frame: &mut Frame, menu: &ContextMenu) {
    let menu_items = vec![
        "📂 打开路径",
        "📋 复制完整路径",
        "📄 复制相对路径",
    ];

    let menu_width = 20u16;
    let menu_height = menu_items.len() as u16;

    // 计算菜单位置，确保不超出屏幕
    let area = frame.area();
    let x = menu.x.min(area.width.saturating_sub(menu_width));
    let y = (menu.y + 1).min(area.height.saturating_sub(menu_height + 2));

    let menu_area = Rect::new(x, y, menu_width, menu_height + 2);

    // 清除菜单区域背景
    frame.render_widget(Clear, menu_area);

    // 构建菜单内容
    let lines: Vec<Line> = menu_items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let style = if i == menu.selected {
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::Cyan)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::White)
            };
            Line::styled(format!(" {} ", item), style)
        })
        .collect();

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .style(Style::default().bg(Color::DarkGray));

    let paragraph = Paragraph::new(lines).block(block);
    frame.render_widget(paragraph, menu_area);
}

/// 渲染会话恢复对话框
fn render_session_dialog(frame: &mut Frame, dialog: &SessionDialog) {
    let area = frame.area();

    // 对话框尺寸
    let dialog_width = 50u16.min(area.width.saturating_sub(4));
    let dialog_height = 10u16;

    // 居中显示
    let x = (area.width.saturating_sub(dialog_width)) / 2;
    let y = (area.height.saturating_sub(dialog_height)) / 2;
    let dialog_area = Rect::new(x, y, dialog_width, dialog_height);

    // 清除背景
    frame.render_widget(Clear, dialog_area);

    // 构建对话框内容
    let mut lines = vec![
        Line::from(""),
        Line::from(Span::styled(
            "发现未完成的会话",
            Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
    ];

    // 显示会话信息
    if let Some(ref info) = dialog.session_info {
        lines.push(Line::from(format!("  开始时间: {}", info)));
    }

    lines.push(Line::from(""));

    // 选项
    let options = ["继续上次会话", "开始新会话"];
    for (i, opt) in options.iter().enumerate() {
        let style = if i == dialog.selected {
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::White)
        };
        let prefix = if i == dialog.selected { "▶ " } else { "  " };
        lines.push(Line::styled(format!("{}{}", prefix, opt), style));
    }

    let block = Block::default()
        .title(" 会话恢复 ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .style(Style::default().bg(Color::DarkGray));

    let paragraph = Paragraph::new(lines)
        .block(block)
        .alignment(Alignment::Center);

    frame.render_widget(paragraph, dialog_area);
}
