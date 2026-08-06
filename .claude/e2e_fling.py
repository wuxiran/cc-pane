"""专测松手动量：必须真的产生释放速度，才能验证「不再算两遍」而非「压根没速度」。"""
from playwright.sync_api import sync_playwright

URL = "file:///D:/04_workspace_rust/cc-book/docs/assets/mockups/64-fleet-template.html"

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    page = b.new_page(viewport={"width": 1600, "height": 900})
    page.goto(URL); page.wait_for_load_state("networkidle"); page.wait_for_timeout(600)

    box = page.locator(".node").nth(4).bounding_box()
    sx, sy = box["x"] + 40, box["y"] + 30
    page.mouse.move(sx, sy)
    page.mouse.down()
    # 带真实时间间隔的快速拖动，制造非零释放速度
    for i in range(1, 11):
        page.mouse.move(sx + i * 45, sy)
        page.wait_for_timeout(10)
    x_release = page.evaluate("() => nodes.find(n=>n.id==='W3').x")
    page.mouse.up()
    page.wait_for_timeout(30)
    v_release = page.evaluate("() => nodes.find(n=>n.id==='W3').vx")
    target = page.evaluate("() => nodes.find(n=>n.id==='W3').tx")
    page.wait_for_timeout(1600)
    x_final = page.evaluate("() => nodes.find(n=>n.id==='W3').x")

    glide = x_final - x_release
    predicted = v_release / (2 * 3.14159 / 0.4 * 2.71828)   # v/(ω·e)，临界阻尼理论滑行

    print(f"释放速度 vx      = {v_release:8.1f} px/s")
    print(f"弹簧目标 tx-释放 = {target - x_release:8.1f} px   （应≈0：落点即松手处，不投射）")
    print(f"实际滑行         = {glide:8.1f} px")
    print(f"理论滑行 v/(ω·e) = {predicted:8.1f} px")
    print(f"旧 bug 会额外投射 = {v_release * 0.499:8.1f} px")

    ok_v = abs(v_release) > 300
    ok_t = abs(target - x_release) < 2
    ok_g = abs(glide - predicted) < max(15, abs(predicted) * 0.35)
    for name, ok in [("释放速度非零（用例有效）", ok_v),
                     ("落点=松手处，未做动量投射", ok_t),
                     ("滑行量吻合临界阻尼理论值", ok_g)]:
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
    b.close()
    raise SystemExit(0 if (ok_v and ok_t and ok_g) else 1)
