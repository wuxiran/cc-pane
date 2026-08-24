import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useThemeStore } from "@/stores";
import ParticleCanvasLayer, { resolveParticleAnimationIntensity } from "./ParticleCanvasLayer";
import type { PipeEdge, PipeEvent } from "@/types/canvas";

const position = { x: 0, y: 0, width: 20, height: 10 };
const target = { x: 100, y: 40, width: 20, height: 10 };
const edge: PipeEdge = { id: "pipe:source->target", sourceId: "source", targetId: "target", readOnly: true };

function event(phase: PipeEvent["phase"]): PipeEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${phase}`,
    correlationId: "correlation-1",
    sequence: 1,
    workspaceId: "workspace-1",
    kind: "message",
    phase,
    sourceId: "source",
    targetId: "target",
    summary: phase,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function canvasContext() {
  return {
    clearRect: vi.fn(),
    setTransform: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ParticleCanvasLayer", () => {
  it("draws delivered feedback and schedules a finite animation", () => {
    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 100.5, height: 60.25,
      right: 100.5, bottom: 60.25, x: 0, y: 0, toJSON: () => ({}),
    });
    const requestFrame = vi.spyOn(window, "requestAnimationFrame");
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.5 });

    const { unmount } = render(
      <ParticleCanvasLayer events={[event("delivered")]} positions={{ source: position, target }} animationIntensity="full" />,
    );

    expect(context.arc).toHaveBeenCalled();
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(document.querySelector("canvas")).toHaveProperty("width", 151);
    unmount();
  });

  it("does not request a frame in off mode", () => {
    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    const requestFrame = vi.spyOn(window, "requestAnimationFrame");

    render(
      <ParticleCanvasLayer events={[event("queued")]} positions={{ source: position, target }} animationIntensity="off" />,
    );

    expect(context.arc).not.toHaveBeenCalled();
    expect(context.clearRect).toHaveBeenCalled();
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it("keeps queued particles moving at a reduced frequency", () => {
    vi.useFakeTimers();
    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    const requestFrame = vi.spyOn(window, "requestAnimationFrame");

    render(
      <ParticleCanvasLayer events={[event("queued")]} positions={{ source: position, target }} animationIntensity="reduced" />,
    );
    const initialDraws = vi.mocked(context.arc).mock.calls.length;

    act(() => vi.advanceTimersByTime(120));

    expect(requestFrame).not.toHaveBeenCalled();
    expect(vi.mocked(context.arc).mock.calls.length).toBeGreaterThan(initialDraws);
  });

  it("keeps a quiet particle stream moving when no transport event is active", () => {
    vi.useFakeTimers();
    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);

    render(
      <ParticleCanvasLayer edges={[edge]} events={[]} positions={{ source: position, target }} animationIntensity="reduced" />,
    );
    const initialDraws = vi.mocked(context.arc).mock.calls.length;

    act(() => vi.advanceTimersByTime(120));

    expect(vi.mocked(context.arc).mock.calls.length).toBeGreaterThan(initialDraws);
  });

  it("keeps the legacy reducedMotion prop compatible", () => {
    expect(resolveParticleAnimationIntensity(undefined, true)).toBe("reduced");
    expect(resolveParticleAnimationIntensity(undefined, false)).toBe("full");
    expect(resolveParticleAnimationIntensity("off", false)).toBe("off");
  });

  it("re-reads pipe colors after a theme switch", () => {
    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    const readStyles = vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: () => "#4c8df5",
    } as unknown as CSSStyleDeclaration);
    const previousThemeId = useThemeStore.getState().themeId;
    const nextThemeId = previousThemeId === "cyber-purple" ? "amber-gold" : "cyber-purple";

    const { unmount } = render(
      <ParticleCanvasLayer events={[]} positions={{}} animationIntensity="off" />,
    );
    expect(readStyles).toHaveBeenCalledTimes(1);

    act(() => useThemeStore.setState({ themeId: nextThemeId }));
    expect(readStyles).toHaveBeenCalledTimes(2);

    act(() => useThemeStore.setState({ themeId: previousThemeId }));
    unmount();
  });
});
