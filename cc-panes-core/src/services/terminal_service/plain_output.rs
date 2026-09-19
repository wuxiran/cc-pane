//! Bounded text view of a VT stream. Cursor/erase operations change cells, never append frames.
//! This is an observation surface, not a transcript: the last visible status line is retained.

use std::collections::VecDeque;
use unicode_width::UnicodeWidthChar;
use vte::{Params, Perform};

const MAX_ROWS: usize = 512;
const MAX_COLS: usize = 1024;
type SavedScreen = (Vec<Vec<String>>, usize, usize, bool);

pub(super) struct OutputBuffer {
    parser: vte::Parser,
    screen: Screen,
}

struct Screen {
    history: VecDeque<String>,
    history_bytes: usize,
    cells: Vec<Vec<String>>,
    row: usize,
    col: usize,
    saved_cursor: (usize, usize),
    rows: usize,
    cols: usize,
    max_lines: usize,
    max_bytes: usize,
    alternate: Option<SavedScreen>,
    scroll_top: usize,
    scroll_bottom: usize,
    wrap_pending: bool,
}

impl OutputBuffer {
    #[cfg(test)]
    pub(super) fn new(max_lines: usize, max_bytes: usize) -> Self {
        Self::with_size(max_lines, max_bytes, 120, 30)
    }

    pub(super) fn with_size(max_lines: usize, max_bytes: usize, cols: u16, rows: u16) -> Self {
        let rows = usize::from(rows).clamp(1, MAX_ROWS);
        Self {
            parser: vte::Parser::new(),
            screen: Screen {
                history: VecDeque::new(),
                history_bytes: 0,
                cells: vec![Vec::new(); rows],
                row: 0,
                col: 0,
                saved_cursor: (0, 0),
                rows,
                cols: usize::from(cols).clamp(1, MAX_COLS),
                max_lines,
                max_bytes,
                alternate: None,
                scroll_top: 0,
                scroll_bottom: rows - 1,
                wrap_pending: false,
            },
        }
    }

    pub(super) fn push(&mut self, text: &str) {
        self.parser.advance(&mut self.screen, text.as_bytes());
    }

    pub(super) fn resize(&mut self, cols: u16, rows: u16) {
        let s = &mut self.screen;
        s.rows = usize::from(rows).clamp(1, MAX_ROWS);
        s.cols = usize::from(cols).clamp(1, MAX_COLS);
        if let Some(main) = s.alternate.take() {
            // Resize the saved main screen too, without adding alternate-screen noise.
            s.alternate = Some(resize_screen(main, s.rows, s.cols, |line| {
                s.remember_line(line);
            }));
        }
        let active = (std::mem::take(&mut s.cells), s.row, s.col, s.wrap_pending);
        (s.cells, s.row, s.col, s.wrap_pending) = resize_screen(active, s.rows, s.cols, |line| {
            if s.alternate.is_none() {
                s.remember_line(line);
            }
        });
        s.saved_cursor.0 = s.saved_cursor.0.min(s.rows - 1);
        s.saved_cursor.1 = s.saved_cursor.1.min(s.cols - 1);
        s.scroll_top = 0;
        s.scroll_bottom = s.rows - 1;
    }

    pub(super) fn shrink(&mut self, max_lines: usize, max_bytes: usize) {
        self.screen.max_lines = max_lines;
        self.screen.max_bytes = max_bytes;
        self.screen.evict();
    }

    pub(super) fn get_recent(&self, n: usize) -> Vec<String> {
        let s = &self.screen;
        let visible = s.cells.iter().map(|row| render(row)).collect::<Vec<_>>();
        let visible_len = visible
            .iter()
            .rposition(|line| !line.is_empty())
            .map_or(0, |i| i + 1);
        let limit = if n == 0 {
            s.max_lines
        } else {
            n.min(s.max_lines)
        };
        let mut bytes = 0;
        let mut result = Vec::new();
        let history_len = if s.alternate.is_none() {
            s.history.len()
        } else {
            0
        };
        for line in s
            .history
            .iter()
            .take(history_len)
            .chain(visible[..visible_len].iter())
            .rev()
            .take(limit)
        {
            if bytes + line.len() > s.max_bytes {
                break;
            }
            bytes += line.len();
            result.push(line.clone());
        }
        result.reverse();
        result
    }
}

fn render(row: &[String]) -> String {
    row.concat().trim_end().to_string()
}

