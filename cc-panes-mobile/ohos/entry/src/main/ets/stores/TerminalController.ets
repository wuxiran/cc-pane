import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AppConfig } from '../common/Config';
import { TerminalSocket, TerminalSocketListener } from '../services/TerminalSocket';
import { SessionsApi } from '../services/SessionsApi';
import { AuthPhase, authController } from './AuthController';

export enum TerminalPhase {
  Connecting = 'connecting',
  Connected = 'connected',
  Exited = 'exited',
  Error = 'error',
}

/**
 * ArkTS ⇄ WebView(JS) 桥接口，与 UI 层解耦：
 * - write/clear 由 ArkTS 调用（经 runJavaScript 到 xterm，write 已在 controller 侧 8ms 合批）；
 * - onInput/onGeometry 由 Web 组件 javaScriptProxy 调入（用户键入 / fit 尺寸）；
 * - VT 流过桥统一 base64（规避 JSON 转义与 CJK 断裂）。
 */
export interface TerminalBridge {
  /** 向 xterm 写入一段 VT 数据（base64）。 */
  write(b64: string): void;
  /** 清空终端。 */
  clear(): void;
  /** 用户键入（软键盘/onData）。 */
  onInput?: (data: string) => void;
  /** fit 后几何尺寸变化（cols, rows）。 */
  onGeometry?: (cols: number, rows: number) => void;
}

function toBase64(data: string): string {
  let bytes: Uint8Array = new util.TextEncoder().encodeInto(data);
  return new util.Base64Helper().encodeToStringSync(bytes);
}

/** 桥未就绪时缓存输出块的上限（xterm 页加载完成前的高频输出）。 */
const MAX_PENDING_WRITES = 500;

const LOG_DOMAIN = 0x0000;
const LOG_TAG = 'TerminalController';

/**
 * 单个会话的终端状态机（对齐 Dart TerminalSessionController + RefitPolicy）：
 * snapshot 初始化 → 连 WS 收输出流 → 键盘输入经 WS input 回传。
 * Enter 发 \r（CC-Panes PTY 约定）。断开即显示错误状态（自动重连留到 Phase 4）。
 * 输出下发走 8ms 合批（TERMINAL_WRITE_BATCH_MS）：窗口内的多段 VT 输出在字节层
 * （拼原始文本后一次 base64，避免多段 base64 直拼破坏对齐）合并为一次 runJavaScript。
 * 每会话一实例（非单例），离开页面 dispose。
 */
@ObservedV2
export class TerminalSessionController {
  readonly sessionId: string;

  @Trace phase: TerminalPhase = TerminalPhase.Connecting;
  @Trace errorMessage: string | undefined = undefined;
  @Trace exitCode: number | undefined = undefined;
  /** Ctrl 粘滞：点亮后下一个单字符输入转为 ctrl-code。 */
  @Trace ctrlLatched: boolean = false;
  /** 用户是否手动适配过尺寸（opt-in；默认不动共享 PTY，避免破坏桌面端渲染）。 */
  @Trace userFitted: boolean = false;

  private socket: TerminalSocket | undefined = undefined;
  private bridge: TerminalBridge | undefined = undefined;
  /** 桥未就绪时的兜底队列，存原始 VT 段（attach 时合并一次下发）。 */
  private pendingWrites: string[] = [];
  /** 8ms 合批窗口内待下发的原始 VT 段（字节层合并后一次 runJavaScript）。 */
  private batchedWrites: string[] = [];
  private batchTimer: number = -1;
  /** pendingWrites 溢出只报一次（置 error + hilog），之后持续丢头部保尾部。 */
  private overflowReported: boolean = false;
  private resizeTimer: number = -1;
  private lastCols: number = 0;
  private lastRows: number = 0;
  private disposed: boolean = false;
  private starting: boolean = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** 页面进入时调用：先 GET snapshot 缓存，再连 WS；connected 后把 snapshot 经桥下发。 */
  start(): void {
    if (this.starting || this.disposed) {
      return;
    }
    this.starting = true;
    this.doStart();
  }

