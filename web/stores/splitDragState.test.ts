import { describe, it, expect, beforeEach } from "vitest";
import { setDragging, isDragging } from "./splitDragState";

describe("splitDragState", () => {
  beforeEach(() => {
    // 每个测试前复位模块级标志
    setDragging(false);
  });

  describe("初始状态", () => {
    it("默认应为非拖拽状态", () => {
      expect(isDragging()).toBe(false);
    });
  });

  describe("setDragging / isDragging", () => {
    it("setDragging(true) 后 isDragging 应返回 true", () => {
      setDragging(true);
      expect(isDragging()).toBe(true);
    });

    it("setDragging(false) 后 isDragging 应返回 false", () => {
      setDragging(true);
      setDragging(false);
      expect(isDragging()).toBe(false);
    });

    it("多次切换应正确反映最后一次设置", () => {
      setDragging(true);
      expect(isDragging()).toBe(true);
      setDragging(false);
      expect(isDragging()).toBe(false);
      setDragging(true);
      expect(isDragging()).toBe(true);
    });
  });
});
