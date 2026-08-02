use super::*;
use crate::models::ManagedSessionRoot;

fn process(
    pid: u32,
    parent_pid: Option<u32>,
    name: &str,
    command: &str,
    cpu_percent: f32,
    memory_bytes: u64,
) -> ProcessSnapshot {
    ProcessSnapshot {
        pid,
        parent_pid,
        name: name.to_string(),
        command: command.to_string(),
        started_at: Some(pid as u64 * 10),
        cpu_percent,
        memory_bytes,
    }
}

fn process_started(
    pid: u32,
    parent_pid: Option<u32>,
    name: &str,
    command: &str,
    started_at: u64,
) -> ProcessSnapshot {
    let mut process = process(pid, parent_pid, name, command, 0.0, 10);
    process.started_at = Some(started_at);
    process
}

fn identities(items: &[(u32, u64)]) -> HashSet<ProcessIdentity> {
    items
        .iter()
        .map(|(pid, started_at)| ProcessIdentity {
            pid: *pid,
            started_at: *started_at,
        })
        .collect()
}

fn known_family() -> HashSet<ProcessIdentity> {
    identities(&[(10, 100), (30, 300), (39, 390), (49, 490), (59, 590)])
}

fn snapshot() -> Vec<ProcessSnapshot> {
    vec![
        process(1, None, "explorer.exe", "explorer.exe", 0.0, 1_000),
        process(10, Some(1), "cc-panes.exe", "cc-panes.exe", 1.0, 100),
        // Active session: its ConPTY ancestor must not be reported as orphaned.
        process(
            19,
            Some(10),
            "conhost.exe",
            "conhost.exe --headless",
            1.0,
            10,
        ),
        process(20, Some(19), "pwsh.exe", "pwsh.exe", 10.0, 50),
        process(21, Some(20), "codex.exe", "codex.exe", 20.0, 100),
        // Genuine residual: its previously observed CC-Panes parent (PID 30) is gone.
        process(31, Some(30), "powershell.exe", "powershell.exe", 3.0, 30),
        // Conservative exclusions under other dead family roots.
        process(40, Some(39), "node.exe", "node mcp-server.js", 4.0, 40),
        process(50, Some(49), "cmd.exe", "cmd /c npm run dev", 5.0, 50),
        process(51, Some(50), "node.exe", "node vite.js", 6.0, 60),
        process(60, Some(59), "node.exe", "node npm-cli.js install", 7.0, 70),
    ]
}

fn parent_chain_summary(index: &ProcessIndex<'_>, pid: u32) -> String {
    let mut chain = Vec::new();
    let mut visited = HashSet::new();
    let mut current = Some(pid);
    while let Some(current_pid) = current {
        if !visited.insert(current_pid) {
            chain.push(format!("cycle({current_pid})"));
            break;
        }
        let Some(process) = index.by_pid.get(&current_pid) else {
            chain.push(format!("unknown({current_pid})"));
            break;
        };
        chain.push(format!("{}({})", process.name, process.pid));
        current = process.parent_pid;
    }
    chain.join(" <- ")
}

#[test]
fn cpu_percent_uses_process_time_delta_over_wall_time() {
    assert_eq!(
        cpu_percent_since(1_000_000, 3_000_000, std::time::Duration::from_secs(1)),
        20.0
    );
    assert_eq!(
        cpu_percent_since(3_000_000, 1_000_000, std::time::Duration::from_secs(1)),
        0.0
    );
    assert_eq!(
        cpu_percent_since(1_000_000, 3_000_000, std::time::Duration::ZERO),
        0.0
    );
}

#[test]
fn multi_instance_detection_protects_live_tree_and_finds_only_dead_reused_parent_tree() {
    let processes = vec![
        process_started(10, None, "cc-panes.exe", "cc-panes.exe", 100),
        process_started(
            11,
            Some(10),
            "cc-panes-daemon.exe",
            "cc-panes-daemon.exe",
            110,
        ),
        process_started(12, Some(11), "claude.exe", "claude.exe", 120),
        // PID 20 belonged to a now-dead CC-Panes started at 200, then got reused.
        process_started(20, None, "unrelated.exe", "unrelated.exe", 400),
        process_started(21, Some(20), "OpenConsole.exe", "OpenConsole.exe", 210),
        process_started(22, Some(21), "wsl.exe", "wsl.exe", 220),
        process_started(23, Some(20), "pwsh.exe", "pwsh.exe -NoProfile", 410),
    ];
    let known_family = identities(&[(10, 100), (11, 110), (20, 200)]);
    let tree = build_resource_tree_from_snapshot(
        SystemStats {
            cpu_percent: 0.0,
            mem_used: 0,
            mem_total: 1_000,
        },
        &processes,
        &[],
        999,
        &known_family,
        0,
    );

    assert_eq!(tree.orphans.len(), 1);
    assert_eq!(tree.orphans[0].pid, 21);
    assert_eq!(tree.orphans[0].process_count, 2);
}

