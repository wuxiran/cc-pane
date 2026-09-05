import { useEffect, useMemo, useRef } from "react";
import { toastErr } from "@/lib/feedback";
import i18n from "@/i18n";
import MarkdownPreview from "@/components/editor/MarkdownPreview";
import { aiPanelService } from "@/services/aiPanelService";
import type { AiPanel } from "@/types/aiPanel";

export const AI_PANEL_BRIDGE_MESSAGE = "cc-panes:ai-panel-action";
export const AI_PANEL_PAYLOAD_MAX_BYTES = 4 * 1024;
const ACTION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const THEME_TOKENS = [
  "--app-content",
  "--app-panel-bg",
  "--app-text-primary",
  "--app-text-secondary",
  "--app-text-tertiary",
  "--app-border",
  "--app-accent",
  "--app-status-success",
  "--app-status-warning",
  "--app-status-danger",
] as const;

let nextBridgeSequence = 1;

function bridgeScript(bridgeId: string): string {
  return `(() => {
  const bridgeId = ${JSON.stringify(bridgeId)};
  const actionPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const maxPayloadBytes = 4096;
  document.addEventListener("click", (event) => {
    const origin = event.target instanceof Element ? event.target : null;
    const target = origin?.closest("[data-action]");
    if (!target) return;
    const action = target.getAttribute("data-action") || "";
    if (!actionPattern.test(action)) return;
    const rawPayload = target.getAttribute("data-payload");
    let payload;
    if (rawPayload !== null) {
      try {
        payload = JSON.parse(rawPayload);
      } catch {
        return;
      }
    }
    const serialized = payload === undefined ? "" : JSON.stringify(payload);
    if (new TextEncoder().encode(serialized).byteLength > maxPayloadBytes) return;
    window.parent.postMessage({
      type: "cc-panes:ai-panel-action",
      bridgeId,
      action,
      payload,
    }, "*");
  });
})();`;
}

function themeCss(): string {
  const styles = getComputedStyle(document.documentElement);
  return THEME_TOKENS
    .map((token) => `${token}:${styles.getPropertyValue(token).trim()};`)
    .join("");
}

export function buildAiPanelSrcDoc(content: string, bridgeId: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
<meta name="color-scheme" content="light dark">
<style>
:root{${themeCss()}color:var(--app-text-primary);background:var(--app-content);font-family:Inter,system-ui,sans-serif}
*{box-sizing:border-box}html,body{min-height:100%;margin:0}body{padding:16px}button,input,select,textarea{font:inherit}
</style>
<script>${bridgeScript(bridgeId)}</script>
</head>
<body>${content}</body>
</html>`;
}

interface BridgeMessage {
  type: string;
  bridgeId: string;
  action: string;
  payload?: unknown;
}

function isBridgeMessage(value: unknown, bridgeId: string): value is BridgeMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<BridgeMessage>;
  if (message.type !== AI_PANEL_BRIDGE_MESSAGE || message.bridgeId !== bridgeId) return false;
  if (typeof message.action !== "string" || !ACTION_PATTERN.test(message.action)) return false;
  try {
    const serialized = message.payload === undefined ? "" : JSON.stringify(message.payload);
    return new TextEncoder().encode(serialized).byteLength <= AI_PANEL_PAYLOAD_MAX_BYTES;
  } catch {
    return false;
  }
}

export default function AiPanelFrame({ panel }: { panel: AiPanel }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeIdRef = useRef(`ai-panel-bridge-${nextBridgeSequence++}`);
  const srcDoc = useMemo(
    () => buildAiPanelSrcDoc(panel.content, bridgeIdRef.current),
    [panel.content],
  );

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || event.origin !== "null") return;
      if (!isBridgeMessage(event.data, bridgeIdRef.current)) return;
      void aiPanelService
        .recordEvent(panel.panelId, event.data.action, event.data.payload)
        .catch(() => toastErr(i18n.t("aiPanel.eventFailed", { ns: "sidebar" })));
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [panel.panelId]);

  if (panel.format === "markdown") {
    return <MarkdownPreview content={panel.content} />;
  }

  return (
    <iframe
      ref={iframeRef}
      title={panel.title}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      className="h-full w-full border-0 bg-[var(--app-content)]"
    />
  );
}
