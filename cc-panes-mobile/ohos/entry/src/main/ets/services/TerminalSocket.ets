import { webSocket as websocket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { AppConfig } from '../common/Config';
import { asRecord } from '../common/Json';

/**
 * 服务器 → 客户端事件回调（下行 output/exit、错误与断开）。
 * 成员声明为函数属性风格：ArkTS 严格模式要求实现方用对象字面量按属性赋值
 * （方法声明风格的 interface 成员不能被对象字面量实现，arkts-no-untyped-obj-literals）。
 */
export interface TerminalSocketListener {
  onOutput: (data: string) => void;
  onExit: (exitCode: number | undefined) => void;
  onError: (message: string) => void;
  onClosed: () => void;
}

/**
 * /ws/{sessionId} 终端流（对齐 Dart terminal_socket.dart）：
 * - ws(s) URL：http→ws / https→wss，path 换为 /ws/{sessionId}；
 * - 握手带 Cookie（ccp_web_session），与 REST 同一会话；超时 10s；
 * - 下行 {"type":"output","data"} / {"type":"exit","exitCode"}，坏帧静默丢弃；
 * - 上行 {"type":"input","data"} / {"type":"resize","cols","rows"}。
 */
export class TerminalSocket {
  private readonly ws: websocket.WebSocket;
  private listener: TerminalSocketListener | undefined;

  private constructor(ws: websocket.WebSocket) {
    this.ws = ws;
  }

  static async connect(
    baseUrl: string,
    sessionId: string,
    cookieHeader: string | undefined
  ): Promise<TerminalSocket> {
    let url: string = toWsUrl(baseUrl, sessionId);
    let ws: websocket.WebSocket = websocket.createWebSocket();
    let socket: TerminalSocket = new TerminalSocket(ws);
    ws.on('message', (err: BusinessError, value: string | ArrayBuffer) => {
      if (err) {
        return;
      }
      socket.handleMessage(value);
    });
    ws.on('close', (err: BusinessError, value: websocket.CloseResult) => {
      socket.handleClosed();
    });
    ws.on('error', (err: BusinessError) => {
      let message: string = err !== undefined && err.message !== undefined && err.message.length > 0
        ? err.message
        : '连接错误';
      socket.handleError(message);
    });
    await socket.doConnect(url, cookieHeader);
    return socket;
  }

  setListener(listener: TerminalSocketListener): void {
    this.listener = listener;
  }

  sendInput(data: string): void {
    let frame: Record<string, Object> = {
      'type': 'input',
      'data': data
    };
    this.ws.send(JSON.stringify(frame)).catch(() => {
    });
  }

  sendResize(cols: number, rows: number): void {
    let frame: Record<string, Object> = {
      'type': 'resize',
      'cols': cols,
      'rows': rows
    };
    this.ws.send(JSON.stringify(frame)).catch(() => {
    });
  }

  close(): void {
    try {
      this.ws.off('message');
      this.ws.off('close');
      this.ws.off('error');
    } catch (err) {
    }
    try {
      this.ws.close().catch(() => {
      });
    } catch (err) {
    }
  }

  private doConnect(url: string, cookieHeader: string | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled: boolean = false;
      let timer: number = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error('连接超时'));
        try {
          this.ws.close().catch(() => {
          });
        } catch (err) {
        }
      }, AppConfig.WS_CONNECT_TIMEOUT_MS);
      let header: Record<string, string> = {};
      if (cookieHeader !== undefined) {
        header['Cookie'] = cookieHeader;
      }
      this.ws.connect(url, { header: header }, (err: BusinessError, value: boolean) => {
        if (settled) {
          return;
        }
        if (err || !value) {
          settled = true;
          clearTimeout(timer);
          let message: string = err !== undefined && err.message !== undefined && err.message.length > 0
            ? err.message
            : '连接失败';
          reject(new Error(message));
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private handleMessage(value: string | ArrayBuffer | string[]): void {
    if (typeof value !== 'string') {
      return; // 非文本帧静默丢弃
    }
    let rec: Record<string, Object> | undefined;
    try {
      rec = asRecord(JSON.parse(value) as Object | null);
    } catch (err) {
      return; // 坏 JSON 帧静默丢弃
    }
    if (rec === undefined) {
      return;
    }
    let type: Object | undefined = rec['type'];
    if (typeof type !== 'string') {
      return;
    }
    if (type === 'output') {
      let data: Object | undefined = rec['data'];
      if (this.listener !== undefined) {
        this.listener.onOutput(typeof data === 'string' ? data as string : '');
      }
      return;
    }
    if (type === 'exit') {
      let exitCode: Object | undefined = rec['exitCode'];
      if (this.listener !== undefined) {
        this.listener.onExit(typeof exitCode === 'number' ? exitCode as number : undefined);
      }
      return;
    }
    // 其余帧类型静默丢弃（对齐 Dart switch default → null）
  }

  private handleError(message: string): void {
    if (this.listener !== undefined) {
      this.listener.onError(message);
    }
  }

  private handleClosed(): void {
    if (this.listener !== undefined) {
      this.listener.onClosed();
    }
  }
}

/** http(s)://host[:port][/path] → ws(s)://host[:port]/ws/{sessionId}。 */
export function toWsUrl(baseUrl: string, sessionId: string): string {
  let scheme: string = 'ws';
  let rest: string = baseUrl;
  if (rest.startsWith('https://')) {
    scheme = 'wss';
    rest = rest.substring('https://'.length);
  } else if (rest.startsWith('http://')) {
    rest = rest.substring('http://'.length);
  }
  let authority: string = rest;
  let slash: number = rest.indexOf('/');
  if (slash >= 0) {
    authority = rest.substring(0, slash);
  }
  return `${scheme}://${authority}/ws/${sessionId}`;
}
