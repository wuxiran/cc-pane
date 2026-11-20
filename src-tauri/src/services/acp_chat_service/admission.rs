//! 回合接纳时的两个附加动作：按 chat 的隐藏前言与外部提交的公告事件。
//!
//! 两者都必须发生在「这条 prompt 确实被接纳」的同一临界区里：
//! - 前言（Bot 人设）只在接纳后才算用掉；被拒绝（回合进行中 / 未就绪 /
//!   记录失败）时原样放回，不会丢；
//! - 公告（`external_prompt`，界面据此画出「来自 IM」的用户气泡）在占到回合
//!   之后、请求发出之前广播，界面先看到气泡再看到回复，被拒绝时也不会留下
//!   幽灵气泡。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

/// 外部提交在被接纳时广播的事件（仅实时，不进 journal）。
#[derive(Debug, Clone)]
pub struct PromptAnnouncement {
    pub kind: String,
    pub payload: Value,
}

/// chatId → 下一条 prompt 的隐藏前言（ACP 没有 system prompt 字段）。
#[derive(Default)]
pub(crate) struct Preambles {
    map: Mutex<HashMap<String, String>>,
}

impl Preambles {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.map
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn set(&self, chat_id: &str, preamble: Option<String>) {
        let mut map = self.lock();
        match preamble.filter(|text| !text.trim().is_empty()) {
            Some(text) => {
                map.insert(chat_id.trim().to_string(), text);
            }
            None => {
                map.remove(chat_id.trim());
            }
        }
    }

    fn take(&self, chat_id: &str) -> Option<String> {
        self.lock().remove(chat_id.trim())
    }

    /// 放回：期间若已被重新设置（例如开了新线程），以新的为准。
    fn restore(&self, chat_id: &str, preamble: String) {
        self.lock()
            .entry(chat_id.trim().to_string())
            .or_insert(preamble);
    }

    #[cfg(test)]
    pub(crate) fn peek(&self, chat_id: &str) -> Option<String> {
        self.lock().get(chat_id.trim()).cloned()
    }
}

/// 把前言并进第一个 text block；没有 text block（纯图片 / 资源链接）时在最前面
/// 插一个，保证前言不会被静默跳过。
pub(crate) fn prepend_preamble(preamble: &str, blocks: &mut Vec<Value>) {
    if let Some(block) = blocks
        .iter_mut()
        .find(|block| block.get("type").and_then(Value::as_str) == Some("text"))
    {
        let text = block
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default();
        block["text"] = Value::String(format!("{preamble}\n\n---\n\n{text}"));
    } else {
        blocks.insert(0, json!({"type": "text", "text": preamble}));
    }
}

/// 一次接纳尝试。`apply` 取出前言并入 blocks；没 `commit` 就 drop（任何提前
/// 返回的错误路径）时前言自动放回。
pub(crate) struct Admission {
    preambles: Arc<Preambles>,
    chat_id: String,
    announce: Option<PromptAnnouncement>,
    taken: Option<String>,
}

impl Admission {
    pub(crate) fn new(
        preambles: Arc<Preambles>,
        chat_id: &str,
        announce: Option<PromptAnnouncement>,
    ) -> Self {
        Self {
            preambles,
            chat_id: chat_id.trim().to_string(),
            announce,
            taken: None,
        }
    }

    /// 已占到回合之后调用。
    pub(crate) fn apply(&mut self, blocks: &mut Vec<Value>) {
        if let Some(preamble) = self.preambles.take(&self.chat_id) {
            prepend_preamble(&preamble, blocks);
            self.taken = Some(preamble);
        }
    }

    /// 取走公告（请求发出前广播）。
    pub(crate) fn take_announcement(&mut self) -> Option<PromptAnnouncement> {
        self.announce.take()
    }

    /// prompt 已交给 agent：前言正式用掉。
    pub(crate) fn commit(mut self) {
        self.taken = None;
    }
}

impl Drop for Admission {
    fn drop(&mut self) {
        if let Some(preamble) = self.taken.take() {
            self.preambles.restore(&self.chat_id, preamble);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preamble_merges_into_first_text_block() {
        let mut blocks = vec![
            json!({"type": "image", "data": "x"}),
            json!({"type": "text", "text": "hi"}),
        ];
        prepend_preamble("P", &mut blocks);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[1]["text"], "P\n\n---\n\nhi");
    }

    #[test]
    fn preamble_gets_its_own_block_without_text() {
        let mut blocks = vec![json!({"type": "image", "data": "x"})];
        prepend_preamble("P", &mut blocks);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0], json!({"type": "text", "text": "P"}));
    }

    #[test]
    fn rejected_admission_puts_the_preamble_back() {
        let store = Arc::new(Preambles::default());
        store.set("c", Some("persona".into()));
        {
            let mut admission = Admission::new(store.clone(), "c", None);
            let mut blocks = vec![json!({"type": "text", "text": "hi"})];
            admission.apply(&mut blocks);
            assert!(blocks[0]["text"].as_str().unwrap().starts_with("persona"));
            assert!(store.peek("c").is_none());
            // dropped without commit: rejected
        }
        assert_eq!(store.peek("c").as_deref(), Some("persona"));
    }

    #[test]
    fn committed_admission_consumes_the_preamble() {
        let store = Arc::new(Preambles::default());
        store.set("c", Some("persona".into()));
        let mut admission = Admission::new(store.clone(), "c", None);
        let mut blocks = vec![json!({"type": "text", "text": "hi"})];
        admission.apply(&mut blocks);
        admission.commit();
        assert!(store.peek("c").is_none());
    }

    #[test]
    fn restore_does_not_override_a_newer_preamble() {
        let store = Arc::new(Preambles::default());
        store.set("c", Some("old".into()));
        let mut admission = Admission::new(store.clone(), "c", None);
        admission.apply(&mut vec![json!({"type": "text", "text": "hi"})]);
        store.set("c", Some("new".into()));
        drop(admission);
        assert_eq!(store.peek("c").as_deref(), Some("new"));
    }
}
