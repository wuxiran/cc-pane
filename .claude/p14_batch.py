# -*- coding: utf-8 -*-
import io, sys

def patch(p, pairs, must=True):
    s = io.open(p, encoding='utf-8').read()
    for old, new in pairs:
        if old not in s:
            if must:
                print("MISS in %s:\n---\n%s\n---" % (p, old[:120])); sys.exit(2)
            continue
        s = s.replace(old, new, 1)
    io.open(p, 'w', encoding='utf-8').write(s)
    print("patched %s" % p)

TV = 'web/components/panes/TerminalView.tsx'
patch(TV, [
  ('''  /** Whether this tab is the selected tab in its panel and is visible on screen. */
  isVisible?: boolean;
  /** Whether this terminal belongs to the currently focused pane. */
  isActive: boolean;
  /** Whether this terminal belongs to the current top-level layout. */
  layoutActive?: boolean;''',
   '''  /**
   * Whether this terminal belongs to the current top-level layout.
   * 独立于可见性单源的 layout 级判据（后台布局的延迟恢复语义靠它，store
   * 三档不表达「为什么不可见」）。
   */
  layoutActive?: boolean;'''),
  ('''    const isActiveRef = useRef(props.isActive);
    const isVisibleRef = useRef(props.isVisible ?? props.isActive);
    const layoutActiveRef = useRef(props.layoutActive ?? true);''',
   '''    const layoutActiveRef = useRef(props.layoutActive ?? true);'''),
  ('''        cliTool: effectiveCliTool,
        isActive: props.isActive,
        isVisible: props.isVisible ?? props.isActive,
        layoutActive: props.layoutActive ?? true,''',
   '''        cliTool: effectiveCliTool,
        layoutActive: props.layoutActive ?? true,'''),
  ('''    }, [
      effectiveCliTool,
      props.isActive,
      props.isVisible,
      props.layoutActive,
      props.paneId,
      props.projectPath,
      props.sessionId,
      props.tabId,
    ]);''',
   '''    }, [
      effectiveCliTool,
      props.layoutActive,
      props.paneId,
      props.projectPath,
      props.sessionId,
      props.tabId,
    ]);'''),
  ('''     * hidden，故等价覆盖旧 `isVisible && layoutActive` 组合。store 条目未登记
     * （首帧上报未跑 / MobilePrototype 迁移期无写侧）退回旧 ref。
     */
    const isRenderVisible = useCallback(() => {
      const owner = props.visibilityOwnerId;
      if (!owner) return isVisibleRef.current && layoutActiveRef.current;
      const v = useTabViewStateStore
        .getState()
        .getViewVisibility(owner, props.viewRole ?? "primary");
      if (v === undefined) return isVisibleRef.current && layoutActiveRef.current;
      return v !== "hidden";
    }, [props.visibilityOwnerId, props.viewRole]);''',
   '''     * hidden，故等价覆盖旧 `isVisible && layoutActive` 组合。store 条目未登记
     * （首帧上报未跑）用 layout 级判据兜底——后台布局启动期不多渲。
     */
    const isRenderVisible = useCallback(() => {
      const owner = props.visibilityOwnerId;
      if (!owner) return layoutActiveRef.current;
      const v = useTabViewStateStore
        .getState()
        .getViewVisibility(owner, props.viewRole ?? "primary");
      if (v === undefined) return layoutActiveRef.current;
      return v !== "hidden";
    }, [props.visibilityOwnerId, props.viewRole]);'''),
  ('''    const isViewActive = useCallback(() => {
      return resolveViewFocus(props.visibilityOwnerId, props.viewRole, () => isActiveRef.current);
    }, [props.visibilityOwnerId, props.viewRole]);''',
   '''    const isViewActive = useCallback(() => {
      // 条目未登记（首帧）放行：refit 被误跳过的代价高于多 refit 一次
      return resolveViewFocus(props.visibilityOwnerId, props.viewRole, () => true);
    }, [props.visibilityOwnerId, props.viewRole]);'''),
  ('''      isActiveRef.current = props.isActive;
      const wasRenderVisible = isRenderVisible();
      isVisibleRef.current = props.isVisible ?? props.isActive;
      layoutActiveRef.current = props.layoutActive ?? true;
      // 由隐藏转可见：把积压一次性补上。积压补投共三道防线，覆盖各不相同：
      //   - drain-on-push：可见性翻转与数据到达的**竞态**（顺序不由本模块定）
      //   - store 单视图边沿订阅（下方 useViewVisibilityEdgeSubscription）：
      //     **静默会话**本视图翻可见时的补投——聚合 anyVisible 在镜像常开时
      //     没有边沿，必须听单视图
      //   - 本处 props 边沿：MobilePrototype 迁移期兜底（无 store 写侧，
      //     isRenderVisible 退回旧 ref 才有边沿），写侧补齐后随三 ref 一起删
      if (!wasRenderVisible && isRenderVisible()) {
        flushHiddenWrites("visibility.gained");
      }
      // 后台分层降档''',
   '''      layoutActiveRef.current = props.layoutActive ?? true;
      // 积压补投两道防线（docs/78）：drain-on-push 管「可见性翻转与数据到达的
      // 竞态」；store 单视图边沿订阅（useViewVisibilityEdgeSubscription）管
      // 「静默会话本视图翻可见时的补投」。两者覆盖不同，删任一都丢字。
      // 后台分层降档'''),
  ('''
      // 可见性双写断言（dev only，只打日志不抛错）
      checkVisibilityDrift(props.visibilityOwnerId, props.viewRole, isRenderVisible(), isActiveRef.current);
    });''',
   '''
    });'''),
  ('''import { checkVisibilityDrift } from "./visibilityDriftAssert";
''', ''),
  ('''          // 焦点判据改读单源（**不是**降档的 anyVisible——这里问的是
          // 「本视图是不是焦点」，决定要不要 refit）。无 owner 时退回旧 ref。
          isActive: () =>
            resolveViewFocus(props.visibilityOwnerId, props.viewRole, () => isActiveRef.current),''',
   '''          // 焦点判据改读单源（**不是**降档的 anyVisible——这里问的是
          // 「本视图是不是焦点」，决定要不要 refit）。条目未登记放行。
          isActive: () =>
            resolveViewFocus(props.visibilityOwnerId, props.viewRole, () => true),'''),
])

