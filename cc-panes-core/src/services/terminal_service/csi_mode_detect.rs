#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CsiModeSignal {
    PasteReady(bool),
    AlternateBufferExited,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Ground,
    Esc,
    Csi,
    Private,
}

/// Detects the small subset of DEC private modes needed by terminal session state.
///
/// The detector is byte-oriented so CSI sequences may span arbitrary PTY read chunks.
pub(super) struct CsiModeDetector {
    state: State,
    params: Vec<u16>,
    current_param: Option<u16>,
    invalid_param: bool,
}

impl CsiModeDetector {
    pub(super) fn new() -> Self {
        Self {
            state: State::Ground,
            params: Vec::with_capacity(2),
            current_param: None,
            invalid_param: false,
        }
    }

    pub(super) fn process(&mut self, bytes: &[u8], mut emit: impl FnMut(CsiModeSignal)) {
        for &byte in bytes {
            match self.state {
                State::Ground => {
                    if byte == 0x1b {
                        self.state = State::Esc;
                    }
                }
                State::Esc => match byte {
                    b'[' => self.state = State::Csi,
                    0x1b => {}
                    _ => self.state = State::Ground,
                },
                State::Csi => match byte {
                    b'?' => {
                        self.reset_params();
                        self.state = State::Private;
                    }
                    0x1b => self.state = State::Esc,
                    0x40..=0x7e => self.state = State::Ground,
                    _ => {}
                },
                State::Private => match byte {
                    b'0'..=b'9' => self.push_digit(byte - b'0'),
                    b';' => self.finish_param(),
                    b'h' | b'l' => {
                        self.finish_param();
                        if !self.invalid_param {
                            for &param in &self.params {
                                match (param, byte) {
                                    (2004, b'h') => emit(CsiModeSignal::PasteReady(true)),
                                    (2004, b'l') => emit(CsiModeSignal::PasteReady(false)),
                                    (1049, b'l') => emit(CsiModeSignal::AlternateBufferExited),
                                    _ => {}
                                }
                            }
                        }
                        self.reset_params();
                        self.state = State::Ground;
                    }
                    0x1b => {
                        self.reset_params();
                        self.state = State::Esc;
                    }
                    0x40..=0x7e => {
                        self.reset_params();
                        self.state = State::Ground;
                    }
                    _ => self.invalid_param = true,
                },
            }
        }
    }

    fn push_digit(&mut self, digit: u8) {
        let value = self.current_param.unwrap_or(0);
        match value
            .checked_mul(10)
            .and_then(|value| value.checked_add(u16::from(digit)))
        {
            Some(value) => self.current_param = Some(value),
            None => self.invalid_param = true,
        }
    }

    fn finish_param(&mut self) {
        match self.current_param.take() {
            Some(param) => self.params.push(param),
            None => self.invalid_param = true,
        }
    }

    fn reset_params(&mut self) {
        self.params.clear();
        self.current_param = None;
        self.invalid_param = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(detector: &mut CsiModeDetector, bytes: &[u8]) -> Vec<CsiModeSignal> {
        let mut signals = Vec::new();
        detector.process(bytes, |signal| signals.push(signal));
        signals
    }

    #[test]
    fn detects_paste_ready_enable_and_disable() {
        let mut detector = CsiModeDetector::new();

        assert_eq!(
            scan(&mut detector, b"\x1b[?2004h\x1b[?2004l"),
            [
                CsiModeSignal::PasteReady(true),
                CsiModeSignal::PasteReady(false)
            ]
        );
    }

    #[test]
    fn detects_sequence_split_across_chunks() {
        let mut detector = CsiModeDetector::new();

        assert!(scan(&mut detector, b"prefix\x1b[").is_empty());
        assert!(scan(&mut detector, b"?20").is_empty());
        assert_eq!(
            scan(&mut detector, b"04h suffix"),
            [CsiModeSignal::PasteReady(true)]
        );
    }

    #[test]
    fn reports_alternate_buffer_exit_for_ready_reset() {
        let mut detector = CsiModeDetector::new();

        assert_eq!(
            scan(&mut detector, b"\x1b[?2004h\x1b[?1049l"),
            [
                CsiModeSignal::PasteReady(true),
                CsiModeSignal::AlternateBufferExited
            ]
        );
    }

    #[test]
    fn ignores_unrelated_private_modes() {
        let mut detector = CsiModeDetector::new();

        assert!(scan(&mut detector, b"\x1b[?25h\x1b[?1004l").is_empty());
    }
}
