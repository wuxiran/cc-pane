#!/usr/bin/env python3
"""
Multi-Agent Pipeline Context Injection Hook for CC-Panes

Trigger: PreToolUse (before Task tool call)

Injects context from .trellis/ spec files and task-specific files
into subagent prompts (implement, check, debug, research).

Adapted from Trellis reference implementation for CC-Panes project.
- Commands path: .claude/commands/ccbook/ (not trellis/)
- Spec path: .trellis/spec/
- Added tauri-specific context for cross-layer checks
"""

import json
import os
import sys
from pathlib import Path

DIR_WORKFLOW = ".trellis"
DIR_SPEC = "spec"
FILE_CURRENT_TASK = ".current-task"
FILE_TASK_JSON = "task.json"

AGENT_IMPLEMENT = "implement"
AGENT_CHECK = "check"
AGENT_DEBUG = "debug"
AGENT_RESEARCH = "research"

AGENTS_REQUIRE_TASK = (AGENT_IMPLEMENT, AGENT_CHECK, AGENT_DEBUG)
AGENTS_ALL = (AGENT_IMPLEMENT, AGENT_CHECK, AGENT_DEBUG, AGENT_RESEARCH)
AGENTS_NO_PHASE_UPDATE = {"debug", "research"}


def find_repo_root(start_path: str) -> str | None:
    current = Path(start_path).resolve()
    while current != current.parent:
        if (current / ".git").exists():
            return str(current)
        current = current.parent
    return None


def get_current_task(repo_root: str) -> str | None:
    current_task_file = os.path.join(repo_root, DIR_WORKFLOW, FILE_CURRENT_TASK)
    if not os.path.exists(current_task_file):
        return None
    try:
        with open(current_task_file, "r", encoding="utf-8") as f:
            content = f.read().strip()
            return content if content else None
    except Exception:
        return None


def update_current_phase(repo_root: str, task_dir: str, subagent_type: str) -> None:
    if subagent_type in AGENTS_NO_PHASE_UPDATE:
        return
    task_json_path = os.path.join(repo_root, task_dir, FILE_TASK_JSON)
    if not os.path.exists(task_json_path):
        return
    try:
        with open(task_json_path, "r", encoding="utf-8") as f:
            task_data = json.load(f)
        current_phase = task_data.get("current_phase", 0)
        next_actions = task_data.get("next_action", [])
        action_to_agent = {"implement": "implement", "check": "check", "finish": "check"}
        new_phase = None
        for action in next_actions:
            phase_num = action.get("phase", 0)
            action_name = action.get("action", "")
            expected_agent = action_to_agent.get(action_name)
            if phase_num > current_phase and expected_agent == subagent_type:
                new_phase = phase_num
                break
        if new_phase is not None:
            task_data["current_phase"] = new_phase
            with open(task_json_path, "w", encoding="utf-8") as f:
                json.dump(task_data, f, indent=2, ensure_ascii=False)
    except Exception:
        pass


def read_file_content(base_path: str, file_path: str) -> str | None:
    full_path = os.path.join(base_path, file_path)
    if os.path.exists(full_path) and os.path.isfile(full_path):
        try:
            with open(full_path, "r", encoding="utf-8") as f:
                return f.read()
        except Exception:
            return None
    return None


