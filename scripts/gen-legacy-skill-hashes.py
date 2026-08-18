#!/usr/bin/env python3
"""生成 legacy-skill-hashes.json —— 历史版本写进用户 CLI Home 的发布物哈希清单。

背景：0.12.5 之前，CC-Panes 会把内置 skill 直接写进用户的
`~/.codex/skills/`、`~/.claude/skills/`、`~/.claude/commands/ccpanes/`。
现在改为只写 CC-Panes 自己的目录 + 按会话挂载，旧残留需要一次性回收。

回收**只删内容哈希能证明是我们发布物的文件**，用户手改过的、自建的一律保留。
本脚本遍历所有改动过模板目录的提交，按当时的渲染规则复原产物并取 SHA-256。

渲染规则必须与 `default_skill_service.rs` 保持一致：
- commands/*.md：变量替换后的原文
- skills/*/SKILL.md：`build_codex_skill_markdown` —— 模板已有 frontmatter 时
  等价于 `content.trim_start().trim_end() + "\\n"`

用法：
    python scripts/gen-legacy-skill-hashes.py
输出：
    src-tauri/resources/claude-bundle/default-skills/legacy-skill-hashes.json
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TEMPLATES = "src-tauri/resources/claude-bundle/default-skills"
OUT = REPO / TEMPLATES / "legacy-skill-hashes.json"


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=REPO, capture_output=True, text=True, encoding="utf-8"
    ).stdout


def git_bytes(*args: str) -> bytes | None:
    proc = subprocess.run(["git", *args], cwd=REPO, capture_output=True)
    return proc.stdout if proc.returncode == 0 else None


def replace_variables(text: str, variables: dict[str, str]) -> str:
    for key, value in variables.items():
        text = text.replace("{{" + key + "}}", value)
    return text


def render_skill_md(content: str) -> str | None:
    """复刻 build_codex_skill_markdown 的 frontmatter 透传分支。

    所有内置模板都自带 frontmatter；没有 frontmatter 的走另一条包装分支，
    那条依赖标题提取，历史上未被触发，故此处只处理透传分支并跳过异常输入。
    """
    trimmed = content.lstrip()
    if not (trimmed.startswith("---\n") or trimmed.startswith("---\r\n")):
        return None
    return trimmed.rstrip() + "\n"


def sha256_variants(text: str) -> set[str]:
    """同时收录 LF 与 CRLF 两种落盘形态。

    Rust 侧比对时会先做 CRLF 归一，这里补上原始 CRLF 形态属双保险：
    历史上不同平台/不同写入路径可能留下不同换行。
    """
    out = set()
    for payload in (text, text.replace("\n", "\r\n")):
        out.add(hashlib.sha256(payload.encode("utf-8")).hexdigest())
    return out


def collect_for_revision(rev: str) -> set[str]:
    manifest_raw = git_bytes("show", f"{rev}:{TEMPLATES}/manifest.json")
    if not manifest_raw:
        return set()
    try:
        manifest = json.loads(manifest_raw.decode("utf-8"))
    except json.JSONDecodeError:
        return set()

    variables = manifest.get("variables", {}) or {}
    hashes: set[str] = set()
    for entry in manifest.get("skills", []):
        blob = git_bytes("show", f"{rev}:{TEMPLATES}/{entry['file']}")
        if not blob:
            continue
        content = replace_variables(blob.decode("utf-8"), variables)
        # ① commands/<file>.md 是变量替换后的原文
        hashes |= sha256_variants(content)
        # ② skills/<name>/SKILL.md 走 codex 渲染
        rendered = render_skill_md(content)
        if rendered:
            hashes |= sha256_variants(rendered)
    return hashes


def main() -> int:
    revs = [
        line.strip()
        for line in git(
            "log", "--all", "--format=%H", "--", TEMPLATES
        ).splitlines()
        if line.strip()
    ]
    if not revs:
        print("no revisions touching templates; refusing to write an empty manifest")
        return 1
    revs.append("HEAD")

    all_hashes: set[str] = set()
    for rev in revs:
        found = collect_for_revision(rev)
        all_hashes |= found

    payload = {
        "_comment": (
            "SHA-256 of every historical CC-Panes bundled skill artifact ever written "
            "into a user's CLI home. Used ONLY to decide what the one-time legacy "
            "cleanup may delete: a file is removed only if its hash appears here, so "
            "user-authored or user-modified files are always preserved. "
            "Regenerate with scripts/gen-legacy-skill-hashes.py"
        ),
        "sha256": sorted(all_hashes),
    }
    OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"scanned {len(revs)} revisions -> {len(all_hashes)} hashes -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
