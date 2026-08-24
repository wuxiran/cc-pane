import { useEffect, useRef } from "react";
import { edgeCurve, pointOnCubicCurve, visibleEdges } from "@/lib/canvasGeometry";
import { useCanvasDisplayStore, useThemeStore } from "@/stores";
import type { CanvasNodePosition, PipeEdge, PipeEvent } from "@/types/canvas";

export type ParticleAnimationIntensity = "off" | "reduced" | "full";

interface ParticleCanvasLayerProps {
  events: PipeEvent[];
  edges?: PipeEdge[];
  positions: Record<string, CanvasNodePosition>;
  /** @deprecated Prefer animationIntensity for the three explicit modes. */
  reducedMotion?: boolean;
  animationIntensity?: ParticleAnimationIntensity;
}

const REDUCED_FRAME_INTERVAL = 120;
const QUEUED_PULSE_MS = 280;
const DELIVERED_FLASH_MS = 650;
const FAILED_FLASH_MS = 720;
const AMBIENT_FLOW_DURATION_MS = 3_400;
const AMBIENT_PACKET_OFFSETS = [0, 0.2, 0.4, 0.6, 0.8];

function resolveEndpoints(event: PipeEvent): [string, string] | null {
  const sourceId = event.sourceId
    ?? (event.fromBinding ? `binding:${event.fromBinding}` : undefined)
    ?? (event.fromSession ? `session:${event.fromSession}` : undefined);
  const targetId = event.targetId
    ?? (event.toBinding ? `binding:${event.toBinding}` : undefined)
    ?? (event.toSession ? `session:${event.toSession}` : undefined);
  return sourceId && targetId ? [sourceId, targetId] : null;
}

function effectDuration(phase: PipeEvent["phase"]): number {
  switch (phase) {
    case "queued": return QUEUED_PULSE_MS;
    case "delivered": return DELIVERED_FLASH_MS;
    case "failed": return FAILED_FLASH_MS;
    case "flowing": return Number.POSITIVE_INFINITY;
  }
}

