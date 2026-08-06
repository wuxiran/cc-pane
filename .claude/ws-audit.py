import json, io, os, collections, sys

BASE = os.path.expanduser("~") + "/.cc-panes/workspaces"
BS = chr(92)
UNC = BS + BS + "wsl.localhost" + BS


def canon(p):
    """把 4 种路径形式归一到同一身份：D:\\X / /mnt/d/X / \\\\wsl.localhost\\D\\mnt\\d\\X。"""
    s = p.strip().replace("/", BS)
    if s.lower().startswith(UNC.lower()):
        rest = s[len(UNC):]
        parts = rest.split(BS, 1)          # distro, 剩余
        rest = parts[1] if len(parts) > 1 else ""
        seg = rest.split(BS)
        if len(seg) >= 2 and seg[0].lower() == "mnt" and len(seg[1]) == 1:
            return seg[1].upper() + ":" + BS + BS.join(seg[2:])
        return "WSL:" + BS + rest
    seg = s.split(BS)
    if len(seg) >= 3 and seg[0] == "" and seg[1].lower() == "mnt" and len(seg[2]) == 1:
        return seg[2].upper() + ":" + BS + BS.join(seg[3:])
    if len(s) >= 2 and s[1] == ":":
        return s[0].upper() + s[1:]
    return s


rows = []
tot = dup = miss = 0
dup_detail = collections.defaultdict(list)
miss_detail = collections.defaultdict(list)

for name in sorted(os.listdir(BASE)):
    f = os.path.join(BASE, name, "workspace.json")
    if not os.path.exists(f):
        rows.append((name, -1, 0, 0, 0))
        continue
    d = json.load(io.open(f, encoding="utf-8"))
    paths = [(p.get("path") or "").strip() for p in d.get("projects", [])]
    paths = [p for p in paths if p]
    c = collections.Counter(canon(p) for p in paths)
    n, uniq = len(paths), len(c)
    dups = n - uniq
    missing = [k for k in c if not k.startswith("WSL:") and not os.path.exists(k)]
    rows.append((name, n, uniq, dups, len(missing)))
    if dups:
        dup_detail[name] = [(k, v) for k, v in c.items() if v > 1]
    if missing:
        miss_detail[name] = missing
    tot += n
    dup += dups
    miss += len(missing)

print("%-30s %4s %5s %5s %5s" % ("工作空间", "条目", "唯一", "重复", "失效"))
print("-" * 56)
for r in rows:
    if r[1] == -1:
        print("%-30s   (损坏：无 workspace.json)" % r[0])
        continue
    flag = "  <<" if (r[3] or r[4]) else ""
    print("%-30s %4d %5d %5d %5d%s" % (r[0], r[1], r[2], r[3], r[4], flag))
print("-" * 56)
print("合计：条目 %d，跨形式重复 %d，唯一项目中路径失效 %d" % (tot, dup, miss))

if len(sys.argv) > 1 and sys.argv[1] == "detail":
    print("\n=== 跨形式重复明细（同一项目被注册多次）===")
    for ws, items in dup_detail.items():
        print(" [%s]" % ws)
        for k, v in items:
            print("   x%d  %s" % (v, k))
    print("\n=== 失效明细（目录已不存在）===")
    for ws, items in miss_detail.items():
        print(" [%s]" % ws)
        for k in items:
            print("   %s" % k)
