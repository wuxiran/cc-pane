//! OSC 会话状态信号检测器（in-band 通道）。
//!
//! 挂在 PTY 读线程的字节流上，识别两类 OSC 序列并转为状态机事件：
//! - `OSC 777;notify;CCPanes;<agent>;<event>` — cc-panes-cli-hook 经
//!   `terminalSequence` 写入终端的自定义标记，`<event>` 为 cc-pane 事件名
//!   （prompt-before / tool-before / turn-end / waiting-input / ...）
//! - `OSC 133;C;<cmd>` / `OSC 133;D;<exit>` — shell 集成命令边界：
//!   命令行匹配已知 agent 时武装检测器，`D` 携带退出码
//!
//! 不识别 OSC 9 / 非 CCPanes 的 777：任意第三方通知都会被映射成状态跃迁，
//! agent 工作期间的一条桌面通知就能把状态误标成"等待输入"（审阅发现），
//! 收益不抵误报。
//!
//! 设计原则（移植自 Terax agent_detect.rs, MIT）：状态信号**只来自 OSC 序列，
//! 绝不来自原始输出文本**——TUI 持续重绘不会引起任何状态抖动。Ground 态按
//! ESC 跳跃扫描（不逐字节进状态机），TUI 刷屏热路径开销接近单次 memchr。
//!
//! 与 HTTP hook 通道的关系：同一个 hook 事件可能经 HTTP POST 和本通道双份到达
//! （hook 先阻塞 POST 再输出 OSC，HTTP 恒先应用），去重在
//! `SessionStateMachine::on_event_with_channel` 做，本模块只负责解析。

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const OSC_INTRO: u8 = b']';
const ST_FINAL: u8 = b'\\';

/// OSC 序列体最大长度，超过即丢弃（防御异常输入撑爆缓冲）
const OSC_MAX: usize = 2048;

/// 已知 agent CLI 命令名（`133;C` 命令行匹配 + `777` 标记白名单）
const DEFAULT_AGENTS: &[&str] = &["claude", "codex", "gemini", "opencode"];

/// cc-panes-cli-hook 发出的 OSC 777 标记前缀，
/// 完整格式 `777;notify;CCPanes;<agent>;<event>`。
const CCPANES_MARKER: &[u8] = b"notify;CCPanes;";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    Ground,
    Esc,
    Osc,
    OscEsc,
}

/// 检测器输出的信号，由 PTY 读线程映射为 `CcPaneEvent` 汇入状态机。
#[derive(Clone, PartialEq, Eq, Debug)]
pub(super) enum OscSignal {
    /// `133;C;<cmd>` 命令行匹配到已知 agent（shell 集成，能确认 agent 启动时刻）。
    /// 777 自武装**不发**此信号：launch_task 会话的 session-init 已走 HTTP，
    /// 首个 777 标记（首次 prompt）若再发 Started 会把状态打回 Initializing 闪烁。
    Started { agent: String },
    /// `777;notify;CCPanes;...` 携带的 cc-pane 事件名
    Event { name: String },
    /// `133;D;<exit>`：武装期间的命令结束，退出码可能缺失
    CommandExited { exit_code: Option<i32> },
}

/// 字节级 OSC 解析状态机。每个 PTY 会话一个实例，读线程独占，无锁。
pub(super) struct OscStateDetector {
    agents: Vec<String>,
    state: State,
    osc: Vec<u8>,
    /// 武装 = 已确认 agent 在此会话中运行（133;C 匹配或 777 自报）
    armed: bool,
}

impl OscStateDetector {
    pub(super) fn new() -> Self {
        Self {
            agents: DEFAULT_AGENTS.iter().map(|s| s.to_string()).collect(),
            state: State::Ground,
            osc: Vec::new(),
            armed: false,
        }
    }

