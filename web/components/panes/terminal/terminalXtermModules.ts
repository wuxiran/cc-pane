// xterm 懒加载边界：@xterm/* 本体（gzip ~123kB）在运行时代码里的唯一取值入口。
//
// 首屏最后一个重依赖。TerminalView 组件本体保持同步挂载（keep-alive / 延迟恢复 /
// 星标镜像的挂载时序不变），只有 xterm 模块经这里动态 import——本任务只改
// 「模块何时加载」，不改「加载后做什么」。
//
// 边界规则（由 editor/lazyBoundaries.test.ts 钉住）：
//   - 其余文件一律 `import type`（编译期擦除，不构成运行时依赖）；
//   - 取值（构造器 / css / 渲染器控制器）只能经 loadXtermRuntime()。
//
// terminalRendererController 本体没有 @xterm 之外的依赖，但它静态值引用
// @xterm/addon-webgl（WebglAddon 构造器），且 dev/WebglReproLab 依赖其现有签名，
// 所以整个控制器模块随这次动态 import 一起进入异步 chunk——控制器源码一行不动。
//
// 结果靠模块级 Promise 缓存共享：N 个终端同时挂载只触发一轮取回（浏览器 module
// map 本身也去重，这层缓存主要为失败复位服务）。失败不缓存——module map 会把
// 取回失败按 URL 永久记住，清掉本地缓存至少保证「卸载重挂 / 休眠唤醒」整条
// init 重跑时能拿到一个全新的 Promise（dev server 抖动后靠 HMR 全量重载自愈）。
import type { createTerminalRendererController } from "../terminalRendererController";

export interface XtermRuntime {
  Terminal: (typeof import("@xterm/xterm"))["Terminal"];
  FitAddon: (typeof import("@xterm/addon-fit"))["FitAddon"];
  SerializeAddon: (typeof import("@xterm/addon-serialize"))["SerializeAddon"];
  Unicode11Addon: (typeof import("@xterm/addon-unicode11"))["Unicode11Addon"];
  createTerminalRendererController: typeof createTerminalRendererController;
}

let runtimePromise: Promise<XtermRuntime> | null = null;

export function loadXtermRuntime(): Promise<XtermRuntime> {
  if (!runtimePromise) {
    runtimePromise = Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-serialize"),
      import("@xterm/addon-unicode11"),
      // xterm.css 与 JS 同 chunk 取回并在构造 Terminal 前就绪——样式只作用于
      // xterm 自建 DOM，首屏有没有它对其余界面零影响，加载完成后逐像素一致。
      import("@xterm/xterm/css/xterm.css"),
      import("../terminalRendererController"),
    ]).then(([xterm, fitAddon, serializeAddon, unicode11Addon, , rendererController]) => ({
      Terminal: xterm.Terminal,
      FitAddon: fitAddon.FitAddon,
      SerializeAddon: serializeAddon.SerializeAddon,
      Unicode11Addon: unicode11Addon.Unicode11Addon,
      createTerminalRendererController: rendererController.createTerminalRendererController,
    }));
    runtimePromise.catch(() => {
      runtimePromise = null;
    });
  }
  return runtimePromise;
}
