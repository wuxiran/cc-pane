/**
 * 展示格式化辅助（对齐 Flutter 版 mirror_card/session_tile/mirror_home_screen 的文案逻辑）。
 */

/**
 * 项目显示名：路径最后一段（Windows 反斜杠 / POSIX 正斜杠都兼容）。
 * 等价 Dart `path.split(RegExp(r'[/\]')).where(isNotEmpty).last`。
 */
export function pathBasename(path: string): string {
  let parts: string[] = path.split('\\').join('/').split('/');
  let nonEmpty: string[] = [];
  for (let part of parts) {
    if (part.length > 0) {
      nonEmpty.push(part);
    }
  }
  return nonEmpty.length === 0 ? path : nonEmpty[nonEmpty.length - 1];
}

/**
 * 相对时间（对齐 mirror_home_screen._ago）：
 * <10s 刚刚 / <60s N 秒前 / <60min N 分钟前 / 其余 N 小时前。
 */
export function relativeTime(fromMs: number, nowMs: number): string {
  let diffSec: number = Math.floor((nowMs - fromMs) / 1000);
  if (diffSec < 10) {
    return '刚刚';
  }
  if (diffSec < 60) {
    return `${diffSec} 秒前`;
  }
  let diffMin: number = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin} 分钟前`;
  }
  return `${Math.floor(diffMin / 60)} 小时前`;
}

/** 原始状态枚举 → 中文标签；未知值原样透传（服务端枚举可能扩展）。 */
export function statusLabel(status: string): string {
  switch (status) {
    case 'initializing':
      return '启动中';
    case 'active':
      return '运行中';
    case 'idle':
      return '空闲';
    case 'thinking':
      return '思考中';
    case 'toolRunning':
      return '工具执行中';
    case 'compacting':
      return '压缩上下文';
    case 'waitingInput':
      return '等待输入';
    case 'exited':
      return '已退出';
    default:
      return status;
  }
}

/**
 * 会话卡状态文案：
 * - 已退出 → 「已退出（exit N）」（无 exitCode 显示 ?）；
 * - 有 currentToolName → 「状态 · 工具名」。
 */
export function statusText(
  status: string,
  exited: boolean,
  exitCode: number | undefined,
  currentToolName: string | undefined
): string {
  let label: string = exited
    ? `已退出（exit ${exitCode !== undefined ? exitCode : '?'}）`
    : statusLabel(status);
  if (currentToolName !== undefined && currentToolName.length > 0) {
    return `${label} · ${currentToolName}`;
  }
  return label;
}

/**
 * 状态点颜色（对齐 Flutter Colors 映射，Material 基色调）：
 * exited 灰 / idle 绿 / waitingInput 橙 / active·thinking·toolRunning·compacting 蓝 / 其余灰。
 */
export function statusDotColor(status: string, exited: boolean): string {
  if (exited) {
    return '#9E9E9E';
  }
  switch (status) {
    case 'idle':
      return '#4CAF50';
    case 'waitingInput':
      return '#FF9800';
    case 'active':
    case 'thinking':
    case 'toolRunning':
    case 'compacting':
      return '#2196F3';
    default:
      return '#9E9E9E';
  }
}