#[test]
fn current_reused_family_pid_does_not_claim_older_child() {
    let processes = vec![
        process_started(10, None, "cc-panes.exe", "cc-panes.exe", 400),
        process_started(22, Some(10), "OpenConsole.exe", "OpenConsole.exe", 210),
    ];
    let known_family = identities(&[(10, 200), (10, 400)]);
    let tree = build_resource_tree_from_snapshot(
        SystemStats {
            cpu_percent: 0.0,
            mem_used: 0,
            mem_total: 1_000,
        },
        &processes,
        &[],
        10,
        &known_family,
        0,
    );

    assert_eq!(tree.orphans.len(), 1);
    assert_eq!(tree.orphans[0].pid, 22);
}

#[test]
fn resource_tree_aggregates_managed_session_descendants_once() {
    let tree = build_resource_tree_from_snapshot(
        SystemStats {
            cpu_percent: 50.0,
            mem_used: 4_000,
            mem_total: 10_000,
        },
        &snapshot(),
        &[ManagedSessionRoot {
            session_id: "session-1".to_string(),
            root_pid: 20,
        }],
        10,
        &known_family(),
        250,
    );

    assert_eq!(tree.sessions.len(), 1);
    assert_eq!(tree.sessions[0].session_id, "session-1");
    assert_eq!(tree.sessions[0].root_pid, 20);
    assert_eq!(tree.sessions[0].process_count, 2);
    assert_eq!(tree.sessions[0].cpu_percent, 30.0);
    assert_eq!(tree.sessions[0].memory_bytes, 150);
    assert_eq!(tree.app_memory_bytes, 100);
    assert_eq!(tree.app_memory_percent, 1.0);
    assert_eq!(tree.elapsed_micros, 250);

    // 明细按内存降序，且加总必须等于会话聚合值——否则展开后数字对不上，
    // 用户没法判断到底该信哪个。
    let detail = &tree.sessions[0].processes;
    assert_eq!(detail.len(), 2);
    assert_eq!(detail[0].pid, 21);
    assert_eq!(detail[0].name, "codex.exe");
    assert_eq!(detail[1].pid, 20);
    assert_eq!(
        detail
            .iter()
            .map(|process| process.memory_bytes)
            .sum::<u64>(),
        tree.sessions[0].memory_bytes,
    );
    assert!(tree.sessions[0].truncated.is_none());
}

#[test]
fn session_process_detail_caps_the_list_and_reports_what_it_folded() {
    let mut processes = vec![
        process(1, None, "explorer.exe", "explorer.exe", 0.0, 1_000),
        process(10, Some(1), "cc-panes.exe", "cc-panes.exe", 1.0, 100),
        process(20, Some(10), "pwsh.exe", "pwsh.exe", 0.0, 10_000),
    ];
    // 30 个 rustc 挂在会话根下，超过 SESSION_PROCESS_DETAIL_LIMIT (24)。
    let rustc_count = 30u32;
    for offset in 0..rustc_count {
        processes.push(process(
            100 + offset,
            Some(20),
            "rustc.exe",
            "rustc --crate-name x",
            1.0,
            u64::from(offset) + 1,
        ));
    }

    let tree = build_resource_tree_from_snapshot(
        SystemStats {
            cpu_percent: 0.0,
            mem_used: 0,
            mem_total: 1_000,
        },
        &processes,
        &[ManagedSessionRoot {
            session_id: "session-1".to_string(),
            root_pid: 20,
        }],
        10,
        &identities(&[(10, 100)]),
        0,
    );

    let session = &tree.sessions[0];
    assert_eq!(session.process_count, rustc_count + 1);
    assert_eq!(session.processes.len(), SESSION_PROCESS_DETAIL_LIMIT);

    // 截断绝不能静默：折叠掉的条数与用量必须回传，否则 UI 上"前 24 条"和"一共 24 条"同形。
    let truncated = session
        .truncated
        .as_ref()
        .expect("folded remainder reported");
    assert_eq!(
        session.processes.len() as u32 + truncated.process_count,
        session.process_count,
    );
    let detail_memory = session
        .processes
        .iter()
        .map(|process| process.memory_bytes)
        .sum::<u64>();
    assert_eq!(detail_memory + truncated.memory_bytes, session.memory_bytes);
}

