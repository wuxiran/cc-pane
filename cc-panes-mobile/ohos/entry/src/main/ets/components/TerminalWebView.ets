import web_webview from '@ohos.web.webview';
import { TERMINAL_BG } from '../common/Theme';
import { TerminalBridge, TerminalSessionController } from '../stores/TerminalController';

/**
 * TerminalBridge 的 Web 实现：ArkTS → JS 方向，经 runJavaScript 驱动页面内 window.ccpTerm。
 * VT 流过桥统一 base64（字符集 [A-Za-z0-9+/=]，嵌入 JS 字符串字面量无需转义）。
 * 页面未就绪/已销毁时的注入失败静默忽略——输出由 controller 的 pendingWrites 兜底。
 */
class WebTerminalBridge implements TerminalBridge {
  private readonly webCtrl: web_webview.WebviewController;
  /** 由 TerminalSessionController.attachBridge 赋值（JS onInput 转发目标）。 */
  onInput?: (data: string) => void;
  /** 由 TerminalSessionController.attachBridge 赋值（JS onGeometry 转发目标）。 */
  onGeometry?: (cols: number, rows: number) => void;

  constructor(webCtrl: web_webview.WebviewController) {
    this.webCtrl = webCtrl;
  }

  write(b64: string): void {
    this.run(`window.ccpTerm && window.ccpTerm.write("${b64}")`);
  }

  clear(): void {
    this.run('window.ccpTerm && window.ccpTerm.clear()');
  }

  /** 重算 cols/rows（页面内 fit 后会回调 onGeometry，只影响本地渲染）。 */
  fit(): void {
    this.run('window.ccpTerm && window.ccpTerm.fit()');
  }

  /** 整机复位显示（Web 桥扩展能力，TerminalBridge 接口未要求）。 */
  reset(): void {
    this.run('window.ccpTerm && window.ccpTerm.reset()');
  }

  private run(script: string): void {
    try {
      this.webCtrl.runJavaScript(script).catch((): void => {
      });
    } catch (err) {
      // 控制器尚未 attach / 页面已销毁：runJavaScript 同步抛错时静默。
    }
  }
}

/**
 * javaScriptProxy 注入对象（页面内 window.ccpBridge）：
 * ArkWeb 限制——object 必须是 class 实例且 methodList 内为普通方法；
 * 事件回调经字段转发（箭头函数属性不在 methodList 内，不受该限制约束）。
 */
class CcpBridgeProxy {
  onReadyEvent: () => void = (): void => {
  };
  onInputEvent: (data: string) => void = (_data: string): void => {
  };
  onGeometryEvent: (cols: number, rows: number) => void = (_cols: number, _rows: number): void => {
  };

  onReady(): void {
    this.onReadyEvent();
  }

  onInput(data: string): void {
    this.onInputEvent(data);
  }

  onGeometry(cols: number, rows: number): void {
    this.onGeometryEvent(cols, rows);
  }
}

/**
 * 终端 WebView 封装：加载 rawfile/terminal/index.html，承担 ArkTS ⇄ JS 双向桥。
 * 生命周期由 TerminalPage 控制（start/dispose 在页面侧），本组件只管桥的挂接与转发：
 * - JS onReady / onPageEnd → controller.attachBridge（幂等，冲排积压输出）；
 * - JS onInput → controller.handleInput（经 bridge.onInput 回调）；
 * - JS onGeometry → controller.requestResize（经 bridge.onGeometry 回调）+ 页面回调；
 * - 容器尺寸变化（旋转/软键盘避让）→ 主动触发页面内 fit 重算 cols/rows。
 */
@ComponentV2
export struct TerminalWebView {
  @Param @Require controller: TerminalSessionController;
  /** 页面侧订阅当前 cols/rows（供「适配尺寸」按钮取当前几何）。 */
  @Param onGeometryChange: (cols: number, rows: number) => void =
    (_cols: number, _rows: number): void => {
    };

  private webCtrl: web_webview.WebviewController = new web_webview.WebviewController();
  private bridgeImpl: WebTerminalBridge | undefined = undefined;
  private proxy: CcpBridgeProxy = new CcpBridgeProxy();
  private attachedTo: TerminalSessionController | undefined = undefined;

  aboutToAppear(): void {
    this.bridgeImpl = new WebTerminalBridge(this.webCtrl);
    this.proxy.onReadyEvent = (): void => {
      this.ensureAttached();
    };
    this.proxy.onInputEvent = (data: string): void => {
      let bridge: WebTerminalBridge | undefined = this.bridgeImpl;
      if (bridge !== undefined && bridge.onInput !== undefined) {
        bridge.onInput(data);
      }
    };
    this.proxy.onGeometryEvent = (cols: number, rows: number): void => {
      let bridge: WebTerminalBridge | undefined = this.bridgeImpl;
      if (bridge !== undefined && bridge.onGeometry !== undefined) {
        bridge.onGeometry(cols, rows);
      }
      this.onGeometryChange(cols, rows);
    };
  }

  /** controller 引用变更（页面重连换新实例）时把新实例重新挂到 Web 桥。 */
  @Monitor('controller')
  onControllerChange(monitor: IMonitor): void {
    this.ensureAttached();
  }

  build() {
    Web({ src: $rawfile('terminal/index.html'), controller: this.webCtrl })
      .javaScriptAccess(true)
      .zoomAccess(false)
      .javaScriptProxy({
        object: this.proxy,
        name: 'ccpBridge',
        methodList: ['onReady', 'onInput', 'onGeometry'],
        controller: this.webCtrl
      })
      .onPageEnd((): void => {
        // JS onReady 的兜底：两者都幂等，先到先挂。
        this.ensureAttached();
      })
      .onSizeChange((oldValue: SizeResult, newValue: SizeResult): void => {
        if (oldValue.width === newValue.width && oldValue.height === newValue.height) {
          return;
        }
        // 旋转/软键盘避让后重算 cols/rows；下发 resize 由 controller 的
        // userFitted 门控 + 300ms 去抖（RESIZE_DEBOUNCE_MS）兜住。
        let bridge: WebTerminalBridge | undefined = this.bridgeImpl;
        if (bridge !== undefined) {
          bridge.fit();
        }
      })
      .width('100%')
      .height('100%')
      .backgroundColor(TERMINAL_BG)
  }

  private ensureAttached(): void {
    let bridge: WebTerminalBridge | undefined = this.bridgeImpl;
    if (bridge === undefined) {
      return;
    }
    let controller: TerminalSessionController = this.controller;
    if (this.attachedTo === controller) {
      return;
    }
    this.attachedTo = controller;
    controller.attachBridge(bridge);
  }
}
