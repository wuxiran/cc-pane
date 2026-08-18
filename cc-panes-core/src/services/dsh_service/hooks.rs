//! 生成给 `dsh-hooks-claude-code` 桥读的 `hooks.json`
//!
//! dsh 官方带了一个 Claude Code 方言桥，能跑 CC 形状的 `hooks.json`。
//! 我们因此不用为 dsh 另写一套 hook 协议，直接生成 CC 形状即可。
//!
//! **但桥只覆盖 7 个事件**，我们的 11 个 HookDef 里有 5 个落在覆盖面之外。
//! 桥对不认识的事件是「解析后跳过 + warning」，不会崩，但也不会跑——
//! 所以这里显式只生成能过桥的那几个，不把注定不执行的条目写进文件：
//! 一个永远不触发的 hook 躺在配置里，比它不存在更难排查。
//!
//! 掉队的 5 个（PreCompact / Notification / StopFailure / SessionEnd /
//! PermissionRequest）全是状态机驱动那批。对 dsh 影响有限：它跑在浏览器窗格里，
//! 本来就不进我们的终端状态机（没有 PTY、没有 OSC 通道）。

use cc_cli_adapters::{build_guarded_hook_command, HookCommandShell};
use std::path::Path;

/// 一条要写进 hooks.json 的 hook。
struct BridgedHook {
    /// Claude Code 事件名
    event: &'static str,
    /// 事件的 matcher（空串表示不限）
    matcher: &'static str,
    /// hook 二进制的子命令
    subcommand: &'static str,
    timeout: u32,
}

/// `dsh-hooks-claude-code` 桥支持的事件 → 我们对应的 hook。
///
/// 与 `cc-cli-adapters` 的 `HOOK_DEFS` 是**有意的子集关系**而非重复定义：
/// 那张表是「我们有哪些 hook」，这张是「哪些能过 dsh 的桥」。桥的覆盖面由
/// dsh 决定，它加了新事件我们才能加行——所以这张表跟着桥走，不跟着我们走。
const BRIDGED_HOOKS: &[BridgedHook] = &[
    BridgedHook {
        event: "SessionStart",
        matcher: "startup",
        subcommand: "session-init",
        timeout: 10,
    },
    BridgedHook {
        event: "SessionStart",
        // 桥的 SessionStart matcher 主体是 session source。compact 在
        // dsh 侧未必存在，留着无害（匹配不上就是不触发）。
        matcher: "resume|compact",
        subcommand: "session-resume",
        timeout: 10,
    },
    BridgedHook {
        event: "UserPromptSubmit",
        matcher: "",
        subcommand: "prompt-before",
        timeout: 10,
    },
    BridgedHook {
        event: "PreToolUse",
        matcher: "",
        subcommand: "tool-before",
        timeout: 60,
    },
    BridgedHook {
        event: "PostToolUse",
        matcher: "",
        subcommand: "tool-after",
        timeout: 5,
    },
    BridgedHook {
        event: "Stop",
        matcher: "",
        subcommand: "turn-end",
        timeout: 10,
    },
];

/// 生成 hooks.json 内容。
///
/// 形状与我们写给 Claude 的 `settings.local.json` 的 `hooks` 段一致：
/// `{ "<Event>": [ { "matcher": ..., "hooks": [ {type, command, timeout} ] } ] }`。
/// 桥只跑 `type: "command"` 的 shell hook，其余类型它会跳过。
pub(super) fn build_hooks_json(hook_binary: &Path) -> String {
    let shell = if cfg!(windows) {
        HookCommandShell::Windows
    } else {
        HookCommandShell::Posix
    };

    let mut events: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    for hook in BRIDGED_HOOKS {
        let command = build_guarded_hook_command(hook_binary, hook.subcommand, shell);
        let mut entry = serde_json::Map::new();
        if !hook.matcher.is_empty() {
            entry.insert("matcher".into(), hook.matcher.into());
        }
        entry.insert(
            "hooks".into(),
            serde_json::json!([{
                "type": "command",
                "command": command,
                "timeout": hook.timeout,
            }]),
        );
        events
            .entry(hook.event.to_string())
            .or_insert_with(|| serde_json::Value::Array(Vec::new()))
            .as_array_mut()
            .expect("event value is always an array")
            .push(serde_json::Value::Object(entry));
    }

    serde_json::json!({ "hooks": events }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn parsed() -> serde_json::Value {
        let binary = PathBuf::from("D:/bin/cc-panes-cli-hook.exe");
        serde_json::from_str(&build_hooks_json(&binary)).unwrap()
    }

    #[test]
    fn only_bridge_supported_events_are_emitted() {
        // 桥的事件覆盖面就是这 6 条。多写的会被 warning 跳过——
        // 一个永远不触发的 hook 躺在配置里比它不存在更难排查。
        let hooks = parsed();
        let events: Vec<&String> = hooks["hooks"].as_object().unwrap().keys().collect();
        let mut sorted = events.clone();
        sorted.sort();
        assert_eq!(
            sorted,
            vec![
                "PostToolUse",
                "PreToolUse",
                "SessionStart",
                "Stop",
                "UserPromptSubmit"
            ]
        );
    }

    #[test]
    fn unsupported_events_never_appear() {
        // 这 5 个不在桥的映射表里。若哪天 dsh 加了支持，是往
        // BRIDGED_HOOKS 里加行，而不是让它们悄悄漏进来。
        let text = build_hooks_json(&PathBuf::from("/bin/hook"));
        for event in [
            "PreCompact",
            "Notification",
            "StopFailure",
            "SessionEnd",
            "PermissionRequest",
        ] {
            assert!(!text.contains(event), "{event} should not be emitted");
        }
    }

    #[test]
    fn session_start_carries_both_matchers() {
        let hooks = parsed();
        let entries = hooks["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["matcher"], "startup");
        assert_eq!(entries[1]["matcher"], "resume|compact");
    }

    #[test]
    fn matcherless_events_omit_the_key() {
        let hooks = parsed();
        let entry = &hooks["hooks"]["Stop"][0];
        assert!(entry.get("matcher").is_none());
    }

    #[test]
    fn commands_are_guarded_so_a_missing_binary_is_not_an_error() {
        // 守卫是共享实现（cc-cli-adapters），这里断言我们确实用了它：
        // 没有守卫时二进制缺失会让每个 hook 都报错刷屏。
        let hooks = parsed();
        let command = hooks["hooks"]["Stop"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        if cfg!(windows) {
            assert!(command.starts_with("if exist "), "{command}");
        } else {
            assert!(command.starts_with("if [ -x "), "{command}");
        }
        assert!(command.contains("turn-end"));
    }

    #[test]
    fn every_hook_declares_command_type_and_timeout() {
        let hooks = parsed();
        for (event, entries) in hooks["hooks"].as_object().unwrap() {
            for entry in entries.as_array().unwrap() {
                let hook = &entry["hooks"][0];
                assert_eq!(hook["type"], "command", "{event}");
                assert!(hook["timeout"].as_u64().unwrap() > 0, "{event}");
            }
        }
    }
}