  private async doStart(): Promise<void> {
    let auth = authController();
    let client = auth.client;
    if (auth.phase !== AuthPhase.Ready || client === undefined) {
      this.setPhase(TerminalPhase.Error, '未连接服务器');
      return;
    }

    // 1. snapshot 初始化（拿不到不阻塞，直接连流）
    let snapshotData: string | undefined = undefined;
    let snapshotResult = await new SessionsApi(client).snapshot(this.sessionId);
    if (this.disposed) {
      return;
    }
    if (snapshotResult.ok && snapshotResult.value !== undefined && snapshotResult.value.length > 0) {
      snapshotData = snapshotResult.value;
    }

    // 2. 连 WebSocket（握手带 Cookie）
    let connected: TerminalSocket;
    try {
      let cookie: string | undefined = await client.sessionCookieHeader();
      connected = await TerminalSocket.connect(client.baseUrl(), this.sessionId, cookie);
    } catch (err) {
      if (this.disposed) {
        return;
      }
      let message: string = err instanceof Error && err.message !== undefined ? err.message : `${err}`;
      this.setPhase(TerminalPhase.Error, `连接终端流失败: ${message}`);
      return;
    }
    if (this.disposed) {
      connected.close();
      return;
    }
    this.socket = connected;
    this.attachSocket(connected);
    this.setPhase(TerminalPhase.Connected);
    if (snapshotData !== undefined) {
      this.writeOutput(snapshotData);
    }
  }

  private attachSocket(socket: TerminalSocket): void {
    let listener: TerminalSocketListener = {
      onOutput: (data: string): void => {
        this.writeOutput(data);
      },
      onExit: (exitCode: number | undefined): void => {
        this.exitCode = exitCode;
        this.setPhase(TerminalPhase.Exited);
      },
      onError: (message: string): void => {
        if (this.phase === TerminalPhase.Connected) {
          this.setPhase(TerminalPhase.Error, `终端流中断: ${message}`);
        }
      },
      onClosed: (): void => {
        if (this.phase === TerminalPhase.Connected) {
          this.setPhase(TerminalPhase.Error, '终端流已断开');
        }
      }
    };
    socket.setListener(listener);
  }

  /** UI 层在 Web 组件就绪后注入桥；注入时冲排积压输出（与合批窗口内未下发段按序合并，一次下发）。 */
  attachBridge(bridge: TerminalBridge): void {
    if (this.disposed) {
      return;
    }
    this.bridge = bridge;
    bridge.onInput = (data: string): void => {
      this.handleInput(data);
    };
    bridge.onGeometry = (cols: number, rows: number): void => {
      this.requestResize(cols, rows);
    };
    if (this.batchTimer >= 0) {
      clearTimeout(this.batchTimer);
      this.batchTimer = -1;
    }
    let chunks: string[] = this.pendingWrites.concat(this.batchedWrites);
    this.pendingWrites = [];
    this.batchedWrites = [];
    if (chunks.length > 0) {
      bridge.write(toBase64(chunks.join('')));
    }
  }

  /** 用户键入（软键盘）：只读丢弃；Ctrl 粘滞下单字母转 ctrl-code（对齐 Dart _handleUserInput）。 */
  handleInput(data: string): void {
    if (authController().readOnly()) {
      return;
    }
    let out: string = data;
    if (this.ctrlLatched && data.length === 1) {
      let code: number = data.toLowerCase().charCodeAt(0);
      if (code >= 0x61 && code <= 0x7a) {
        out = String.fromCharCode(code - 0x60);
      }
      this.ctrlLatched = false;
    }
    if (this.socket !== undefined) {
      this.socket.sendInput(out);
    }
  }

  /** 快捷键条直发原始序列（Esc/Tab/^C/方向键/Enter(\r)/斜杠/波浪号）。 */
  sendSequence(sequence: string): void {
    this.handleInput(sequence);
  }

  toggleCtrl(): void {
    this.ctrlLatched = !this.ctrlLatched;
  }

  /** 用户手动点「适配尺寸」：立即按当前尺寸下发 resize 并开启后续自动跟随。 */
  fitNow(cols: number, rows: number): void {
    this.userFitted = true;
    this.sendResizeNow(cols, rows);
  }

