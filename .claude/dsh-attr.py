"""按 PR 分支前缀归因提交数：一次性拉提交图，在内存里做可达性划分。

每个 merge commit 引入的提交 = 从第二父可达、且尚未被更晚的 merge 认领的提交。
沿 first-parent 主线从新到旧处理，保证每个提交只被认领一次。
"""
import re
import subprocess
import sys
from collections import defaultdict

REPO = r"D:\04_workspace_rust\references\deepseek-harness"


def git(*args):
    return subprocess.run(
        ["git", "-C", REPO, *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace", check=True,
    ).stdout


# 全量提交图：sha -> parents
parents = {}
subject = {}
for line in git("log", "--all", "--format=%H|%P|%s").splitlines():
    sha, ps, subj = line.split("|", 2)
    parents[sha] = ps.split() if ps else []
    subject[sha] = subj

# first-parent 主线（从 HEAD 出发）
mainline = git("log", "--first-parent", "--format=%H").split()
mainline_set = set(mainline)

PR_RE = re.compile(r"Merge pull request #\d+ from [^/]+/(.+)")

claimed = set(mainline_set)  # 主线提交本身不归任何 PR
by_prefix = defaultdict(int)
pr_count = defaultdict(int)
unattributed = 0

# 从新到旧沿主线走
for sha in mainline:
    ps = parents.get(sha, [])
    if len(ps) < 2:
        continue
    m = PR_RE.match(subject[sha])
    prefix = m.group(1).split("/")[0] if m else "(non-PR-merge)"

    # 从第二父 DFS，遇到已认领的就停
    stack = [p for p in ps[1:]]
    n = 0
    while stack:
        cur = stack.pop()
        if cur in claimed or cur not in parents:
            continue
        claimed.add(cur)
        n += 1
        stack.extend(parents[cur])
    by_prefix[prefix] += n
    if m:
        pr_count[prefix] += 1

total_attr = sum(by_prefix.values())
print(f"提交总数(全图): {len(parents)}")
print(f"first-parent 主线: {len(mainline)}")
print(f"被 PR 认领的提交: {total_attr}")
print()
print(f"{'前缀':<22}{'提交数':>8}{'占比':>8}{'PR数':>7}")
print("-" * 46)
for k, v in sorted(by_prefix.items(), key=lambda x: -x[1])[:18]:
    pct = v / total_attr * 100 if total_attr else 0
    print(f"{k:<22}{v:>8}{pct:>7.1f}%{pr_count.get(k, 0):>7}")
