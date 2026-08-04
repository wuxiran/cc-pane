"""fleet 原型 e2e：真实指针事件驱动，验证手势物理与已修的两个 bug 不回归。"""
from playwright.sync_api import sync_playwright

URL = "file:///D:/04_workspace_rust/cc-book/docs/assets/mockups/64-fleet-template.html"
results, errors = [], []


def check(name, ok, detail=""):
    results.append((ok, name, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


def node_xy(page, nid):
    return page.evaluate(f"() => {{ const n = nodes.find(n=>n.id==='{nid}'); return [n.x, n.y]; }}")


def settle(page, ms=1400):
    page.wait_for_timeout(ms)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1600, "height": 900})
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(600)

    # ── 1. 渲染完整性 ────────────────────────────────────────────
    n_nodes = page.locator(".node").count()
    n_wires = page.locator("svg.wires path.wire").count()
    check("渲染 9 节点 / 8 连线", n_nodes == 9 and n_wires == 8, f"nodes={n_nodes} wires={n_wires}")

    # ── 2. 静默告警判定：卡死告警、刚派发不告警 ───────────────────
    w3 = page.evaluate("() => document.querySelectorAll('.node')[4].dataset.alarm")
    alarm_map = page.evaluate(
        "() => Object.fromEntries(nodes.map((n,i)=>[n.id, document.querySelectorAll('.node')[i].dataset.alarm]))"
    )
    check("W3 卡死 → 告警", alarm_map.get("W3") == "true", str(alarm_map.get("W3")))
    check("W6 刚派发 → 不告警（同形消解）", alarm_map.get("W6") == "false", str(alarm_map.get("W6")))

    # ── 3. panBounds 区间不倒挂（左右不能移的根因）────────────────
    pb = page.evaluate("() => panBounds()")
    check("panBounds X 不倒挂", pb["x0"] < pb["x1"], f"x0={pb['x0']:.0f} x1={pb['x1']:.0f}")
    check("panBounds Y 不倒挂", pb["y0"] < pb["y1"], f"y0={pb['y0']:.0f} y1={pb['y1']:.0f}")

    # ── 4. 画布横向平移真的动（回归用例）──────────────────────────
    page.evaluate("() => { pan.x=0; pan.y=0; pan.tx=0; pan.ty=0; pan.vx=0; pan.vy=0; }")
    page.mouse.move(700, 700)
    page.mouse.down()
    for i in range(1, 9):
        page.mouse.move(700 + i * 25, 700)
        page.wait_for_timeout(12)
    dx_live = page.evaluate("() => pan.x")
    page.mouse.up()
    settle(page)
    dx_final = page.evaluate("() => pan.x")
    check("画布横向平移生效", dx_live > 150, f"拖拽中 pan.x={dx_live:.0f}")
    check("横向平移松手后保持", dx_final > 120, f"落定 pan.x={dx_final:.0f}")

    # ── 5. 纵向平移 ──────────────────────────────────────────────
    page.evaluate("() => { pan.x=0; pan.y=0; pan.tx=0; pan.ty=0; pan.vx=0; pan.vy=0; }")
    page.mouse.move(700, 500)
    page.mouse.down()
    for i in range(1, 7):
        page.mouse.move(700, 500 - i * 25)
        page.wait_for_timeout(12)
    dy_live = page.evaluate("() => pan.y")
    page.mouse.up()
    settle(page)
    check("画布纵向平移生效", dy_live < -100, f"拖拽中 pan.y={dy_live:.0f}")

    # ── 6. 节点 1:1 跟随（拖拽中断言，含抓取偏移）──────────────────
    page.evaluate("() => { resetView(); }")
    settle(page)
    box = page.locator(".node").nth(4).bounding_box()  # W3
    sx, sy = box["x"] + 40, box["y"] + 30              # 故意偏离中心，验证抓取偏移
    x0, y0 = node_xy(page, "W3")
    page.mouse.move(sx, sy)
    page.mouse.down()
    page.mouse.move(sx + 160, sy + 90, steps=8)
    page.wait_for_timeout(60)
    x1, y1 = node_xy(page, "W3")
    moved = (x1 - x0, y1 - y0)
    ok11 = abs(moved[0] - 160) < 3 and abs(moved[1] - 90) < 3
    check("节点 1:1 跟随且尊重抓取偏移", ok11, f"位移={moved[0]:.1f},{moved[1]:.1f} 期望=160,90")

    # ── 7. 快甩松手不得飞走（动量算两遍的回归用例）────────────────
    page.mouse.move(sx + 420, sy + 90, steps=3)   # 快速甩
    xr, yr = node_xy(page, "W3")
    page.mouse.up()
    settle(page)
    xf, yf = node_xy(page, "W3")
    glide = abs(xf - xr)
    # 物理不变式：滑行 = min(v/ω, MAX_GLIDE)。旧 bug（投射 0.499v）会到 400+
    check("快甩滑行封顶在 160px", glide <= 162, f"滑行={glide:.0f}px（旧 bug 约 400+）")

    # ── 8. 缩放锚点：指针下的世界点必须不动 ────────────────────────
    page.evaluate("() => { resetView(); }")
    settle(page)
    ax, ay = 800, 480
    before = page.evaluate(f"() => {{ const w = toWorld({ax},{ay}); return [w.x, w.y, view.z]; }}")
    page.mouse.move(ax, ay)
    page.mouse.wheel(0, -420)
    page.wait_for_timeout(120)
    after = page.evaluate(
        f"() => {{ const r=canvas.getBoundingClientRect();"
        f" return [{before[0]}*view.z+pan.x+r.left, {before[1]}*view.z+pan.y+r.top, view.z]; }}"
    )
    drift = (abs(after[0] - ax), abs(after[1] - ay))
    check("滚轮缩放生效", after[2] > before[2] + 0.05, f"z {before[2]:.2f} → {after[2]:.2f}")
    check("缩放锚点不漂", drift[0] < 1.5 and drift[1] < 1.5, f"漂移={drift[0]:.2f},{drift[1]:.2f}px")

    # ── 9. 缩小到远景切详略 ───────────────────────────────────────
    page.evaluate("() => { resetView(); }")
    page.mouse.move(800, 480)
    for _ in range(6):
        page.mouse.wheel(0, 400)
        page.wait_for_timeout(40)
    z_far = page.evaluate("() => view.z")
    lod = page.evaluate("() => stage.dataset.lod")
    trace_vis = page.locator(".node").nth(0).locator(".n-trace").is_visible()
    check("缩小切远景 LOD", z_far < 0.55 and lod == "far", f"z={z_far:.2f} lod={lod}")
    check("远景收起轨迹细节", not trace_vis, f"trace visible={trace_vis}")

    # ── 10. 缩放钳制 ─────────────────────────────────────────────
    for _ in range(14):
        page.mouse.wheel(0, 500)
    page.wait_for_timeout(120)
    zmin = page.evaluate("() => view.z")
    check("缩放下限钳制在 0.25", abs(zmin - 0.25) < 0.001, f"z={zmin:.3f}")

    # ── 11. 重置视图 ─────────────────────────────────────────────
    page.click("#relayout")
    settle(page, 1800)
    z_reset = page.evaluate("() => view.z")
    back = page.evaluate("() => { const n=nodes.find(n=>n.id==='W3'); return [Math.abs(n.x-n.hx), Math.abs(n.y-n.hy)]; }")
    check("重置视图回到 100%", abs(z_reset - 1) < 0.001, f"z={z_reset}")
    check("重置后节点弹回派生位置", back[0] < 2 and back[1] < 2, f"偏差={back[0]:.1f},{back[1]:.1f}")

    # ── 12. 选中联动详情栏 ────────────────────────────────────────
    page.locator(".node").nth(7).click()   # W5 failed
    page.wait_for_timeout(200)
    title = page.locator("aside h2").inner_text()
    cur = page.evaluate("() => document.querySelectorAll('.node')[7].dataset.current")
    check("点击节点联动详情栏", "workspace_health" in title and cur == "true", f"title={title!r}")

    # ── 13. 告警节点的处置动作出现 ────────────────────────────────
    page.locator(".node").nth(4).click()   # W3 alarmed
    page.wait_for_timeout(200)
    primary = page.locator("aside .act[data-primary='true']").count()
    check("告警节点给出唤醒动作", primary == 1, f"primary act count={primary}")

    # ── 14. 键盘可达 ─────────────────────────────────────────────
    page.locator(".node").nth(0).focus()
    page.keyboard.press("Enter")
    page.wait_for_timeout(150)
    sel = page.evaluate("() => sel")
    check("节点键盘可选中", sel == "L1", f"sel={sel}")

    page.screenshot(path="D:/04_workspace_rust/cc-book/.claude/fleet-e2e.png")
    browser.close()

print("\n" + "=" * 60)
bad = [r for r in results if not r[0]]
print(f"{len(results)-len(bad)}/{len(results)} 通过")
if errors:
    print(f"\n控制台错误 {len(errors)} 条:")
    for e in errors[:10]:
        print("  -", e)
else:
    print("控制台无错误")
if bad:
    print("\n失败项:")
    for _, name, detail in bad:
        print(f"  ✗ {name}  {detail}")
raise SystemExit(1 if bad or errors else 0)
