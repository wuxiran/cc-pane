/**
 * 全局导航栈：命令式 push 对齐 Flutter 的 Navigator.push。
 * 约定路由名 'terminal'，参数 { sessionId: string, title: string }。
 * 注：NavPathStack 是 ArkUI 全局声明类型（component/navigation.d.ts，ambient），
 * 不经 @kit.ArkUI 导出，直接引用即可，无需 import。
 */
export class AppNav {
  static readonly ROUTE_TERMINAL: string = 'terminal';
  static stack: NavPathStack = new NavPathStack();
}
