"""诊断：拖拽期间到底收到了多少 pointermove，以及松手时的采样历史长什么样。"""
from playwright.sync_api import sync_playwright

URL = "file:///D:/04_workspace_rust/cc-book/docs/assets/mockups/64-fleet-template.html"

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    page = b.new_page(viewport={"width": 1600, "height": 900})
    page.goto(URL); page.wait_for_load_state("networkidle"); page.wait_for_timeout(600)

    # 在节点上挂旁路探针，记录每个指针事件的类型/坐标/时间戳
    page.evaluate("""() => {
      window.__log = [];
      const el = document.querySelectorAll('.node')[4];
      for (const t of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture']) {
        el.addEventListener(t, e => window.__log.push(
          {t, x: Math.round(e.clientX), ts: Math.round(e.timeStamp), id: e.pointerId}
        ), true);   // 捕获阶段，先于业务 handler
      }
    }""")

    box = page.locator(".node").nth(4).bounding_box()
    sx, sy = box["x"] + 40, box["y"] + 30
    page.mouse.move(sx, sy)
    page.mouse.down()
    for i in range(1, 11):
        page.mouse.move(sx + i * 45, sy)
        page.wait_for_timeout(10)
    page.mouse.up()
    page.wait_for_timeout(50)

    log = page.evaluate("() => window.__log")
    print(f"事件总数 {len(log)}")
    for e in log:
        print(f"  {e['t']:<18} x={e['x']:<6} ts={e['ts']:<8} pid={e['id']}")

    moves = [e for e in log if e["t"] == "pointermove"]
    if len(moves) >= 2:
        span = moves[-1]["ts"] - moves[0]["ts"]
        dx = moves[-1]["x"] - moves[0]["x"]
        print(f"\npointermove {len(moves)} 个，跨度 {span}ms，位移 {dx}px"
              f" → 平均 {dx/(span/1000) if span else 0:.0f} px/s")
        last90 = [m for m in moves if moves[-1]["ts"] - m["ts"] <= 90]
        if len(last90) >= 2:
            s = last90[-1]["ts"] - last90[0]["ts"]
            d = last90[-1]["x"] - last90[0]["x"]
            print(f"最近 90ms 窗口内 {len(last90)} 个样本，{d}px / {s}ms → {d/(s/1000) if s else 0:.0f} px/s")
    b.close()
