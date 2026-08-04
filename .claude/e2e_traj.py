"""采样松手后的完整轨迹：释放瞬时速度、峰值越冲、最终落点。"""
from playwright.sync_api import sync_playwright

URL = "file:///D:/04_workspace_rust/cc-book/docs/assets/mockups/64-fleet-template.html"

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    page = b.new_page(viewport={"width": 1600, "height": 900})
    page.goto(URL); page.wait_for_load_state("networkidle"); page.wait_for_timeout(600)

    # 在 pointerup 冒泡阶段之后立刻抓取瞬时状态，并逐帧采样轨迹
    page.evaluate("""() => {
      window.__traj = []; window.__v0 = null;
      const el = document.querySelectorAll('.node')[4];
      const n  = nodes.find(n=>n.id==='W3');
      el.addEventListener('pointerup', () => {
        queueMicrotask(() => { window.__v0 = {vx:n.vx, x:n.x, tx:n.tx}; });
        const t0 = performance.now();
        (function sample(){
          window.__traj.push({t: performance.now()-t0, x: n.x});
          if (performance.now()-t0 < 1500) requestAnimationFrame(sample);
        })();
      });
    }""")

    box = page.locator(".node").nth(4).bounding_box()
    sx, sy = box["x"] + 40, box["y"] + 30
    page.mouse.move(sx, sy); page.mouse.down()
    # 真实快甩节奏：先慢速起手，最后一段连续高频移动，松手紧跟最后一次 move（不加等待）
    for i in range(1, 5):
        page.mouse.move(sx + i * 30, sy); page.wait_for_timeout(16)
    page.mouse.move(sx + 320, sy, steps=6)   # 连续 6 个 pointermove，无间隔
    page.mouse.up()
    page.wait_for_timeout(1800)

    v0 = page.evaluate("() => window.__v0")
    traj = page.evaluate("() => window.__traj")
    x_rel = v0["x"]
    xs = [pt["x"] for pt in traj]
    peak = max(xs) - x_rel
    final = xs[-1] - x_rel
    t_peak = max(traj, key=lambda pt: pt["x"])["t"]

    print(f"释放瞬时速度 vx   = {v0['vx']:8.1f} px/s")
    print(f"弹簧目标 tx-释放  = {v0['tx']-x_rel:8.1f} px")
    print(f"峰值越冲          = {peak:8.1f} px  @ {t_peak:.0f}ms")
    print(f"最终落点-释放     = {final:8.1f} px")
    print(f"理论峰值 v/(ω·e)  = {v0['vx']/(2*3.14159/0.4*2.71828):8.1f} px")
    print(f"回弹量 (峰值-最终) = {peak-final:8.1f} px  ← 非零即「荡出去又缩回来」")
    b.close()