/// Preserve physical line boundaries when growing; split overlong rows when shrinking.
/// This intentionally does not reconstruct logical lines from old soft wraps.
fn resize_screen(
    (mut cells, cursor_row, cursor_col, wrap_pending): SavedScreen,
    rows: usize,
    cols: usize,
    mut remember: impl FnMut(String),
) -> SavedScreen {
    let used = cells
        .iter()
        .rposition(|line| line.iter().any(|cell| !cell.trim().is_empty()))
        .map_or(0, |row| row + 1)
        .max(cursor_row + 1);
    cells.truncate(used);
    let mut visible = VecDeque::new();
    let mut removed = 0;
    let mut cursor = (0, 0, false);
    for (row_index, source) in cells.into_iter().enumerate() {
        let target = cursor_col + usize::from(wrap_pending);
        let length = source
            .len()
            .max(if row_index == cursor_row { target } else { 0 });
        let mut line = Vec::new();
        let mut index = 0;
        while index < length {
            let cell = source.get(index).filter(|cell| !cell.is_empty());
            let glyph = cell.map(String::as_str).unwrap_or(" ");
            let source_width =
                if cell.is_some() && source.get(index + 1).is_some_and(String::is_empty) {
                    2
                } else {
                    1
                };
            // A one-column observation still keeps a wide glyph's text. On expansion
            // its real width is recovered from the glyph, not the old continuation cell.
            let width = glyph
                .chars()
                .next()
                .and_then(UnicodeWidthChar::width)
                .unwrap_or(1)
                .clamp(1, cols);
            if line.len() + width > cols {
                keep_resized_line(
                    &mut visible,
                    std::mem::take(&mut line),
                    rows,
                    &mut removed,
                    &mut remember,
                );
            }
            if row_index == cursor_row && (index..index + source_width).contains(&target) {
                cursor = (
                    removed + visible.len(),
                    line.len() + (target - index).min(width - 1),
                    false,
                );
            }
            line.push(glyph.to_string());
            if width == 2 {
                line.push(String::new());
            }
            index += source_width;
        }
        if row_index == cursor_row && target >= length {
            cursor = (
                removed + visible.len(),
                line.len().min(cols - 1),
                line.len() == cols,
            );
        }
        keep_resized_line(&mut visible, line, rows, &mut removed, &mut remember);
    }
    let mut cells: Vec<_> = visible.into_iter().collect();
    cells.resize(rows, Vec::new());
    (
        cells,
        cursor.0.saturating_sub(removed).min(rows - 1),
        cursor.1,
        cursor.2,
    )
}

fn keep_resized_line(
    visible: &mut VecDeque<Vec<String>>,
    line: Vec<String>,
    rows: usize,
    removed: &mut usize,
    remember: &mut impl FnMut(String),
) {
    visible.push_back(line);
    if visible.len() > rows {
        if let Some(line) = visible.pop_front() {
            remember(render(&line));
            *removed += 1;
        }
    }
}

impl Screen {
    fn remember_line(&mut self, line: String) {
        self.history_bytes += line.len();
        self.history.push_back(line);
        self.evict();
    }

    fn evict(&mut self) {
        while self.history.len() > self.max_lines || self.history_bytes > self.max_bytes {
            if let Some(line) = self.history.pop_front() {
                self.history_bytes -= line.len();
            } else {
                break;
            }
        }
    }

    fn scroll_up(&mut self) {
        let removed = self.cells.remove(self.scroll_top);
        self.cells.insert(self.scroll_bottom, Vec::new());
        if self.alternate.is_none() && self.scroll_top == 0 && self.scroll_bottom == self.rows - 1 {
            let line = render(&removed);
            self.history_bytes += line.len();
            self.history.push_back(line);
            self.evict();
        }
    }

    fn newline(&mut self) {
        if self.row == self.scroll_bottom {
            self.scroll_up();
        } else {
            self.row = (self.row + 1).min(self.rows - 1);
        }
        self.wrap_pending = false;
    }

    fn clear_cell(&mut self, col: usize) {
        let row = &mut self.cells[self.row];
        if col >= row.len() {
            return;
        }
        // An empty cell is the continuation of a wide glyph.
        if row[col].is_empty() && col > 0 {
            row[col - 1] = " ".into();
        }
        if col + 1 < row.len() && row[col + 1].is_empty() {
            row[col + 1] = " ".into();
        }
        row[col] = " ".into();
    }

    fn erase_line(&mut self, mode: u16) {
        let (start, end) = match mode {
            0 => (self.col, self.cells[self.row].len()),
            1 => (0, (self.col + 1).min(self.cells[self.row].len())),
            2 => {
                self.cells[self.row].clear();
                return;
            }
            _ => return,
        };
        for col in start..end {
            self.clear_cell(col);
        }
    }

