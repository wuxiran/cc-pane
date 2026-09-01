import { AppNav } from '../common/Nav';
import { currentTheme } from '../common/Theme';
import { authController, AuthPhase } from '../stores/AuthController';
import { ConnectPage, describeAuthFailure } from './ConnectPage';
import { MirrorHomePage } from './MirrorHomePage';
import { TerminalPage } from './TerminalPage';

/**
 * 根路由（对齐 Flutter main.dart _Root）：
 * noProfile/failed → ConnectPage（failed 带 _describeFailure 文案）；
 * connecting/启动中 → 全屏 LoadingProgress；ready → MirrorHomePage。
 * 终端页经 Navigation(AppNav.stack) 命令式跳转，参数约定
 * { sessionId: string, title: string }（TerminalPage 内从 AppNav.stack 取参）。
 */
@Entry
@ComponentV2
struct Index {
  /** bootstrap() 完成前先显示 loading，避免 NoProfile 闪现连接页。 */
  @Local booted: boolean = false;

  aboutToAppear(): void {
    let auth = authController();
    auth.bootstrap().then((): void => {
      this.booted = true;
    }).catch((): void => {
      this.booted = true;
    });
  }

  onBackPress(): boolean {
    if (AppNav.stack.size() > 0) {
      AppNav.stack.pop();
      return true;
    }
    return false;
  }

  @Builder
  loadingBody() {
    Column() {
      LoadingProgress()
        .width(36)
        .height(36)
        .color(currentTheme().primary)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  navDest(name: string) {
    if (name === AppNav.ROUTE_TERMINAL) {
      TerminalPage()
    }
  }

  build() {
    Navigation(AppNav.stack) {
      if (!this.booted || authController().phase === AuthPhase.Connecting) {
        this.loadingBody()
      } else if (authController().phase === AuthPhase.Ready) {
        MirrorHomePage()
      } else {
        ConnectPage({ failureText: describeAuthFailure(authController().failure) })
      }
    }
    .navDestination(this.navDest)
    .mode(NavigationMode.Stack)
    .hideTitleBar(true)
    .hideToolBar(true)
    .backgroundColor(currentTheme().background)
  }
}
