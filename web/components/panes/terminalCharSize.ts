// 字体晚就绪后的格宽重测。
//
// xterm 的 CharSizeService 只在 fontFamily / fontSize 选项变化或 DPR 变化时重测。
// 启动时等字体有 1.5s 超时，超时后格宽按回退字体量好；目标字体随后到达时，清图集
// 只会让字形换成新字体，格宽还停在旧字体上——字母挤在一起、右缘被裁、中文重叠。
// 低配机、机械盘、杀软扫描、同时恢复很多标签时最容易撞上。
import type { Terminal } from "@xterm/xterm";

interface CharSizeInternals {
  _core?: { _charSizeService?: { measure?: () => void } };
}

/** 用当前已加载的字体重新量一次单元格。量到新尺寸时 xterm 自己会通知渲染器。 */
export function remeasureTerminalCharSize(term: Terminal): boolean {
  const service = (term as unknown as CharSizeInternals)._core?._charSizeService;
  if (typeof service?.measure !== "function") return false;
  try {
    service.measure();
    return true;
  } catch {
    return false;
  }
}

interface FontFaceSetLike {
  addEventListener(type: "loadingdone", listener: () => void): void;
  removeEventListener(type: "loadingdone", listener: () => void): void;
  check?(font: string): boolean;
}

/**
 * 监听字体加载完成，每次都回调一次；直到终端配置的字体真的就绪才停止监听。
 * 先完成的可能是界面字体（Inter），那时就摘掉监听的话，终端字体到达时已无人处理。
 */
export function bindTerminalFontLoadingDone(
  fonts: FontFaceSetLike,
  getTerminal: () => Terminal | null,
  onFontsLoaded: (term: Terminal) => void,
): () => void {
  const handleLoadingDone = () => {
    const term = getTerminal();
    if (!term) return;
    onFontsLoaded(term);
    let ready = true;
    try {
      ready = fonts.check?.(`${term.options.fontSize}px ${term.options.fontFamily}`) ?? true;
    } catch {
      // 字体串解析失败时不再等，避免监听永远挂着。
    }
    if (ready) fonts.removeEventListener("loadingdone", handleLoadingDone);
  };
  fonts.addEventListener("loadingdone", handleLoadingDone);
  return () => fonts.removeEventListener("loadingdone", handleLoadingDone);
}

/**
 * 终端当前配置的字体还没加载完时才挂监听（已就绪返回 null）。
 * 设置里切换到一个加载慢的字体：等待超时后先用回退字体量了格宽，而启动时那个监听
 * 早已在上一个字体就绪时摘除——不重新挂的话，目标字体到达时没人重测。
 */
export function bindTerminalFontIfPending(
  fonts: FontFaceSetLike,
  getTerminal: () => Terminal | null,
  onFontsLoaded: (term: Terminal) => void,
): (() => void) | null {
  const term = getTerminal();
  if (!term) return null;
  try {
    if (fonts.check?.(`${term.options.fontSize}px ${term.options.fontFamily}`) ?? true) return null;
  } catch {
    return null;
  }
  return bindTerminalFontLoadingDone(fonts, getTerminal, onFontsLoaded);
}