    fn erase_display(&mut self, mode: u16) {
        match mode {
            0 => {
                self.erase_line(0);
                for row in &mut self.cells[self.row + 1..] {
                    row.clear();
                }
            }
            1 => {
                self.erase_line(1);
                for row in &mut self.cells[..self.row] {
                    row.clear();
                }
            }
            2 => {
                for row in &mut self.cells {
                    row.clear();
                }
            }
            3 => {
                self.history.clear();
                self.history_bytes = 0;
            }
            _ => {}
        }
    }

    fn alternate_screen(&mut self, enabled: bool) {
        if enabled && self.alternate.is_none() {
            let old = std::mem::replace(&mut self.cells, vec![Vec::new(); self.rows]);
            self.alternate = Some((old, self.row, self.col, self.wrap_pending));
            self.row = 0;
            self.col = 0;
            self.wrap_pending = false;
        } else if !enabled {
            if let Some((cells, row, col, wrap_pending)) = self.alternate.take() {
                self.cells = cells;
                self.row = row;
                self.col = col;
                self.wrap_pending = wrap_pending;
            }
        }
    }
}

impl Perform for Screen {
    fn print(&mut self, c: char) {
        let width = c.width().unwrap_or(0);
        if width == 0 {
            let col = if self.wrap_pending {
                self.col
            } else {
                self.col.saturating_sub(1)
            };
            let col = if self.cells[self.row].get(col).is_some_and(String::is_empty) {
                col.saturating_sub(1)
            } else {
                col
            };
            if let Some(cell) = self.cells[self.row].get_mut(col) {
                // Combining-mark floods cannot grow a cell without bound.
                if cell.len() < 64 {
                    cell.push(c);
                }
            }
            return;
        }
        if self.wrap_pending || self.col + width > self.cols {
            self.newline();
            self.col = 0;
        }
        if width > self.cols {
            return;
        }
        self.clear_cell(self.col);
        if width == 2 {
            self.clear_cell(self.col + 1);
        }
        let row = &mut self.cells[self.row];
        row.resize(row.len().max(self.col + width), " ".into());
        row[self.col] = c.to_string();
        if width == 2 {
            row[self.col + 1].clear();
        }
        self.col += width;
        if self.col >= self.cols {
            self.col = self.cols - 1;
            self.wrap_pending = true;
        }
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            b'\r' => {
                self.col = 0;
                self.wrap_pending = false;
            }
            b'\n' | 0x0b | 0x0c => {
                self.newline();
                self.col = 0;
            }
            8 => {
                self.col = self.col.saturating_sub(1);
                self.wrap_pending = false;
            }
            b'\t' => {
                self.col = ((self.col / 8 + 1) * 8).min(self.cols - 1);
                self.wrap_pending = false;
            }
            _ => {}
        }
    }

    fn esc_dispatch(&mut self, _intermediates: &[u8], ignore: bool, byte: u8) {
        if ignore {
            return;
        }
        match byte {
            b'7' => self.saved_cursor = (self.row, self.col),
            b'8' => {
                self.row = self.saved_cursor.0.min(self.rows - 1);
                self.col = self.saved_cursor.1.min(self.cols - 1);
            }
            b'D' => self.newline(),
            b'E' => {
                self.newline();
                self.col = 0;
            }
            b'M' => {
                if self.row == self.scroll_top {
                    self.cells.remove(self.scroll_bottom);
                    self.cells.insert(self.scroll_top, Vec::new());
                } else {
                    self.row = self.row.saturating_sub(1);
                }
            }
            b'c' => {
                self.erase_display(2);
                self.row = 0;
                self.col = 0;
            }
            _ => {}
        }
        self.wrap_pending = false;
    }

    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], ignore: bool, action: char) {
        if ignore {
            return;
        }
        let p = |i: usize, default: u16| {
            params
                .iter()
                .nth(i)
                .and_then(|v| v.first())
                .copied()
                .unwrap_or(default)
        };
        let n = usize::from(p(0, 1).max(1));
        if intermediates == b"?" {
            if matches!(action, 'h' | 'l')
                && params
                    .iter()
                    .any(|v| matches!(v.first(), Some(47 | 1047 | 1049)))
            {
                self.alternate_screen(action == 'h');
            }
            return;
        }
        if !intermediates.is_empty() {
            return;
        }
        match action {
            'A' => self.row = self.row.saturating_sub(n),
            'B' | 'e' => self.row = (self.row + n).min(self.rows - 1),
            'C' | 'a' => self.col = (self.col + n).min(self.cols - 1),
            'D' => self.col = self.col.saturating_sub(n),
            'E' => {
                self.row = (self.row + n).min(self.rows - 1);
                self.col = 0;
            }
            'F' => {
                self.row = self.row.saturating_sub(n);
                self.col = 0;
            }
            'G' | '`' => self.col = (n - 1).min(self.cols - 1),
            'd' => self.row = (n - 1).min(self.rows - 1),
            'H' | 'f' => {
                self.row = (n - 1).min(self.rows - 1);
                self.col = usize::from(p(1, 1).max(1) - 1).min(self.cols - 1);
            }
            'J' => self.erase_display(p(0, 0)),
            'K' => self.erase_line(p(0, 0)),
            's' => self.saved_cursor = (self.row, self.col),
            'u' => {
                self.row = self.saved_cursor.0.min(self.rows - 1);
                self.col = self.saved_cursor.1.min(self.cols - 1);
            }
            'S' => {
                for _ in 0..n.min(self.rows) {
                    self.scroll_up();
                }
            }
            'T' => {
                for _ in 0..n.min(self.rows) {
                    self.cells.remove(self.scroll_bottom);
                    self.cells.insert(self.scroll_top, Vec::new());
                }
            }
            'X' => {
                for col in self.col..(self.col + n).min(self.cols) {
                    self.clear_cell(col);
                }
            }
            'P' => {
                let row = &mut self.cells[self.row];
                if self.col < row.len() {
                    row.drain(self.col..(self.col + n).min(row.len()));
                }
            }
            '@' => {
                let row = &mut self.cells[self.row];
                row.resize(row.len().max(self.col), " ".into());
                for _ in 0..n.min(self.cols) {
                    row.insert(self.col, " ".into());
                }
                row.truncate(self.cols);
            }
            'L' | 'M' if (self.scroll_top..=self.scroll_bottom).contains(&self.row) => {
                for _ in 0..n.min(self.scroll_bottom - self.row + 1) {
                    if action == 'L' {
                        self.cells.remove(self.scroll_bottom);
                        self.cells.insert(self.row, Vec::new());
                    } else {
                        self.cells.remove(self.row);
                        self.cells.insert(self.scroll_bottom, Vec::new());
                    }
                }
            }
            'r' => {
                let top = n - 1;
                let bottom = usize::from(p(1, self.rows as u16).max(1)) - 1;
                if top < bottom && bottom < self.rows {
                    self.scroll_top = top;
                    self.scroll_bottom = bottom;
                    self.row = 0;
                    self.col = 0;
                }
            }
            // SGR and other display attributes do not move the cursor.
            _ => return,
        }
        self.wrap_pending = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue64_plain_keeps_normal_text_and_unicode_cursor_cells() {
        let mut b = OutputBuffer::new(64, 65536);
        b.push("Working on a real report\r\n中文e\u{301}\x1b[2D好");
        assert_eq!(b.get_recent(0), ["Working on a real report", "中 好"]);
    }

    #[test]
    fn issue64_plain_bounds_history_and_unterminated_osc() {
        let mut b = OutputBuffer::with_size(3, 12, 20, 2);
        for _ in 0..100 {
            b.push("abcd\r\n");
        }
        b.push("\x1b]52;c;");
        b.push(&"x".repeat(100_000));
        b.push("\x07tail");
        assert!(b.get_recent(0).len() <= 3);
        assert!(b.get_recent(0).join("").len() <= 12);
        assert_eq!(b.get_recent(1), ["tail"]);
    }

    #[test]
    fn issue64_plain_screen_clear_and_alternate_restore() {
        let mut b = OutputBuffer::new(64, 65536);
        b.push("original\x1b[?1049hspinner\r\x1b[2Kdone");
        assert_eq!(b.get_recent(0), ["done"]);
        b.push("\x1b[?1049l");
        assert_eq!(b.get_recent(0), ["original"]);
        b.push("\x1b[2J\x1b[Hfinal");
        assert_eq!(b.get_recent(0), ["final"]);
    }

    #[test]
    fn issue64_plain_wrap_resize_sgr_and_wide_overwrite() {
        let mut b = OutputBuffer::with_size(64, 65536, 4, 3);
        b.push("abcd\x1b[31m\x1b[0mef");
        assert_eq!(b.get_recent(0), ["abcd", "ef"]);
        b.resize(8, 4);
        b.push("\x1b[2J\x1b[H中文\rA");
        assert_eq!(b.get_recent(0), ["A 文"]);
        b.push("\r\x1b[2Kdone\r\nnext");
        assert_eq!(b.get_recent(0), ["done", "next"]);
    }

    #[test]
    fn issue64_plain_height_shrink_preserves_latest_output_and_history() {
        let mut b = OutputBuffer::with_size(64, 65536, 80, 3);
        b.push("old\r\nmiddle\r\nFINAL");
        b.resize(80, 2);
        assert_eq!(b.get_recent(0), ["old", "middle", "FINAL"]);
        assert_eq!(b.screen.history.front().map(String::as_str), Some("old"));
        b.push("!");
        assert_eq!(b.get_recent(1), ["FINAL!"]);

        let mut b = OutputBuffer::with_size(64, 65536, 80, 10);
        b.push("first\r\nlast");
        b.resize(80, 2);
        assert!(
            b.screen.history.is_empty(),
            "discard unused bottom rows first"
        );
        assert_eq!(b.get_recent(0), ["first", "last"]);
    }

    #[test]
    fn issue64_plain_width_shrink_keeps_unicode_and_cursor_append() {
        for text in ["abcdefgh", "a中文e\u{301}z", "中文"] {
            for width in [1, 2, 3, 4] {
                let mut b = OutputBuffer::with_size(64, 65536, 8, 8);
                b.push(text);
                b.resize(width, 8);
                assert_eq!(b.get_recent(0).concat(), text);
                assert!(b
                    .screen
                    .cells
                    .iter()
                    .all(|row| row.len() <= usize::from(width)));
                b.resize(16, 8);
                assert_eq!(b.get_recent(0).concat(), text);
                b.push("!");
                assert_eq!(b.get_recent(0).concat(), format!("{text}!"));
            }
        }
    }

    #[test]
    fn issue64_plain_resize_keeps_pending_wrap_on_last_character() {
        let mut b = OutputBuffer::with_size(64, 65536, 4, 3);
        b.push("abcd");
        b.resize(4, 2);
        b.push("e");
        assert_eq!(b.get_recent(0), ["abcd", "e"]);
    }

    #[test]
    fn issue64_plain_resize_alternate_does_not_pollute_main_history() {
        let mut b = OutputBuffer::with_size(64, 65536, 8, 4);
        b.push("old\r\n中文e\u{301}\x1b[?1049hALTERNATE\r\nnoise");
        b.resize(2, 2);
        assert!(b.screen.history.iter().all(|line| !line.contains("ALT")));
        b.push("\x1b[?1049l!");
        assert_eq!(b.get_recent(0).concat(), "old中文e\u{301}!");
        b.resize(8, 4);
        assert_eq!(b.get_recent(0).concat(), "old中文e\u{301}!");
        assert!(b.screen.cells.iter().all(|row| row.len() <= 8));
    }

    #[test]
    fn issue64_plain_resize_stays_bounded() {
        let mut b = OutputBuffer::with_size(4, 16, 80, 24);
        for _ in 0..100 {
            b.push("abcdefghijklmnop\r\n");
            b.resize(1, 1);
            b.resize(80, 24);
        }
        assert!(b.screen.history.len() <= 4);
        assert!(b.screen.history_bytes <= 16);
        assert!(b.get_recent(0).concat().len() <= 16);
        assert!(b.screen.cells.len() <= 24);
    }

    #[test]
    fn issue64_plain_survives_split_utf8_and_escape_at_every_byte() {
        let data = "before\r\n中文\x1b[1A\r\x1b[J最终答案".as_bytes();
        let mut b = OutputBuffer::new(64, 65536);
        for byte in data {
            b.parser.advance(&mut b.screen, std::slice::from_ref(byte));
        }
        assert_eq!(b.get_recent(0), ["最终答案"]);
    }

    #[test]
    fn issue64_plain_redraw_flood_has_bounded_history_and_current_screen() {
        let mut b = OutputBuffer::with_size(100, 4096, 80, 24);
        for i in 0..20_000 {
            b.push(&format!("\r\x1b[2Kframe {i} 中文\x1b[32m\x1b[0m"));
        }
        assert_eq!(b.get_recent(0), ["frame 19999 中文"]);
        for _ in 0..20_000 {
            b.push("log line with content\r\n");
        }
        assert!(b.screen.history.len() <= 100);
        assert!(b.screen.history_bytes <= 4096);
        assert!(b.screen.cells.len() <= 24);
        assert!(b.get_recent(0).len() <= 100);
        assert!(b.get_recent(0).iter().map(String::len).sum::<usize>() <= 4096);
    }
}
