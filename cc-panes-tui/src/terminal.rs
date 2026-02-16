//! 终端模拟器模块 - 使用 vt100 解析 ANSI 序列

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

/// 终端模拟器封装
pub struct Terminal {
    parser: vt100::Parser,
}

impl Terminal {
    /// 创建新的终端模拟器
    pub fn new(rows: u16, cols: u16) -> Self {
        Self {
            parser: vt100::Parser::new(rows, cols, 0),
        }
    }

    /// 处理 PTY 输出数据
    pub fn process(&mut self, data: &[u8]) {
        self.parser.process(data);
    }

    /// 调整终端大小
    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.parser.set_size(rows, cols);
    }

    /// 获取屏幕内容作为 ratatui Lines
    pub fn screen_lines(&self) -> Vec<Line<'static>> {
        let screen = self.parser.screen();
        let mut lines = Vec::new();

        for row in 0..screen.size().0 {
            let mut spans = Vec::new();
            let mut current_text = String::new();
            let mut current_style = Style::default();

            for col in 0..screen.size().1 {
                let cell = screen.cell(row, col).unwrap();
                let style = cell_to_style(&cell);

                if style != current_style && !current_text.is_empty() {
                    spans.push(Span::styled(current_text.clone(), current_style));
                    current_text.clear();
                }

                current_style = style;
                current_text.push(cell.contents().chars().next().unwrap_or(' '));
            }

            if !current_text.is_empty() {
                spans.push(Span::styled(current_text, current_style));
            }

            lines.push(Line::from(spans));
        }

        lines
    }

    /// 获取光标位置
    pub fn cursor_position(&self) -> (u16, u16) {
        let screen = self.parser.screen();
        screen.cursor_position()
    }

    /// 光标是否可见
    pub fn cursor_visible(&self) -> bool {
        !self.parser.screen().hide_cursor()
    }
}

/// 将 vt100 Cell 转换为 ratatui Style
fn cell_to_style(cell: &vt100::Cell) -> Style {
    let mut style = Style::default();

    // 前景色
    style = style.fg(vt100_color_to_ratatui(cell.fgcolor()));

    // 背景色
    style = style.bg(vt100_color_to_ratatui(cell.bgcolor()));

    // 修饰符
    let mut modifiers = Modifier::empty();
    if cell.bold() {
        modifiers |= Modifier::BOLD;
    }
    if cell.italic() {
        modifiers |= Modifier::ITALIC;
    }
    if cell.underline() {
        modifiers |= Modifier::UNDERLINED;
    }
    if cell.inverse() {
        modifiers |= Modifier::REVERSED;
    }

    style.add_modifier(modifiers)
}

/// 将 vt100 颜色转换为 ratatui 颜色
fn vt100_color_to_ratatui(color: vt100::Color) -> Color {
    match color {
        vt100::Color::Default => Color::Reset,
        vt100::Color::Idx(i) => Color::Indexed(i),
        vt100::Color::Rgb(r, g, b) => Color::Rgb(r, g, b),
    }
}