function effectKey(event: PipeEvent): string {
  return `${event.eventId}:${event.phase}`;
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function drawParticle(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  radius: number,
  alpha = 1,
): void {
  context.save?.();
  context.globalAlpha = alpha;
  context.fillStyle = color;
  context.shadowColor = color;
  context.shadowBlur = Math.max(2.2, radius * 2);
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
  context.restore?.();
  context.globalAlpha = 1;
}

function drawParticleTrail(
  context: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  color: string,
  alpha: number,
  width: number,
): void {
  context.save?.();
  context.globalAlpha = alpha;
  context.strokeStyle = color;
  context.lineWidth = width;
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.stroke();
  context.restore?.();
  context.globalAlpha = 1;
}

function drawPulse(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  progress: number,
  color: string,
  highlightColor: string,
): void {
  [0, 0.24, 0.48].forEach((delay, index) => {
    const phase = clampUnit((progress - delay) / (1 - delay));
    if (phase <= 0) return;
    context.globalAlpha = (1 - phase) * (0.7 - index * 0.1);
    context.strokeStyle = color;
    context.lineWidth = 1.65 - index * 0.22;
    context.beginPath();
    context.arc(x, y, 4 + phase * (8 + index * 2), 0, Math.PI * 2);
    context.stroke();
  });
  context.globalAlpha = 1;
  drawParticle(context, x, y, color, 4.8, 0.1);
  drawParticle(context, x, y, color, 2.7, 0.92);
  drawParticle(context, x, y, highlightColor, 1, 1);
}

function drawDeliveryFlash(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  progress: number,
  color: string,
): void {
  const eased = 1 - (1 - progress) ** 2;
  [0, 0.16, 0.34].forEach((delay, index) => {
    const phase = clampUnit((progress - delay) / (1 - delay));
    if (phase <= 0) return;
    const ringEase = 1 - (1 - phase) ** 2;
    context.globalAlpha = (1 - phase) * (0.82 - index * 0.14);
    context.strokeStyle = color;
    context.lineWidth = 1.8 - index * 0.28;
    context.beginPath();
    context.arc(x, y, 4.5 + ringEase * (11 + index * 2), 0, Math.PI * 2);
    context.stroke();
  });
  for (let index = 0; index < 7; index += 1) {
    const angle = (Math.PI * 2 * index) / 7 + eased * 0.8;
    const radius = 7 + eased * 16;
    drawParticle(
      context,
      x + Math.cos(angle) * radius,
      y + Math.sin(angle) * radius,
      color,
      1.6 - eased * 0.45,
      (1 - progress) * 0.45,
    );
  }
  context.globalAlpha = 1;
}

/** A quiet link heartbeat keeps the relationship visible between real events. */
function drawAmbientFlow(
  context: CanvasRenderingContext2D,
  edge: PipeEdge,
  positions: Record<string, CanvasNodePosition>,
  elapsed: number,
  color: string,
  intensityScale: number,
  highlightColor: string,
  secondaryColor: string,
): void {
  const source = positions[edge.sourceId];
  const target = positions[edge.targetId];
  if (!source || !target) return;
  const curve = edgeCurve(source, target);
  const progress = (elapsed % AMBIENT_FLOW_DURATION_MS) / AMBIENT_FLOW_DURATION_MS;

  context.save?.();
  context.globalCompositeOperation = "lighter";
  AMBIENT_PACKET_OFFSETS.forEach((offset, index) => {
    const packetProgress = (progress + offset) % 1;
    const packetScale = (1 - index * 0.08) * intensityScale;
    const point = pointOnCubicCurve(curve, packetProgress);
    const tailPoint = pointOnCubicCurve(curve, Math.max(0, packetProgress - 0.04));
    const leadColor = index % 2 === 0 ? color : secondaryColor;
    const tailColor = index % 2 === 0 ? secondaryColor : color;
    drawParticleTrail(context, tailPoint, point, leadColor, 0.48 * intensityScale, 1.05 * packetScale);
    drawParticle(context, tailPoint.x, tailPoint.y, tailColor, 0.78 * packetScale, 0.42 * intensityScale);
    drawParticle(context, point.x, point.y, leadColor, 1.45 * packetScale, 0.78 * intensityScale);
    drawParticle(context, point.x, point.y, highlightColor, 0.52 * packetScale, 0.86 * intensityScale);
  });
  context.globalCompositeOperation = "source-over";
  context.restore?.();
}

function drawFailedParticle(
  context: CanvasRenderingContext2D,
  source: CanvasNodePosition,
  target: CanvasNodePosition,
  elapsed: number,
  color: string,
): void {
  const curve = edgeCurve(source, target);
  const progress = 0.38 + clampUnit(elapsed / FAILED_FLASH_MS) * 0.2;
  const point = pointOnCubicCurve(curve, progress);
  const failureProgress = clampUnit(elapsed / FAILED_FLASH_MS);
  drawParticle(context, point.x, point.y, color, 4.5, 0.1 * (1 - failureProgress));
  drawParticle(context, point.x, point.y, color, 2.6, 0.92);
  for (let index = 0; index < 6; index += 1) {
    const angle = (Math.PI * 2 * index) / 6 + failureProgress * 1.8;
    const radius = 4 + failureProgress * 8;
    drawParticle(
      context,
      point.x + Math.cos(angle) * radius,
      point.y + Math.sin(angle) * radius,
      color,
      1.25 - failureProgress * 0.35,
      (1 - failureProgress) * 0.62,
    );
  }
  context.globalAlpha = 0.58;
  context.strokeStyle = color;
  context.lineWidth = 0.85;
  context.beginPath();
  context.arc(point.x, point.y, 5 + failureProgress * 7, 0, Math.PI * 2);
  context.stroke();
  context.globalAlpha = 1;
}

export function resolveParticleAnimationIntensity(
  animationIntensity: ParticleAnimationIntensity | undefined,
  reducedMotion: boolean,
): ParticleAnimationIntensity {
  return animationIntensity ?? (reducedMotion ? "reduced" : "full");
}

export default function ParticleCanvasLayer({
  events,
  edges = [],
  positions,
  reducedMotion = false,
  animationIntensity,
}: ParticleCanvasLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frame = useRef<number | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const configuredRatio = useRef<number | null>(null);
  const effectStarts = useRef(new Map<string, number>());
  const finishedEffects = useRef(new Set<string>());
  const storeIntensity = useCanvasDisplayStore((state) => state.animationIntensity);
  const themeId = useThemeStore((state) => state.themeId);
  const intensity = animationIntensity
    ?? (storeIntensity === "off" ? "off" : reducedMotion ? "reduced" : storeIntensity);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const styles = getComputedStyle(canvas);
    const pipeColor = styles.getPropertyValue("--app-canvas-pipe-primary").trim()
      || styles.getPropertyValue("--app-accent").trim()
      || "transparent";
    const highlightColor = styles.getPropertyValue("--app-canvas-pipe-highlight").trim()
      || styles.getPropertyValue("--app-text-primary").trim()
      || pipeColor;
    const secondaryColor = styles.getPropertyValue("--app-canvas-pipe-secondary").trim() || pipeColor;
    const successColor = styles.getPropertyValue("--app-status-success").trim() || pipeColor;
    const warningColor = styles.getPropertyValue("--app-status-warning").trim() || pipeColor;
    const failureColor = styles.getPropertyValue("--app-status-danger").trim() || pipeColor;

    const ensureEffectStarts = (now: number) => {
      const currentKeys = new Set(events.map(effectKey));
      effectStarts.current.forEach((_startedAt, key) => {
        if (!currentKeys.has(key)) effectStarts.current.delete(key);
      });
      finishedEffects.current.forEach((key) => {
        if (!currentKeys.has(key)) finishedEffects.current.delete(key);
      });
      events.forEach((event) => {
        const key = effectKey(event);
        if (!effectStarts.current.has(key) && !finishedEffects.current.has(key)) {
          effectStarts.current.set(key, now);
        }
      });
    };

    const draw = (): boolean => {
      const now = Date.now();
      ensureEffectStarts(now);
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const pixelWidth = Math.round(rect.width * ratio);
      const pixelHeight = Math.round(rect.height * ratio);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight || configuredRatio.current !== ratio) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        configuredRatio.current = ratio;
      }
      context.clearRect(0, 0, rect.width, rect.height);

      // "off" keeps the SVG path and node state visible, but never leaves a
      // static particle frame behind after the user disables animation.
      if (intensity === "off") return false;

      const drawableEdges = visibleEdges(edges, positions);
      const ambientScale = intensity === "reduced" ? 0.72 : 1;
      drawableEdges.forEach((edge) => {
        drawAmbientFlow(context, edge, positions, now, pipeColor, ambientScale, highlightColor, secondaryColor);
      });
      let hasDrawableEffect = drawableEdges.length > 0;
      events.forEach((event) => {
        const endpoints = resolveEndpoints(event);
        if (!endpoints) return;
        const source = positions[endpoints[0]];
        const target = positions[endpoints[1]];
        if (!source || !target) return;
        const key = effectKey(event);
        if (finishedEffects.current.has(key)) return;
        const startedAt = effectStarts.current.get(key) ?? now;
        const elapsed = Math.max(0, now - startedAt);
        const duration = effectDuration(event.phase);
        if (Number.isFinite(duration) && elapsed >= duration) {
          finishedEffects.current.add(key);
          effectStarts.current.delete(key);
          return;
        }
        hasDrawableEffect = true;
        const curve = edgeCurve(source, target);
        switch (event.phase) {
          case "queued":
            drawPulse(context, curve.startX, curve.startY, clampUnit(elapsed / QUEUED_PULSE_MS), warningColor, highlightColor);
            break;
          case "flowing":
            // The ambient stream is already rendered for every visible edge.
            // A flowing event must not create a second, brighter visual state.
            break;
          case "delivered":
            drawDeliveryFlash(context, curve.endX, curve.endY, clampUnit(elapsed / DELIVERED_FLASH_MS), successColor);
            break;
          case "failed":
            drawFailedParticle(context, source, target, elapsed, failureColor);
            break;
        }
      });
      return hasDrawableEffect;
    };

    const hasActiveEffect = draw();
    if (!hasActiveEffect || intensity === "off") return;

    if (intensity === "reduced") {
      const scheduleReduced = () => {
        timeout.current = setTimeout(() => {
          timeout.current = null;
          if (draw()) scheduleReduced();
        }, REDUCED_FRAME_INTERVAL);
      };
      scheduleReduced();
    } else {
      const drawFull = () => {
        frame.current = null;
        if (draw()) frame.current = requestAnimationFrame(drawFull);
      };
      frame.current = requestAnimationFrame(drawFull);
    }

    return () => {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
      if (timeout.current !== null) {
        clearTimeout(timeout.current);
        timeout.current = null;
      }
    };
  }, [edges, events, intensity, positions, themeId]);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-[2] h-full w-full" aria-hidden="true" />;
}
