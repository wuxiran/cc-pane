"""阻断 #1 回归：真实 task_bindings 顺序（DESC）+ 孤儿 + 环 + 多根，不得留 undefined 坐标或抛错。"""
from playwright.sync_api import sync_playwright

URL = "file:///D:/04_workspace_rust/cc-book/docs/assets/mockups/64-fleet-template.html"
errs = []

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    page = b.new_page(viewport={"width": 1600, "height": 900})
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.goto(URL); page.wait_for_load_state("networkidle"); page.wait_for_timeout(500)

    hostile = page.evaluate("""() => {
      // 1) created_at DESC：worker 排到 leader 前面   2) 孤儿   3) 自环   4) 二元环   5) 第二个根
      nodes.reverse();
      nodes.push({id:"ORPH", parentId:"NOPE", role:"worker", identity:"x", name:"孤儿绑定",
                  status:"running", cli:"claude", runtime:"local", launchId:"a3f1c8",
                  path:"?", age:300, silence:10, hist:new Array(56).fill(0.4)});
      nodes.push({id:"SELF", parentId:"SELF", role:"worker", identity:"x", name:"自环",
                  status:"running", cli:"claude", runtime:"local", launchId:"a3f1c8",
                  path:"?", age:300, silence:10, hist:new Array(56).fill(0.4)});
      nodes.push({id:"CA", parentId:"CB", role:"worker", identity:"x", name:"环 A",
                  status:"running", cli:"claude", runtime:"local", launchId:"a3f1c8",
                  path:"?", age:300, silence:10, hist:new Array(56).fill(0.4)});
      nodes.push({id:"CB", parentId:"CA", role:"worker", identity:"x", name:"环 B",
                  status:"running", cli:"claude", runtime:"local", launchId:"a3f1c8",
                  path:"?", age:300, silence:10, hist:new Array(56).fill(0.4)});
      nodes.push({id:"R2", parentId:null, role:"leader", identity:"y", name:"另一个 plan 根",
                  status:"running", cli:"claude", runtime:"local", launchId:"a3f1c8",
                  path:"?", age:300, silence:10, hist:new Array(56).fill(0.4)});
      autoLayout();
      return {
        total: nodes.length,
        bad: nodes.filter(n=>!Number.isFinite(n.hx)||!Number.isFinite(n.hy)).map(n=>n.id),
        anomalies: nodes.filter(n=>n.anomaly).map(n=>[n.id,n.anomaly]),
        roots: nodes.filter(n=>!n.pid).map(n=>n.id),
      };
    }""")
    page.wait_for_timeout(600)   # 让 rAF 跑几帧，undefined 坐标会在 toFixed 处炸出来

    print(f"节点数         {hostile['total']}")
    print(f"坐标未定义     {hostile['bad'] or '无'}")
    print(f"异常标记       {hostile['anomalies']}")
    print(f"识别出的根     {hostile['roots']}")
    print(f"运行时错误     {errs or '无'}")

    ok = [
        ("所有节点都有有限坐标", not hostile["bad"]),
        ("孤儿被识别", ["ORPH", "orphan"] in hostile["anomalies"]),
        ("自环被识别", ["SELF", "cycle"] in hostile["anomalies"]),
        ("二元环被识别", any(a[1] == "cycle" and a[0] in ("CA", "CB") for a in hostile["anomalies"])),
        ("多根被收集", len(hostile["roots"]) >= 5),
        ("rAF 无抛错", not errs),
    ]
    print()
    for name, good in ok:
        print(f"{'PASS' if good else 'FAIL'}  {name}")
    b.close()
    raise SystemExit(0 if all(g for _, g in ok) else 1)