patch('web/components/panes/TerminalTabContent.tsx', [
  ('''interface TerminalTabContentProps {
  tab: Tab;
  isVisible: boolean;
  isActive: boolean;
  layoutActive: boolean;''',
   '''interface TerminalTabContentProps {
  tab: Tab;
  layoutActive: boolean;'''),
  ('''              isVisible={isVisible}
              isActive={isActive && tab.activeTerminalPaneId === leaf.id}
              layoutActive={layoutActive}
              leafFocused={tab.activeTerminalPaneId === leaf.id}''',
   '''              layoutActive={layoutActive}
              leafFocused={tab.activeTerminalPaneId === leaf.id}'''),
  ('''              enabled={isVisible && layoutActive}''',
   '''              enabled={primaryViewVisible}'''),
])

patch('web/components/panes/TabContentRenderer.tsx', [
  ('''interface TabContentRendererProps {
  tab: Tab;
  isVisible: boolean;
  isActive: boolean;
  layoutActive: boolean;''',
   '''interface TabContentRendererProps {
  tab: Tab;
  layoutActive: boolean;'''),
])

patch('web/components/panes/Panel.tsx', [
  ('''            <TabContentRenderer
              tab={tab}
              isVisible={layoutVisible && tab.id === pane.activeTabId}
              isActive={layoutVisible && tab.id === pane.activeTabId && isActivePane}
              layoutActive={layoutVisible}''',
   '''            <TabContentRenderer
              tab={tab}
              layoutActive={layoutVisible}'''),
])

patch('web/components/panes/StarredMirrorTile.tsx', [
  ('''            isActive={layoutVisible}
            isVisible={layoutVisible}
            layoutActive={layoutVisible}''',
   '''            layoutActive={layoutVisible}'''),
])

patch('web/components/mobile/MobilePrototype.tsx', [
  ('''          <TerminalTabContent
            tab={terminal.tab}
            isVisible
            isActive
            layoutActive''',
   '''          <TerminalTabContent
            tab={terminal.tab}
            layoutActive'''),
])

print('ALL OK')
