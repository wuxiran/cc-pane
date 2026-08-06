"""#6 #10 #11 #16 回归。"""
from playwright.sync_api import sync_playwright

URL = "file:///D:/04_workspace_rust/cc-book/docs/assets/mockups/64-fleet-template.html"
res = []
def check(n, ok, d=""):
    res.append((ok, n, d)); print(f"{'PASS' if ok else 'FAIL'}  {n}" + (f"  — {d}" if d else ""))

with sync_playwright() as p:
    br = p.chromium.launch(headless=True)

    # ══ 常规动效上下文 ══
    page = br.new_context(viewport={"width": 1600, "height": 900}).new_page()
    page.goto(URL); page.wait_for_load_state("networkidle"); page.wait_for_timeout(600)

    # ── #6 抓节点必须冻住画布余速 ──────────────────────────────
    page.mouse.move(700, 750); page.mouse.down()
    for i in range(1, 7):
        page.mouse.move(700 + i * 40, 750)
    page.mouse.up()                                  # 画布带惯性飞行中
    page.wait_for_timeout(40)
    pan_v_before = page.evaluate("() => Math.abs(pan.vx)+Math.abs(pan.vy)")
    box = page.locator(".node").nth(4).bounding_box()
    page.mouse.move(box["x"] + 40, box["y"] + 30)
    page.mouse.down()                                # 惯性未停就抓住节点
    pan_v_after = page.evaluate("() => Math.abs(pan.vx)+Math.abs(pan.vy)")
    x0 = page.evaluate("() => nodes.find(n=>n.id==='W3').x")
    page.wait_for_timeout(400)                       # 指针一动不动
    x1 = page.evaluate("() => nodes.find(n=>n.id==='W3').x")
    page.mouse.up(); page.wait_for_timeout(300)
    check("#6 抓节点时画布仍有余速可被冻结（前提成立）", pan_v_before > 50, f"抓取前 |v|={pan_v_before:.0f}")
    check("#6 抓取后画布速度归零", pan_v_after == 0, f"抓取后 |v|={pan_v_after:.0f}")
    check("#6 指针静止时节点不漂", abs(x1 - x0) < 0.5, f"漂移={abs(x1-x0):.2f}px")

    # ── #16 stray 节点禁用写操作 ───────────────────────────────
    page.evaluate("() => { sel='X1'; asideKey=null; drawAside(); }")
    page.wait_for_timeout(150)
    # 按钮里是「标签文本节点 + .api 的 span」，取 firstChild 才是标签本身
    labels = page.evaluate("""() => [...document.querySelectorAll('aside .act')]
        .map(b => [b.firstChild.textContent.trim(), b.disabled])""")
    dis = {k: v for k, v in labels}
    check("#16 stray 禁用「终止会话」", dis.get("终止会话") is True, str(dis))
    check("#16 stray 禁用「再派一轮」", dis.get("再派一轮") is True, str(dis))
    check("#16 stray 不提供唤醒按钮", "发送回车唤醒" not in dis, str(list(dis)))
    check("#16 stray 保留只读动作", dis.get("读取最近输出") is False, str(dis))

    # ── #11 aside 逐秒刷新不得丢焦点 ────────────────────────────
    page.evaluate("() => { sel='W3'; asideKey=null; drawAside(); }")
    page.wait_for_timeout(150)
    page.locator("aside .act").last.focus()
    focused_before = page.evaluate("() => document.activeElement.textContent.slice(0,4)")
    node_before = page.evaluate("() => document.activeElement.tagName")
    page.wait_for_timeout(2600)                      # 跨过 2 次定时刷新
    focused_after = page.evaluate("() => document.activeElement.textContent.slice(0,4)")
    same = page.evaluate("() => document.activeElement.tagName")
    check("#11 跨 2 次刷新仍保持焦点",
          focused_before == focused_after and node_before == same == "BUTTON",
          f"{node_before}:{focused_before!r} → {same}:{focused_after!r}")
    ticking = page.evaluate("() => document.querySelector('aside [data-f=\"age\"]').textContent")
    page.wait_for_timeout(1200)
    ticking2 = page.evaluate("() => document.querySelector('aside [data-f=\"age\"]').textContent")
    check("#11 数值仍在逐秒更新（没把刷新一起关掉）", ticking != ticking2, f"{ticking} → {ticking2}")

    # ══ 减弱动效上下文 ══
    page2 = br.new_context(viewport={"width": 1600, "height": 900}, reduced_motion="reduce").new_page()
    page2.goto(URL); page2.wait_for_load_state("networkidle"); page2.wait_for_timeout(500)
    check("#10 已进入减弱动效模式", page2.evaluate("() => REDUCED") is True)

    page2.mouse.move(800, 480)
    for _ in range(10):
        page2.mouse.wheel(0, 400)                    # 一路缩到下限，制造越界
    page2.wait_for_timeout(200)
    st = page2.evaluate("""() => { const b=panBounds();
        return {x:pan.x,y:pan.y,b, okx: pan.x>=b.x0-1 && pan.x<=b.x1+1,
                oky: pan.y>=b.y0-1 && pan.y<=b.y1+1}; }""")
    check("#10 减弱动效下缩放后 pan 未永久越界", st["okx"] and st["oky"],
          f"pan=({st['x']:.0f},{st['y']:.0f}) x∈[{st['b']['x0']:.0f},{st['b']['x1']:.0f}]")

    page2.evaluate("() => { resetView(); }")
    page2.wait_for_timeout(200)
    page2.mouse.move(700, 700); page2.mouse.down()
    for i in range(1, 8):
        page2.mouse.move(700 + i * 50, 700)
    px_rel = page2.evaluate("() => pan.x")
    page2.mouse.up(); page2.wait_for_timeout(400)
    px_fin = page2.evaluate("() => pan.x")
    check("#10 减弱动效下甩动不投射", abs(px_fin - px_rel) < 2, f"松手后额外位移={abs(px_fin-px_rel):.1f}px")

    br.close()

print("\n" + "=" * 56)
bad = [r for r in res if not r[0]]
print(f"{len(res)-len(bad)}/{len(res)} 通过")
for _, n, d in bad:
    print(f"  x {n}  {d}")
raise SystemExit(1 if bad else 0)