def read_jsonl_entries(base_path: str, jsonl_path: str) -> list[tuple[str, str]]:
    full_path = os.path.join(base_path, jsonl_path)
    if not os.path.exists(full_path):
        return []
    results = []
    try:
        with open(full_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                    file_path = item.get("file") or item.get("path")
                    if file_path:
                        content = read_file_content(base_path, file_path)
                        if content:
                            results.append((file_path, content))
                except json.JSONDecodeError:
                    continue
    except Exception:
        pass
    return results


def get_agent_context(repo_root: str, task_dir: str, agent_type: str) -> str:
    context_parts = []
    agent_jsonl = f"{task_dir}/{agent_type}.jsonl"
    agent_entries = read_jsonl_entries(repo_root, agent_jsonl)
    if not agent_entries:
        agent_entries = read_jsonl_entries(repo_root, f"{task_dir}/spec.jsonl")
    for file_path, content in agent_entries:
        context_parts.append(f"=== {file_path} ===\n{content}")
    return "\n\n".join(context_parts)


def get_implement_context(repo_root: str, task_dir: str) -> str:
    context_parts = []
    base_context = get_agent_context(repo_root, task_dir, "implement")
    if base_context:
        context_parts.append(base_context)
    prd_content = read_file_content(repo_root, f"{task_dir}/prd.md")
    if prd_content:
        context_parts.append(f"=== {task_dir}/prd.md (Requirements) ===\n{prd_content}")
    info_content = read_file_content(repo_root, f"{task_dir}/info.md")
    if info_content:
        context_parts.append(f"=== {task_dir}/info.md (Technical Design) ===\n{info_content}")
    return "\n\n".join(context_parts)


def get_check_context(repo_root: str, task_dir: str) -> str:
    context_parts = []
    check_entries = read_jsonl_entries(repo_root, f"{task_dir}/check.jsonl")
    if check_entries:
        for file_path, content in check_entries:
            context_parts.append(f"=== {file_path} ===\n{content}")
    else:
        # Fallback: CC-Panes specific check files
        check_files = [
            (".claude/commands/ccbook/finish-work.md", "Finish work checklist"),
            (".claude/commands/ccbook/check-cross-layer.md", "Cross-layer check spec"),
            (".claude/commands/ccbook/check-backend.md", "Backend check spec"),
            (".claude/commands/ccbook/check-frontend.md", "Frontend check spec"),
            (".claude/commands/ccbook/check-tauri-bridge.md", "Tauri bridge check spec"),
        ]
        for file_path, description in check_files:
            content = read_file_content(repo_root, file_path)
            if content:
                context_parts.append(f"=== {file_path} ({description}) ===\n{content}")
        spec_entries = read_jsonl_entries(repo_root, f"{task_dir}/spec.jsonl")
        for file_path, content in spec_entries:
            context_parts.append(f"=== {file_path} (Dev spec) ===\n{content}")
    prd_content = read_file_content(repo_root, f"{task_dir}/prd.md")
    if prd_content:
        context_parts.append(f"=== {task_dir}/prd.md (Requirements) ===\n{prd_content}")
    return "\n\n".join(context_parts)


def get_debug_context(repo_root: str, task_dir: str) -> str:
    context_parts = []
    debug_entries = read_jsonl_entries(repo_root, f"{task_dir}/debug.jsonl")
    if debug_entries:
        for file_path, content in debug_entries:
            context_parts.append(f"=== {file_path} ===\n{content}")
    else:
        spec_entries = read_jsonl_entries(repo_root, f"{task_dir}/spec.jsonl")
        for file_path, content in spec_entries:
            context_parts.append(f"=== {file_path} (Dev spec) ===\n{content}")
        check_files = [
            (".claude/commands/ccbook/check-backend.md", "Backend check spec"),
            (".claude/commands/ccbook/check-frontend.md", "Frontend check spec"),
            (".claude/commands/ccbook/check-tauri-bridge.md", "Tauri bridge check spec"),
        ]
        for file_path, description in check_files:
            content = read_file_content(repo_root, file_path)
            if content:
                context_parts.append(f"=== {file_path} ({description}) ===\n{content}")
    return "\n\n".join(context_parts)


def get_research_context(repo_root: str, task_dir: str | None) -> str:
    spec_path = f"{DIR_WORKFLOW}/{DIR_SPEC}"
    context = f"""## CC-Panes Project Spec Directory

```
{spec_path}/
├── frontend/    # React 19 + TypeScript + Zustand standards
├── backend/     # Rust + Tauri 2 + SQLite standards
├── tauri/       # Tauri IPC, Rust-TS bridge patterns
└── guides/      # Cross-layer thinking, code reuse
```

## Search Tips

- Spec files: `{spec_path}/**/*.md`
- Frontend code: `src/` (React components, stores, services)
- Backend code: `src-tauri/src/` (commands, services, repository)
- Type definitions: `src/types/` (TS) and `src-tauri/src/models/` (Rust)
"""
    if task_dir:
        entries = read_jsonl_entries(repo_root, f"{task_dir}/research.jsonl")
        if entries:
            context += "\n## Additional Search Context\n"
            for file_path, content in entries:
                context += f"\n=== {file_path} ===\n{content}"
    return context


def build_prompt(agent_type: str, original_prompt: str, context: str, is_finish: bool = False) -> str:
    templates = {
        AGENT_IMPLEMENT: f"""# Implement Agent Task (CC-Panes)

You are the Implement Agent. CC-Panes uses a 7-step development flow:
Model → Repository → Service(Rust) → Command → Service(TS) → Store → Component

## Your Context

{context}

---

## Your Task

{original_prompt}

---

## Constraints

- Do NOT execute git commit, only code modifications
- Follow CC-Panes coding conventions (see CLAUDE.md)
- Rust: use AppResult<T>, State injection
- TypeScript: use Zustand + Immer, service layer for invoke()
- Report list of modified/created files when done""",

        AGENT_CHECK: f"""# {"Finish" if is_finish else "Check"} Agent Task (CC-Panes)

You are the {"Finish (final verification)" if is_finish else "Check"} Agent for a Tauri 2 project.

## Your Context

{context}

---

## Your Task

{original_prompt}

---

## Workflow

1. Run `git diff --name-only` and `git diff` to get changes
2. Check against specs above{"" if is_finish else " (fix issues directly)"}
3. {"Verify all acceptance criteria in prd.md" if is_finish else "Run project verification: `npx tsc --noEmit` and `cargo clippy --workspace`"}
4. {"Report readiness status" if is_finish else "Pay attention to Rust-TS type consistency"}

## CC-Panes Specific Checks

- Rust Command params (snake_case) match TS invoke params (camelCase)
- serde(rename_all = "camelCase") on all public structs
- Service layer wraps all invoke() calls (no direct invoke in components)""",

        AGENT_DEBUG: f"""# Debug Agent Task (CC-Panes)

You are the Debug Agent for a Tauri 2 desktop application.

## Your Context

{context}

---

## Your Task

{original_prompt}

---

## Workflow

1. Analyze the issues
2. Locate code in src/ (frontend) or src-tauri/src/ (backend)
3. Fix following CC-Panes conventions
4. Run `npx tsc --noEmit` and `cargo check --workspace` to verify

## Constraints

- Do NOT execute git commit
- Minimal fixes only, do not refactor
- Report which files were modified""",

        AGENT_RESEARCH: f"""# Research Agent Task (CC-Panes)

You are the Research Agent. You find and explain information, nothing more.

## Project Info

{context}

---

## Your Task

{original_prompt}

---

## Strict Boundaries

**Only allowed**: Describe what exists, where it is, how it works
**Forbidden**: Suggest improvements, criticize code, modify files""",
    }

    return templates.get(agent_type, original_prompt)


def main():
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)

    if input_data.get("tool_name") != "Task":
        sys.exit(0)

    tool_input = input_data.get("tool_input", {})
    subagent_type = tool_input.get("subagent_type", "")
    original_prompt = tool_input.get("prompt", "")
    cwd = input_data.get("cwd", os.getcwd())

    if subagent_type not in AGENTS_ALL:
        sys.exit(0)

    repo_root = find_repo_root(cwd)
    if not repo_root:
        sys.exit(0)

    task_dir = get_current_task(repo_root)

    if subagent_type in AGENTS_REQUIRE_TASK:
        if not task_dir:
            sys.exit(0)
        if not os.path.exists(os.path.join(repo_root, task_dir)):
            sys.exit(0)
        update_current_phase(repo_root, task_dir, subagent_type)

    is_finish = "[finish]" in original_prompt.lower()

    context_map = {
        AGENT_IMPLEMENT: lambda: get_implement_context(repo_root, task_dir),
        AGENT_CHECK: lambda: get_check_context(repo_root, task_dir),
        AGENT_DEBUG: lambda: get_debug_context(repo_root, task_dir),
        AGENT_RESEARCH: lambda: get_research_context(repo_root, task_dir),
    }

    context = context_map[subagent_type]()
    if not context:
        sys.exit(0)

    new_prompt = build_prompt(subagent_type, original_prompt, context, is_finish)

    output = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "updatedInput": {**tool_input, "prompt": new_prompt},
        }
    }
    print(json.dumps(output, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