#[test]
fn session_process_detail_truncates_command_on_char_boundaries() {
    // 路径含中文时按字节截断会 panic；这里用中文命令行确认走的是字符边界。
    let long_command = "启动".repeat(SESSION_PROCESS_COMMAND_LIMIT);
    let truncated = truncate_command(&long_command);

    assert_eq!(
        truncated.chars().count(),
        SESSION_PROCESS_COMMAND_LIMIT + 1,
        "截断后应为上限长度加一个省略号",
    );
    assert!(truncated.ends_with('…'));
    assert_eq!(truncate_command("short"), "short");
}

#[test]
fn orphan_detection_excludes_active_conpty_family_and_whitelisted_branches() {
    let tree = build_resource_tree_from_snapshot(
        SystemStats {
            cpu_percent: 0.0,
            mem_used: 0,
            mem_total: 1_000,
        },
        &snapshot(),
        &[ManagedSessionRoot {
            session_id: "session-1".to_string(),
            root_pid: 20,
        }],
        10,
        &known_family(),
        0,
    );

    let orphan = tree.orphans.first().expect("one conservative orphan root");
    assert_eq!(tree.orphans.len(), 1);
    assert_eq!(orphan.pid, 31);
    assert_eq!(orphan.process_count, 1);
    assert_eq!(orphan.cpu_percent, 3.0);
    assert_eq!(orphan.memory_bytes, 30);
}

#[test]
fn kill_guard_rejects_self_managed_unknown_and_reports_partial_failure() {
    let sessions = [ManagedSessionRoot {
        session_id: "session-1".to_string(),
        root_pid: 20,
    }];
    let results = kill_orphans_from_snapshot(
        &snapshot(),
        &sessions,
        &[10, 20, 31, 999],
        10,
        &known_family(),
        |pid| {
            if pid == 31 {
                Err("simulated taskkill failure".to_string())
            } else {
                Ok(())
            }
        },
    );

    assert_eq!(results.len(), 4);
    assert!(!results[0].success);
    assert!(results[0].error.as_deref().unwrap().contains("protected"));
    assert!(!results[1].success);
    assert!(results[1]
        .error
        .as_deref()
        .unwrap()
        .contains("managed session"));
    assert!(!results[2].success);
    assert_eq!(
        results[2].error.as_deref(),
        Some("simulated taskkill failure")
    );
    assert!(!results[3].success);
    assert!(results[3]
        .error
        .as_deref()
        .unwrap()
        .contains("current orphan"));
}

// Environment-dependent live diagnostic. Run manually with:
// cargo test -p cc-panes-core live_resource_tree_enumeration_stays_within_budget -- --ignored --nocapture
#[test]
#[ignore = "live environment diagnostic; run manually with --ignored --nocapture"]
fn live_resource_tree_enumeration_stays_within_budget() {
    let service = SystemStatsService::new();
    let tree = service.get_resource_tree(&[]);
    println!(
        "resource tree enumeration: {} us ({} sessions, {} orphans)",
        tree.elapsed_micros,
        tree.sessions.len(),
        tree.orphans.len()
    );
    let mut topology_system = System::new();
    let topology = capture_process_topology(&mut topology_system);
    let index = ProcessIndex::new(&topology);
    for orphan in &tree.orphans {
        println!(
            "orphan: name={} pid={} parent_chain={}",
            orphan.name,
            orphan.pid,
            parent_chain_summary(&index, orphan.pid)
        );
    }
    assert!(
        tree.app_memory_bytes > 0,
        "self process resources were not refreshed"
    );
    assert!(
        tree.elapsed_micros < 100_000,
        "resource tree enumeration exceeded 100ms budget: {} us",
        tree.elapsed_micros
    );
}
