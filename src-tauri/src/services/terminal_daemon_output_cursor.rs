//! Track raw byte coordinates across rolling snapshots and reconnected streams.
//! Comparing whole snapshot prefixes mistakes normal front eviction for a gap.

#[derive(Debug, Default)]
pub(super) struct OutputCursor {
    epoch: Option<u64>,
    end_seq: Option<u64>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum CursorDelta {
    Unchanged,
    Data(String),
    Resync,
}

impl OutputCursor {
    pub(super) fn recovery(&mut self, epoch: u64, end_seq: u64, data: &str) -> CursorDelta {
        let epoch_changed = self.epoch.is_some_and(|previous| previous != epoch);
        self.epoch = Some(epoch);
        if epoch_changed || self.end_seq.is_none() {
            self.end_seq = Some(end_seq);
            return CursorDelta::Resync;
        }
        // A recovery snapshot is authoritative; unlike a queued WS frame, a
        // backwards coordinate means the stream was reset and needs recovery.
        if self.end_seq.is_some_and(|previous| end_seq < previous) {
            self.end_seq = Some(end_seq);
            return CursorDelta::Resync;
        }
        self.stream(end_seq, data)
    }

    pub(super) fn stream(&mut self, end_seq: u64, data: &str) -> CursorDelta {
        let previous = self.end_seq;
        if previous.is_some_and(|previous| end_seq <= previous) {
            return CursorDelta::Unchanged;
        }
        self.end_seq = Some(end_seq);
        let Some(start_seq) = end_seq.checked_sub(data.len() as u64) else {
            return CursorDelta::Resync;
        };
        let Some(previous) = previous else {
            return CursorDelta::Data(data.to_owned());
        };
        let Some(offset) = previous.checked_sub(start_seq) else {
            return CursorDelta::Resync;
        };
        match usize::try_from(offset)
            .ok()
            .and_then(|offset| data.get(offset..))
        {
            Some("") => CursorDelta::Unchanged,
            Some(delta) => CursorDelta::Data(delta.to_owned()),
            None => CursorDelta::Resync,
        }
    }

    pub(super) fn reset(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rolling_window_emits_only_new_bytes_instead_of_replaying_history() {
        let mut cursor = OutputCursor::default();
        assert_eq!(cursor.recovery(1, 6, "abcdef"), CursorDelta::Resync);
        for (end, window, new) in [
            (8, "cdefgh", "gh"),
            (10, "efghij", "ij"),
            (12, "ghijkl", "kl"),
        ] {
            assert_eq!(
                cursor.recovery(1, end, window),
                CursorDelta::Data(new.into())
            );
        }
        assert_eq!(cursor.recovery(1, 12, "ghijkl"), CursorDelta::Unchanged);
    }

    #[test]
    fn reconnect_skips_queued_output_already_delivered_by_polling() {
        let mut cursor = OutputCursor::default();
        assert_eq!(
            cursor.stream(6, "abcdef"),
            CursorDelta::Data("abcdef".into())
        );
        assert_eq!(
            cursor.recovery(1, 10, "efghij"),
            CursorDelta::Data("ghij".into())
        );
        assert_eq!(cursor.stream(8, "gh"), CursorDelta::Unchanged);
        assert_eq!(cursor.stream(10, "ij"), CursorDelta::Unchanged);
        assert_eq!(cursor.stream(12, "ijkl"), CursorDelta::Data("kl".into()));
    }

    #[test]
    fn announced_desync_does_not_trigger_another_replay_on_the_next_frame() {
        let mut cursor = OutputCursor::default();
        cursor.stream(6, "abcdef");
        cursor.reset(); // daemon desync is already forwarded to all views
        assert_eq!(cursor.stream(100, "new"), CursorDelta::Data("new".into()));
        assert_eq!(cursor.stream(104, "tail"), CursorDelta::Data("tail".into()));
    }

    #[test]
    fn actual_byte_gap_recovers_once_then_resumes_incremental_output() {
        let mut cursor = OutputCursor::default();
        cursor.recovery(1, 6, "abcdef");
        assert_eq!(cursor.recovery(1, 20, "opqrst"), CursorDelta::Resync);
        assert_eq!(cursor.recovery(1, 20, "opqrst"), CursorDelta::Unchanged);
        assert_eq!(
            cursor.recovery(1, 22, "qrstuv"),
            CursorDelta::Data("uv".into())
        );
    }

    #[test]
    fn checkpoint_rebase_and_utf8_use_byte_coordinates() {
        let mut cursor = OutputCursor::default();
        cursor.recovery(1, 6, "中文");
        assert_eq!(cursor.recovery(1, 10, "🙂"), CursorDelta::Data("🙂".into()));
        assert_eq!(cursor.recovery(1, 10, ""), CursorDelta::Unchanged);
        assert_eq!(cursor.recovery(1, 13, "好"), CursorDelta::Data("好".into()));
    }

    #[test]
    fn changed_epoch_or_backwards_snapshot_requires_resync() {
        let mut cursor = OutputCursor::default();
        cursor.recovery(1, 6, "abcdef");
        assert_eq!(cursor.recovery(2, 9, "new epoch"), CursorDelta::Resync);
        assert_eq!(cursor.recovery(2, 3, "new"), CursorDelta::Resync);
        assert_eq!(cursor.recovery(2, 3, "new"), CursorDelta::Unchanged);
    }

    #[test]
    fn invalid_byte_boundary_does_not_panic_or_emit_broken_unicode() {
        let mut cursor = OutputCursor::default();
        cursor.stream(1, "x");
        assert_eq!(cursor.stream(3, "中"), CursorDelta::Resync);
        cursor.reset();
        assert_eq!(cursor.stream(1, "中文"), CursorDelta::Resync);
    }
}
