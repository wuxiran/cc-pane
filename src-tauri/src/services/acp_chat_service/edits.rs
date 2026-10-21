//! Only complete, observed ACP edits can be undone; frontend text is not authority.
use super::{AcpChatPhase, AcpChatService};
use crate::utils::{AppError, AppResult};
use cc_panes_core::services::agent_edit_service::{undo_agent_text_edit, MAX_AGENT_EDIT_BYTES};
use serde::Deserialize;
use serde_json::Value;
use std::collections::VecDeque;

const MAX_CALLS: usize = 64;
const MAX_CACHE_BYTES: usize = 8 * 1024 * 1024;

/// A required JSON value: explicit null means a new file; omitted text is invalid.
#[derive(Clone, Deserialize)]
#[serde(untagged)]
pub enum OriginalText {
    Text(String),
    Absent(()),
}

impl OriginalText {
    fn as_deref(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text),
            Self::Absent(()) => None,
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoAcpFileEdit {
    pub acp_session_id: String,
    pub tool_call_id: String,
    pub path: String,
    pub old_text: OriginalText,
    pub new_text: String,
}

#[derive(Clone)]
struct Edit {
    path: String,
    before: Option<String>,
    after: String,
    undone: bool,
}

#[derive(Default)]
struct Call {
    id: String,
    completed: bool,
    edits: Vec<Edit>,
}

#[derive(Default)]
pub(super) struct ObservedEdits(VecDeque<Call>);

impl ObservedEdits {
    pub(super) fn remember(&mut self, params: &Value) {
        let Some(update) = params.get("update") else {
            return;
        };
        if !matches!(
            update.get("sessionUpdate").and_then(Value::as_str),
            Some("tool_call" | "tool_call_update")
        ) {
            return;
        }
        let Some(id) = update
            .get("toolCallId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 1024)
        else {
            return;
        };
        let index = self.0.iter().position(|call| call.id == id);
        let mut call = index
            .and_then(|index| self.0.remove(index))
            .unwrap_or_else(|| Call {
                id: id.into(),
                ..Default::default()
            });
        if let Some(status) = update.get("status").and_then(Value::as_str) {
            call.completed = status == "completed";
        }
        if let Some(content) = update.get("content") {
            let previous = std::mem::take(&mut call.edits);
            call.edits = parse_edits(content);
            for edit in &mut call.edits {
                edit.undone = previous.iter().any(|old| {
                    old.undone
                        && old.path == edit.path
                        && old.before == edit.before
                        && old.after == edit.after
                });
            }
        }
        self.0.push_back(call);
        while self.0.len() > MAX_CALLS || self.bytes() > MAX_CACHE_BYTES {
            self.0.pop_front();
        }
    }

    fn bytes(&self) -> usize {
        self.0
            .iter()
            .flat_map(|call| &call.edits)
            .map(|edit| {
                edit.before.as_ref().map_or(0, String::len) + edit.after.len() + edit.path.len()
            })
            .sum()
    }

    fn matching_edit(&mut self, request: &UndoAcpFileEdit) -> Option<&mut Edit> {
        let call = self
            .0
            .iter_mut()
            .find(|call| call.id == request.tool_call_id && call.completed)?;
        let mut matches = call
            .edits
            .iter_mut()
            .filter(|edit| edit.path == request.path);
        let edit = matches.next()?;
        if matches.next().is_some()
            || edit.undone
            || edit.before.as_deref() != request.old_text.as_deref()
            || edit.after != request.new_text
        {
            return None;
        }
        Some(edit)
    }
}

fn parse_edits(content: &Value) -> Vec<Edit> {
    let Some(blocks) = content.as_array().filter(|blocks| blocks.len() <= 16) else {
        return vec![];
    };
    blocks
        .iter()
        .filter_map(|block| {
            if block.get("type").and_then(Value::as_str) != Some("diff") {
                return None;
            }
            let path = block.get("path")?.as_str()?;
            let before = match block.get("oldText")? {
                Value::Null => None,
                Value::String(text) => Some(text.as_str()),
                _ => return None,
            };
            let after = block.get("newText")?.as_str()?;
            if path.is_empty()
                || path.len() > 4096
                || before.is_some_and(|text| text.len() > MAX_AGENT_EDIT_BYTES)
                || after.len() > MAX_AGENT_EDIT_BYTES
                || before == Some(after)
                || before.is_some_and(|text| text.contains('\0'))
                || after.contains('\0')
            {
                return None;
            }
            Some(Edit {
                path: path.into(),
                before: before.map(str::to_owned),
                after: after.into(),
                undone: false,
            })
        })
        .collect()
}

impl AcpChatService {
    pub async fn undo_file_edit(&self, chat_id: &str, request: UndoAcpFileEdit) -> AppResult<()> {
        let session = self.session(chat_id).await?;
        // Serialize with prompt admission, so this chat cannot resume writing during undo.
        let _turn = session.turn_control.lock().await;
        let snapshot = session.snapshot.read().await;
        if snapshot.phase != AcpChatPhase::Ready
            || snapshot.acp_session_id.as_deref() != Some(request.acp_session_id.as_str())
        {
            return Err(AppError::coded(
                "ACP_EDIT_BUSY",
                "Wait for this conversation to finish before undoing an edit",
            ));
        }
        drop(snapshot);
        if session
            .edits
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .matching_edit(&request)
            .is_none()
        {
            return Err(AppError::coded(
                "ACP_EDIT_UNAVAILABLE",
                "This complete edit is unavailable or has already been undone",
            ));
        }
        let root = session.cwd.clone();
        let edit = request.clone();
        tokio::task::spawn_blocking(move || {
            undo_agent_text_edit(&root, &edit.path, edit.old_text.as_deref(), &edit.new_text)
        })
        .await
        .map_err(|error| AppError::from(format!("Undo task failed: {error}")))??;
        if let Some(edit) = session
            .edits
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .matching_edit(&request)
        {
            edit.undone = true;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> UndoAcpFileEdit {
        UndoAcpFileEdit {
            acp_session_id: "session".into(),
            tool_call_id: "tool".into(),
            path: "file".into(),
            old_text: OriginalText::Text("before".into()),
            new_text: "after".into(),
        }
    }
    fn update(status: &str) -> Value {
        json!({"update":{"sessionUpdate":"tool_call","toolCallId":"tool","status":status,"content":[{"type":"diff","path":"file","oldText":"before","newText":"after"}]}})
    }

    #[test]
    fn requires_observed_completed_matching_content_and_disallows_duplicate_undo() {
        let mut edits = ObservedEdits::default();
        for status in ["pending", "in_progress", "failed"] {
            edits.remember(&update(status));
            assert!(edits.matching_edit(&request()).is_none());
        }
        edits.remember(&update("completed"));
        let mut wrong = request();
        wrong.old_text = OriginalText::Text("invented".into());
        assert!(edits.matching_edit(&wrong).is_none());
        edits.matching_edit(&request()).unwrap().undone = true;
        edits.remember(&update("completed"));
        assert!(edits.matching_edit(&request()).is_none());
    }

    #[test]
    fn merges_status_updates_but_rejects_missing_original_and_duplicate_paths() {
        let mut edits = ObservedEdits::default();
        edits.remember(&update("in_progress"));
        edits.remember(&json!({"update":{"sessionUpdate":"tool_call_update","toolCallId":"tool","status":"completed"}}));
        assert!(edits.matching_edit(&request()).is_some());
        let mut invalid = update("completed");
        invalid["update"]["content"][0]
            .as_object_mut()
            .unwrap()
            .remove("oldText");
        edits.remember(&invalid);
        assert!(edits.matching_edit(&request()).is_none());
        let mut duplicate = update("completed");
        let block = duplicate["update"]["content"][0].clone();
        duplicate["update"]["content"]
            .as_array_mut()
            .unwrap()
            .push(block);
        edits.remember(&duplicate);
        assert!(edits.matching_edit(&request()).is_none());
    }

    #[test]
    fn bounds_retained_tool_calls() {
        let mut edits = ObservedEdits::default();
        edits.remember(&update("completed"));
        for id in 0..MAX_CALLS {
            edits.remember(
                &json!({"update":{"sessionUpdate":"tool_call","toolCallId":id.to_string()}}),
            );
        }
        assert_eq!(edits.0.len(), MAX_CALLS);
        assert!(edits.matching_edit(&request()).is_none());
    }

    #[test]
    fn accepts_explicit_new_file_but_not_missing_original_or_forged_empty_original() {
        let mut edits = ObservedEdits::default();
        let mut created = update("completed");
        created["update"]["content"][0]["oldText"] = Value::Null;
        edits.remember(&created);
        let mut request = request();
        request.old_text = OriginalText::Absent(());
        assert!(edits.matching_edit(&request).is_some());
        request.old_text = OriginalText::Text(String::new());
        assert!(edits.matching_edit(&request).is_none());
        created["update"]["content"][0]
            .as_object_mut()
            .unwrap()
            .remove("oldText");
        edits.remember(&created);
        request.old_text = OriginalText::Absent(());
        assert!(edits.matching_edit(&request).is_none());
        let mut wire = json!({"acpSessionId":"session","toolCallId":"tool","path":"file","oldText":null,"newText":"after"});
        assert!(serde_json::from_value::<UndoAcpFileEdit>(wire.clone()).is_ok());
        wire.as_object_mut().unwrap().remove("oldText");
        assert!(serde_json::from_value::<UndoAcpFileEdit>(wire).is_err());
    }
}