  /** opt-in 的尺寸跟随（旋转/键盘/fit 变化）：未手动适配过则忽略；300ms 去抖合并。 */
  requestResize(cols: number, rows: number): void {
    this.lastCols = cols;
    this.lastRows = rows;
    if (!this.userFitted) {
      return;
    }
    if (this.resizeTimer >= 0) {
      clearTimeout(this.resizeTimer);
    }
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = -1;
      this.sendResizeNow(this.lastCols, this.lastRows);
    }, AppConfig.RESIZE_DEBOUNCE_MS);
  }

  markUserFitted(): void {
    this.userFitted = true;
  }

  private sendResizeNow(cols: number, rows: number): void {
    if (this.disposed || this.phase !== TerminalPhase.Connected) {
      return;
    }
    if (cols <= 0 || rows <= 0) {
      return;
    }
    if (this.socket !== undefined) {
      this.socket.sendResize(cols, rows);
    }
  }

  /**
   * 输出缓冲（原始 VT 文本）：桥未就绪入 pendingWrites 等 attach；
   * 就绪后进 8ms 合批窗口，窗口到期一次下发（字节层合并，保持顺序，无丢块）。
   */
  private writeOutput(data: string): void {
    if (this.disposed) {
      return;
    }
    let bridge: TerminalBridge | undefined = this.bridge;
    if (bridge === undefined) {
      this.bufferPending(data);
      return;
    }
    this.batchedWrites.push(data);
    if (this.batchTimer < 0) {
      this.batchTimer = setTimeout((): void => {
        this.batchTimer = -1;
        this.flushWrites();
      }, AppConfig.TERMINAL_WRITE_BATCH_MS);
    }
  }

  /** 桥未就绪时的兜底入队；超上限置 error + hilog（各一次），并丢头部保尾部（贴近实时）。 */
  private bufferPending(data: string): void {
    if (this.pendingWrites.length >= MAX_PENDING_WRITES) {
      if (!this.overflowReported) {
        this.overflowReported = true;
        hilog.warn(LOG_DOMAIN, LOG_TAG,
          'pendingWrites overflow (session %{public}s): drop head to keep tail', this.sessionId);
        this.setPhase(TerminalPhase.Error, '终端页加载超时，输出缓冲溢出');
      }
      this.pendingWrites.shift();
    }
    this.pendingWrites.push(data);
  }

  /** 强制冲排合批窗口：attachBridge / clearTerminal / phase→exit|error / dispose 时调用。 */
  private flushWrites(): void {
    if (this.batchTimer >= 0) {
      clearTimeout(this.batchTimer);
      this.batchTimer = -1;
    }
    let chunks: string[] = this.batchedWrites;
    this.batchedWrites = [];
    if (chunks.length === 0 || this.disposed) {
      return;
    }
    let bridge: TerminalBridge | undefined = this.bridge;
    if (bridge === undefined) {
      // 桥中途被摘：回落到 pending 队列等下次 attach，不丢块。
      for (let chunk of chunks) {
        this.bufferPending(chunk);
      }
      return;
    }
    bridge.write(toBase64(chunks.join('')));
  }

  /** 清空终端显示（重连场景），仅转发的桥命令。 */
  clearTerminal(): void {
    this.flushWrites();
    if (this.bridge !== undefined) {
      this.bridge.clear();
    }
  }

  private setPhase(next: TerminalPhase, message?: string): void {
    // exit/error 前强制冲排：末段输出先落屏，再显示状态横幅。
    if (next === TerminalPhase.Exited || next === TerminalPhase.Error) {
      this.flushWrites();
    }
    this.phase = next;
    this.errorMessage = message;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.batchTimer >= 0) {
      clearTimeout(this.batchTimer);
      this.batchTimer = -1;
    }
    this.batchedWrites = [];
    if (this.resizeTimer >= 0) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = -1;
    }
    let socket: TerminalSocket | undefined = this.socket;
    this.socket = undefined;
    if (socket !== undefined) {
      socket.close();
    }
    let bridge: TerminalBridge | undefined = this.bridge;
    this.bridge = undefined;
    if (bridge !== undefined) {
      bridge.onInput = undefined;
      bridge.onGeometry = undefined;
    }
  }
}
