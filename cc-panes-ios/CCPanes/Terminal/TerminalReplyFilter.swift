import Foundation

/// 识别 SwiftTerm 对终端查询的自动应答（DA / CPR / DECRQM / OSC 颜色 / DCS / kitty 键盘查询）。
///
/// 手机端是共享 PTY 的旁观者：查询由电脑端 xterm 回答。手机若也回答，应答字节会作为
/// 「输入」再灌进 CLI（重复应答、乱码进提示符），快照回放里的历史查询还会被重复应答。
/// t3code 同理：只让一个 viewer 回答查询。用户按键（方向键 `\e[A`、F 键 `\e[15~` 等）不受影响。
enum TerminalReplyFilter {
    private static let patterns: [NSRegularExpression] = [
        #"^\x1b\[[?>=]?[0-9;]*c$"#,            // Device Attributes 应答
        #"^\x1b\[[0-9]+;[0-9]+R$"#,            // Cursor Position Report
        #"^\x1b\[[0-9]*n$"#,                    // Device Status Report
        #"^\x1b\[\??[0-9;]*\$y$"#,              // DECRQM 应答
        #"^\x1b\[\?[0-9]*u$"#,                  // kitty 键盘协议查询应答
        #"^\x1b\][0-9]+;[^\x07\x1b]*(\x07|\x1b\\)$"#, // OSC 颜色等查询应答
        #"^\x1bP.*\x1b\\$"#,                    // DCS 应答（XTVERSION / DECRQSS）
        #"^\x1b\[[0-9;]*t$"#,                   // 窗口尺寸报告
    ].map { try! NSRegularExpression(pattern: $0, options: [.dotMatchesLineSeparators]) }

    static func isAutomaticReply(_ text: String) -> Bool {
        guard text.hasPrefix("\u{1b}") else { return false }
        let range = NSRange(text.startIndex..., in: text)
        return patterns.contains { $0.firstMatch(in: text, range: range) != nil }
    }
}