    /// 喂入一段原始 PTY 输出。信号只由完整 OSC 序列触发，
    /// 序列可跨 chunk 分片。
    ///
    /// 热路径：TUI 刷屏时几乎每个 chunk 都含 ESC（CSI/SGR 洪流），逐字节
    /// 状态机会让读线程遍历量翻倍。Ground 态用 position() 直接跳到下一个
    /// ESC，普通输出段零逐字节分发。
    pub(super) fn process<F: FnMut(OscSignal)>(&mut self, input: &[u8], mut emit: F) {
        let mut i = 0;
        while i < input.len() {
            if self.state == State::Ground {
                match input[i..].iter().position(|&b| b == ESC) {
                    Some(offset) => {
                        i += offset + 1;
                        self.state = State::Esc;
                        continue;
                    }
                    None => return,
                }
            }
            let b = input[i];
            i += 1;
            match self.state {
                State::Ground => unreachable!("Ground handled by skip loop above"),
                State::Esc => match b {
                    OSC_INTRO => {
                        self.state = State::Osc;
                        self.osc.clear();
                    }
                    ESC => {}
                    _ => self.state = State::Ground,
                },
                State::Osc => match b {
                    BEL => {
                        self.finish_osc(&mut emit);
                        self.state = State::Ground;
                    }
                    ESC => self.state = State::OscEsc,
                    _ => {
                        if self.osc.len() < OSC_MAX {
                            self.osc.push(b);
                        } else {
                            self.osc.clear();
                            self.state = State::Ground;
                        }
                    }
                },
                State::OscEsc => match b {
                    ST_FINAL => {
                        self.finish_osc(&mut emit);
                        self.state = State::Ground;
                    }
                    ESC => {}
                    _ => {
                        self.osc.clear();
                        self.state = State::Ground;
                    }
                },
            }
        }
    }

    fn finish_osc<F: FnMut(OscSignal)>(&mut self, emit: &mut F) {
        let body = std::mem::take(&mut self.osc);
        let (ps, pt) = match body.iter().position(|&c| c == b';') {
            Some(i) => (&body[..i], &body[i + 1..]),
            None => (&body[..], &body[0..0]),
        };
        match ps {
            b"133" => self.handle_osc133(pt, emit),
            b"777" => self.handle_osc777(pt, emit),
            _ => {}
        }
    }

    fn handle_osc777<F: FnMut(OscSignal)>(&mut self, pt: &[u8], emit: &mut F) {
        let Some(tail) = pt.strip_prefix(CCPANES_MARKER) else {
            return;
        };
        // PTY 输出不可信：agent 名必须在白名单里才生效
        let Some(i) = tail.iter().position(|&c| c == b';') else {
            return;
        };
        let Ok(agent) = std::str::from_utf8(&tail[..i]) else {
            return;
        };
        if !self.agents.iter().any(|a| a == agent) {
            return;
        }
        let Ok(event) = std::str::from_utf8(&tail[i + 1..]) else {
            return;
        };
        if event.is_empty() || event.len() > 64 {
            return;
        }
        // hook 标记到达即证明 agent 在跑：静默自武装（不发 Started——
        // 事件本身携带状态，多发 SessionInit 会造成 Initializing 闪烁），
        // 武装的意义是让后续 133;D 能上报 agent 退出。
        self.armed = true;
        emit(OscSignal::Event {
            name: event.to_string(),
        });
    }

    fn handle_osc133<F: FnMut(OscSignal)>(&mut self, pt: &[u8], emit: &mut F) {
        match pt.first() {
            Some(b'C') => {
                if self.armed {
                    return;
                }
                let cmd = pt.strip_prefix(b"C;").unwrap_or(b"");
                if let Some(agent) = self.match_agent(cmd) {
                    self.armed = true;
                    emit(OscSignal::Started { agent });
                }
            }
            Some(b'D') if self.armed => {
                self.armed = false;
                let exit_code = pt
                    .strip_prefix(b"D;")
                    .and_then(|s| std::str::from_utf8(s).ok())
                    .and_then(|s| s.trim().parse::<i32>().ok());
                emit(OscSignal::CommandExited { exit_code });
            }
            _ => {}
        }
    }

