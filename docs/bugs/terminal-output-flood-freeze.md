# BUG: 终端打开时大量输出导致卡住

## 状态
- **优先级**: P1
- **状态**: Open
- **发现日期**: 2026-03-26
- **影响平台**: Windows / macOS

## 现象

打开窗口（或重连已有 session）时，如果后端 PTY 已积累大量未读输出，终端会卡住无响应。

**复现步骤**:
1. 启动一个终端 tab，运行长输出命令（如 `cargo build`、`yes`、`cat` 大文件）
2. 在输出过程中关闭窗口或切换到其他 tab
3. 重新打开窗口 / 切回该 tab
4. 终端卡住，UI 无响应

## 可能原因

1. **输出洪泛**: 重连时后端一次性推送大量积压的 PTY 输出到前端，xterm.js `term.write()` 同步处理海量数据，阻塞主线程
2. **无流控**: 前端没有对输入速率做限制（throttle/backpressure），所有数据直接灌入 xterm
3. **WebView 渲染瓶颈**: 大量 DOM 操作（Canvas/WebGL 绘制）在短时间内触发，导致浏览器卡顿

## 建议修复方向

### 方案 A: 输出缓冲 + 分批写入
```typescript
// 在 terminalService.registerOutput 回调中加入分批写入
let buffer = '';
let flushScheduled = false;

onOutput(data) {
  buffer += data;
  if (!flushScheduled) {
    flushScheduled = true;
    requestAnimationFrame(() => {
      term.write(buffer);
      buffer = '';
      flushScheduled = false;
    });
  }
}
```

### 方案 B: 后端限流
- PTY reader 检测积压量，超过阈值时暂停读取或丢弃中间输出
- 只保留最后 N 字节发送给前端

### 方案 C: 重连时截断历史
- 重连 session 时，后端只发送最近 N 行（如 scrollback 大小），跳过中间积压

## 关联

- WebGL 加速（已实施）可部分缓解渲染瓶颈，但不解决主线程数据处理阻塞
- xterm.js 6 的 `term.write()` 内部有 write buffer，但单次灌入过大数据仍会卡住
