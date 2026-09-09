//! JavaScript boundary only. The daemon and disk continue to use exact u64 values.
use cc_panes_core::models::{TerminalBufferMode, TerminalCheckpoint, TerminalRecoverySnapshot};
use serde::{Deserialize, Serialize};

mod epoch {
    use serde::{de::Error, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Input {
            Text(String),
            Legacy(u64),
        }
        match Input::deserialize(deserializer)? {
            Input::Legacy(value) if value <= 9_007_199_254_740_991 => Ok(value),
            Input::Text(value)
                if !value.is_empty()
                    && value.len() <= 20
                    && value.bytes().all(|b| b.is_ascii_digit())
                    && (value == "0" || !value.starts_with('0')) =>
            {
                value.parse().map_err(D::Error::custom)
            }
            _ => Err(D::Error::custom(
                "checkpoint epoch must be an exact decimal string",
            )),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDto {
    #[serde(with = "epoch")]
    pub checkpoint_epoch: u64,
    pub anchor_seq: u64,
    pub snapshot_ansi: String,
    pub buffer_mode: TerminalBufferMode,
    pub cols: u16,
    pub rows: u16,
    pub checkpointed_at_ms: u64,
}

impl From<TerminalCheckpoint> for CheckpointDto {
    fn from(cp: TerminalCheckpoint) -> Self {
        Self {
            checkpoint_epoch: cp.checkpoint_epoch,
            anchor_seq: cp.anchor_seq,
            snapshot_ansi: cp.snapshot_ansi,
            buffer_mode: cp.buffer_mode,
            cols: cp.cols,
            rows: cp.rows,
            checkpointed_at_ms: cp.checkpointed_at_ms,
        }
    }
}

impl From<CheckpointDto> for TerminalCheckpoint {
    fn from(cp: CheckpointDto) -> Self {
        Self {
            checkpoint_epoch: cp.checkpoint_epoch,
            anchor_seq: cp.anchor_seq,
            snapshot_ansi: cp.snapshot_ansi,
            buffer_mode: cp.buffer_mode,
            cols: cp.cols,
            rows: cp.rows,
            checkpointed_at_ms: cp.checkpointed_at_ms,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySnapshotDto {
    pub checkpoint: Option<CheckpointDto>,
    pub delta: String,
    pub buffer_mode: TerminalBufferMode,
    pub end_seq: u64,
    #[serde(with = "epoch")]
    pub checkpoint_epoch: u64,
}

impl From<TerminalRecoverySnapshot> for RecoverySnapshotDto {
    fn from(snapshot: TerminalRecoverySnapshot) -> Self {
        Self {
            checkpoint: snapshot.checkpoint.map(Into::into),
            delta: snapshot.delta,
            buffer_mode: snapshot.buffer_mode,
            end_seq: snapshot.end_seq,
            checkpoint_epoch: snapshot.checkpoint_epoch,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checkpoint(epoch: u64) -> TerminalCheckpoint {
        TerminalCheckpoint {
            checkpoint_epoch: epoch,
            anchor_seq: 17,
            snapshot_ansi: "screen".into(),
            buffer_mode: TerminalBufferMode::Normal,
            cols: 80,
            rows: 24,
            checkpointed_at_ms: 1,
        }
    }

    #[test]
    fn ipc_roundtrip_preserves_real_epochs_and_daemon_numeric_protocol() {
        for value in [0, 117232978312953918, 117232978312953919, u64::MAX] {
            let wire = serde_json::to_value(CheckpointDto::from(checkpoint(value))).unwrap();
            assert_eq!(wire["checkpointEpoch"], value.to_string());
            let returned: CheckpointDto = serde_json::from_value(wire).unwrap();
            let daemon = serde_json::to_value(TerminalCheckpoint::from(returned)).unwrap();
            assert_eq!(daemon["checkpointEpoch"].as_u64(), Some(value));
        }
    }

    #[test]
    fn rejects_rounded_numbers_and_noncanonical_decimal_values() {
        for bad in serde_json::json!([
            117232978312953920_u64,
            -1,
            1.5,
            "01",
            "-1",
            "",
            " 7",
            "18446744073709551616"
        ])
        .as_array()
        .unwrap()
        {
            let mut wire = serde_json::to_value(CheckpointDto::from(checkpoint(7))).unwrap();
            wire["checkpointEpoch"] = bad.clone();
            assert!(
                serde_json::from_value::<CheckpointDto>(wire).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn recovery_stringifies_both_epoch_fields() {
        let cp = checkpoint(117232978312953918);
        let snapshot = RecoverySnapshotDto::from(TerminalRecoverySnapshot {
            checkpoint_epoch: cp.checkpoint_epoch,
            checkpoint: Some(cp),
            delta: String::new(),
            buffer_mode: TerminalBufferMode::Normal,
            end_seq: 17,
        });
        let wire = serde_json::to_value(snapshot).unwrap();
        assert_eq!(wire["checkpointEpoch"], "117232978312953918");
        assert_eq!(
            wire["checkpoint"]["checkpointEpoch"],
            wire["checkpointEpoch"]
        );
    }
}
