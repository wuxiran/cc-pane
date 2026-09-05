/**
 * 通知栈入场动画防回潮静态测试
 * ==================================
 * 守护 notifications/ 的入场规范（断言风格对齐 designTokens.test.ts 的源码静态检查）：
 *   - 新通知卡 / 历史面板：motion-safe:animate-in + slide-in-from-bottom + fade-in，
 *     时长/缓动统一 var(--dur-slow) + var(--ease-out)；
 *   - 一律 motion-safe: 前缀（prefers-reduced-motion 降级 = 直接呈现终态，
 *     index.css 全局规则另作兜底，其存在性由 layout/layoutMotion.test.ts 守护）；
 *   - 只作入场：通知卡 dismiss 即出栈卸载，无在场追踪，架构上没有离场动画挂点。
 */
import { describe, it, expect } from "vitest";
import cardSource from "./NotificationCard.tsx?raw";
import historySource from "./NotificationHistoryPanel.tsx?raw";

const ENTRANCE_CLASSES = [
  "motion-safe:animate-in",
  "motion-safe:slide-in-from-bottom-2",
  "motion-safe:fade-in",
  "motion-safe:duration-[var(--dur-slow)]",
  "motion-safe:ease-[var(--ease-out)]",
] as const;

describe("通知栈入场动画 (anti-regression)", () => {
  it("新通知卡：slide-in-from-bottom + fade，时长/缓动走 token", () => {
    for (const cls of ENTRANCE_CLASSES) {
      expect(cardSource, `NotificationCard 缺少 ${cls}`).toContain(cls);
    }
  });

  it("历史面板沿用同一入场规范", () => {
    for (const cls of ENTRANCE_CLASSES) {
      expect(historySource, `NotificationHistoryPanel 缺少 ${cls}`).toContain(cls);
    }
  });

  it("入场动画一律 motion-safe 前缀（reduced-motion 直接呈现终态）", () => {
    // 不允许出现不带 motion-safe: 的裸 animate-in / slide-in-from-bottom / fade-in
    for (const source of [cardSource, historySource]) {
      expect(source.match(/(?<!motion-safe:)animate-in\b/)).toBeNull();
      expect(source.match(/(?<!motion-safe:)slide-in-from-bottom-2/)).toBeNull();
    }
  });
});
