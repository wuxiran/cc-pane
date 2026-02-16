#!/usr/bin/env python3
"""
Session Start Hook - Inject structured context for CC-Panes project

Matcher: "startup" - only runs on normal startup (not resume/clear/compact)

This hook injects:
1. Current state (git status, current task)
2. Workflow guide
3. Guidelines index (frontend/backend/tauri/guides)
4. Session instructions
5. Action directive
"""

import os
import subprocess
import sys
from pathlib import Path


def should_skip_injection() -> bool:
    """Skip in non-interactive mode (multi-agent scripts set CLAUDE_NON_INTERACTIVE=1)."""
    return os.environ.get("CLAUDE_NON_INTERACTIVE") == "1"


def read_file(path: Path, fallback: str = "") -> str:
    """Read file content, return fallback if not found."""
    try:
        return path.read_text(encoding="utf-8")
    except (FileNotFoundError, PermissionError):
        return fallback


def get_git_context(project_dir: Path) -> str:
    """Get current git branch and status summary."""
    parts = []
    try:
        branch = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=5, cwd=str(project_dir),
        )
        if branch.returncode == 0:
            parts.append(f"Branch: {branch.stdout.strip()}")

        status = subprocess.run(
            ["git", "status", "--short"],
            capture_output=True, text=True, timeout=5, cwd=str(project_dir),
        )
        if status.returncode == 0:
            lines = status.stdout.strip().split("\n")
            if lines and lines[0]:
                parts.append(f"Changed files: {len(lines)}")
            else:
                parts.append("Working tree clean")
    except (subprocess.TimeoutExpired, FileNotFoundError):
        parts.append("Git info unavailable")

    return "\n".join(parts)


def get_current_task(trellis_dir: Path) -> str:
    """Read current task from .trellis/.current-task."""
    task_file = trellis_dir / ".current-task"
    content = read_file(task_file).strip()
    return content if content else "No active task"


def main():
    if should_skip_injection():
        sys.exit(0)

    project_dir = Path(os.environ.get("CLAUDE_PROJECT_DIR", ".")).resolve()
    trellis_dir = project_dir / ".trellis"
    claude_dir = project_dir / ".claude"

    # 1. Header
    print("""<session-context>
You are starting a new session in the CC-Panes project.
CC-Panes is a Tauri 2 desktop app (React 19 + Rust) for managing multiple Claude Code instances.
Read and follow all instructions below carefully.
</session-context>
""")

    # 2. Current State
    print("<current-state>")
    print(get_git_context(project_dir))
    print(f"Current task: {get_current_task(trellis_dir)}")
    print("</current-state>")
    print()

    # 3. Workflow Guide
    workflow_content = read_file(trellis_dir / "workflow.md")
    if workflow_content:
        print("<workflow>")
        print(workflow_content)
        print("</workflow>")
        print()

    # 4. Guidelines Index
    print("<guidelines>")

    print("## Frontend (React 19 + TypeScript + Zustand)")
    print(read_file(trellis_dir / "spec" / "frontend" / "index.md", "Not configured"))
    print()

    print("## Backend (Rust + Tauri 2 + SQLite)")
    print(read_file(trellis_dir / "spec" / "backend" / "index.md", "Not configured"))
    print()

    print("## Tauri (IPC + Bridge)")
    print(read_file(trellis_dir / "spec" / "tauri" / "index.md", "Not configured"))
    print()

    print("## Guides")
    print(read_file(trellis_dir / "spec" / "guides" / "index.md", "Not configured"))

    print("</guidelines>")
    print()

    # 5. Session Instructions
    start_md = read_file(claude_dir / "commands" / "ccbook" / "start.md")
    if start_md:
        print("<instructions>")
        print(start_md)
        print("</instructions>")
        print()

    # 6. Final directive
    print("""<ready>
Context loaded. Wait for user's first message, then follow <instructions> to handle their request.
</ready>""")


if __name__ == "__main__":
    main()