    /// 命令行 token 匹配已知 agent：容忍路径前缀（`/usr/local/bin/codex`）、
    /// 包装器（`npx claude`）和 dash 别名（`claude-xxx`），
    /// 但不误配 `cat claude.txt` 或 `claudexyz`。
    fn match_agent(&self, cmd: &[u8]) -> Option<String> {
        let cmd = std::str::from_utf8(cmd).ok()?;
        for token in cmd.split_whitespace() {
            if token.starts_with('-') {
                continue;
            }
            let base = token.rsplit(['/', '\\']).next().unwrap_or(token);
            // Windows 下可能带 .exe/.cmd 扩展名
            let base = base
                .strip_suffix(".exe")
                .or_else(|| base.strip_suffix(".cmd"))
                .unwrap_or(base);
            if let Some(agent) = self.agents.iter().find(|a| {
                base.strip_prefix(a.as_str())
                    .is_some_and(|rest| rest.is_empty() || rest.starts_with('-'))
            }) {
                return Some(agent.clone());
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(d: &mut OscStateDetector, input: &[u8]) -> Vec<OscSignal> {
        let mut out = Vec::new();
        d.process(input, |s| out.push(s));
        out
    }

    fn osc(body: &str) -> Vec<u8> {
        let mut v = vec![ESC, OSC_INTRO];
        v.extend_from_slice(body.as_bytes());
        v.extend_from_slice(&[ESC, ST_FINAL]);
        v
    }

    fn started(agent: &str) -> OscSignal {
        OscSignal::Started {
            agent: agent.into(),
        }
    }

    fn event(name: &str) -> OscSignal {
        OscSignal::Event { name: name.into() }
    }

    #[test]
    fn arms_on_agent_command() {
        let mut d = OscStateDetector::new();
        assert_eq!(
            run(&mut d, &osc("133;C;claude -p hello")),
            vec![started("claude")]
        );
    }

    #[test]
    fn arms_on_pathed_wrapped_and_windows_commands() {
        let mut d = OscStateDetector::new();
        assert_eq!(
            run(&mut d, &osc("133;C;/usr/local/bin/codex exec")),
            vec![started("codex")]
        );
        let mut d2 = OscStateDetector::new();
        assert_eq!(
            run(&mut d2, &osc("133;C;npx claude")),
            vec![started("claude")]
        );
        let mut d3 = OscStateDetector::new();
        assert_eq!(
            run(&mut d3, &osc(r"133;C;C:\Users\x\AppData\npm\claude.cmd")),
            vec![started("claude")]
        );
    }

    #[test]
    fn does_not_arm_on_other_commands() {
        let mut d = OscStateDetector::new();
        assert!(run(&mut d, &osc("133;C;vim src/main.rs")).is_empty());
        assert!(run(&mut d, &osc("133;C;cat claude.txt")).is_empty());
        assert!(run(&mut d, &osc("133;C;claudexyz")).is_empty());
    }

    #[test]
    fn ccpanes_marker_silently_arms_and_carries_event() {
        let mut d = OscStateDetector::new();
        // 自武装不发 Started（避免 SessionInit 闪烁），只发事件本身
        assert_eq!(
            run(&mut d, &osc("777;notify;CCPanes;claude;prompt-before")),
            vec![event("prompt-before")]
        );
        assert!(d.armed);
        assert_eq!(
            run(&mut d, &osc("777;notify;CCPanes;claude;turn-end")),
            vec![event("turn-end")]
        );
        // 武装后 133;D 能上报退出
        assert_eq!(
            run(&mut d, &osc("133;D;0")),
            vec![OscSignal::CommandExited { exit_code: Some(0) }]
        );
    }

    #[test]
    fn ccpanes_marker_rejects_unknown_agent() {
        let mut d = OscStateDetector::new();
        assert!(run(&mut d, &osc("777;notify;CCPanes;evil;turn-end")).is_empty());
        // 同一 chunk 里合法 agent 仍生效
        assert_eq!(
            run(&mut d, &osc("777;notify;CCPanes;codex;waiting-input")),
            vec![event("waiting-input")]
        );
    }

    #[test]
    fn foreign_osc777_and_osc9_are_ignored() {
        // 第三方通知不映射状态：armed 与否都不产生信号（防误报 WaitingInput）
        let mut d = OscStateDetector::new();
        assert!(run(&mut d, &osc("777;notify;Other;ready")).is_empty());
        assert!(run(&mut d, &osc("9;needs you")).is_empty());
        run(&mut d, &osc("133;C;codex"));
        assert!(run(&mut d, &osc("777;notify;Other;ready")).is_empty());
        assert!(run(&mut d, &osc("9;needs you")).is_empty());
        assert!(run(&mut d, &osc("9;4;1;50")).is_empty());
    }

    #[test]
    fn command_exit_carries_exit_code_and_disarms() {
        let mut d = OscStateDetector::new();
        run(&mut d, &osc("133;C;claude"));
        assert_eq!(
            run(&mut d, &osc("133;D;0")),
            vec![OscSignal::CommandExited { exit_code: Some(0) }]
        );
        // 已解除武装：重复 D 无信号
        assert!(run(&mut d, &osc("133;D;0")).is_empty());
        // 未武装时 D 无信号（普通 shell 命令结束）
        let mut d2 = OscStateDetector::new();
        assert!(run(&mut d2, &osc("133;D;1")).is_empty());
    }

    #[test]
    fn exit_code_absent_is_none() {
        let mut d = OscStateDetector::new();
        run(&mut d, &osc("133;C;claude"));
        assert_eq!(
            run(&mut d, &osc("133;D")),
            vec![OscSignal::CommandExited { exit_code: None }]
        );
    }

    #[test]
    fn ignores_bell_and_plain_output() {
        let mut d = OscStateDetector::new();
        run(&mut d, &osc("133;C;claude"));
        assert!(run(&mut d, &[BEL]).is_empty());
        assert!(run(&mut d, b"thinking...\x07more").is_empty());
    }

    #[test]
    fn bel_terminated_osc_title_is_ignored() {
        let mut d = OscStateDetector::new();
        run(&mut d, &osc("133;C;claude"));
        let mut seq = vec![ESC, OSC_INTRO];
        seq.extend_from_slice(b"0;set title");
        seq.push(BEL);
        assert!(run(&mut d, &seq).is_empty());
    }

    #[test]
    fn bel_terminates_ccpanes_marker() {
        // BEL 与 ESC\ 一样是合法 OSC 终止符
        let mut d = OscStateDetector::new();
        let mut seq = vec![ESC, OSC_INTRO];
        seq.extend_from_slice(b"777;notify;CCPanes;claude;turn-end");
        seq.push(BEL);
        assert_eq!(run(&mut d, &seq), vec![event("turn-end")]);
    }

    #[test]
    fn sequence_split_across_chunks() {
        let mut d = OscStateDetector::new();
        assert!(run(&mut d, &[ESC, OSC_INTRO]).is_empty());
        assert!(run(&mut d, b"133;C;cla").is_empty());
        let mut out = run(&mut d, b"ude");
        out.extend(run(&mut d, &[ESC, ST_FINAL]));
        assert_eq!(out, vec![started("claude")]);
    }

    #[test]
    fn oversized_osc_is_dropped_without_panic() {
        let mut d = OscStateDetector::new();
        run(&mut d, &osc("133;C;claude"));
        let mut seq = vec![ESC, OSC_INTRO];
        seq.extend(std::iter::repeat(b'x').take(OSC_MAX + 100));
        seq.extend_from_slice(&[ESC, ST_FINAL]);
        assert!(run(&mut d, &seq).is_empty());
        // 后续序列不受影响
        assert_eq!(
            run(&mut d, &osc("777;notify;CCPanes;claude;turn-end")),
            vec![event("turn-end")]
        );
    }

    #[test]
    fn ground_skip_scan_handles_csi_flood() {
        // TUI 典型输出：大量 CSI/SGR 序列夹杂正文，其间的 OSC 标记仍被解析
        let mut d = OscStateDetector::new();
        let mut stream = Vec::new();
        for _ in 0..50 {
            stream.extend_from_slice(b"\x1b[2K\x1b[38;5;208mspinner frame\x1b[0m\r");
        }
        stream.extend_from_slice(&osc("777;notify;CCPanes;claude;waiting-input"));
        stream.extend_from_slice(b"\x1b[1mmore output\x1b[0m");
        assert_eq!(run(&mut d, &stream), vec![event("waiting-input")]);
    }

    #[test]
    fn overlong_event_name_is_rejected() {
        let mut d = OscStateDetector::new();
        let long = "x".repeat(65);
        assert!(run(&mut d, &osc(&format!("777;notify;CCPanes;claude;{long}"))).is_empty());
    }
}
