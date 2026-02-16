#!/usr/bin/env python3
"""
Tauri Bridge Guard Hook - Warn when modifying bridge files

Matcher: PreToolUse (Edit, Write tools)

When modifying files that are part of the Rust-TypeScript bridge,
outputs a reminder to check type consistency across layers.

Bridge file patterns:
- src-tauri/src/commands/*.rs  (Tauri command definitions)
- src-tauri/src/models/*.rs    (Rust data models)
- src/services/*.ts            (Frontend service layer, invoke calls)
- src/types/*.ts               (TypeScript type definitions)
"""

import json
import sys


BRIDGE_PATTERNS = [
    ("src-tauri/src/commands", "Tauri Command"),
    ("src-tauri/src/models", "Rust Model"),
    ("src/services", "Frontend Service"),
    ("src/types", "TypeScript Type"),
]


def main():
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)

    tool_name = input_data.get("tool_name", "")
    if tool_name not in ("Edit", "Write"):
        sys.exit(0)

    tool_input = input_data.get("tool_input", {})
    file_path = tool_input.get("file_path", "")

    # Normalize path separators
    normalized = file_path.replace("\\", "/")

    matched_layer = None
    for pattern, layer_name in BRIDGE_PATTERNS:
        if pattern in normalized:
            matched_layer = layer_name
            break

    if not matched_layer:
        sys.exit(0)

    # Determine the counterpart layer
    counterparts = {
        "Tauri Command": "src/services/*.ts (TS invoke calls)",
        "Rust Model": "src/types/*.ts (TS interfaces)",
        "Frontend Service": "src-tauri/src/commands/*.rs (Rust commands)",
        "TypeScript Type": "src-tauri/src/models/*.rs (Rust structs)",
    }

    message = (
        f"[Bridge Guard] Modifying {matched_layer} file.\n"
        f"Counterpart: {counterparts.get(matched_layer, 'unknown')}\n"
        f"Ensure Rust-TS type consistency. Run /ccbook:check-tauri-bridge after changes."
    )

    output = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "message": message,
        }
    }
    print(json.dumps(output, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
