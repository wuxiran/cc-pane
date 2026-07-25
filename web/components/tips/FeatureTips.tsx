import { useCallback, useEffect, useRef, useState } from "react";
import { navigateToSettings } from "@/components/settings/settingsNavigation";
import { useInterruptGate } from "@/lib/interruptGate";
import {
  useSettingsStore,
  useShortcutsStore,
  useTerminalStatusStore,
} from "@/stores";
import type { TipsSettings } from "@/types";
import { handleErrorSilent } from "@/utils";
import FeatureTip from "./FeatureTip";
import { FEATURE_TIPS, type FeatureTipDefinition } from "./featureTipRegistry";

const TIP_STARTUP_GRACE_MS = 5 * 60 * 1_000;
const USER_IDLE_MS = 20_000;
const RECENT_TERMINAL_INPUT_MS = 30_000;
const BASE_TIP_INTERVAL_MS = 3 * 24 * 60 * 60 * 1_000;
const appStartedAt = Date.now();
let sessionCountRecorded = false;

export type TipTimingBlockReason =
  | "disabled"
  | "firstSessions"
  | "alreadyShown"
  | "startupGrace"
  | "recentActivity"
  | "recentTerminalInput"
  | "frequency";

export interface FeatureTipTimingDeps {
  settings: TipsSettings;
  now: number;
  appStartedAt: number;
  lastUserActivityAt: number;
  lastTerminalInputAt: number | null;
  terminalFocused: boolean;
  shownThisSession: boolean;
}

export function checkFeatureTipTiming({
  settings,
  now,
  appStartedAt: startedAt,
  lastUserActivityAt,
  lastTerminalInputAt,
  terminalFocused,
  shownThisSession,
}: FeatureTipTimingDeps): TipTimingBlockReason | null {
  if (!settings.enabled) return "disabled";
  if (settings.sessionCount <= 3) return "firstSessions";
  if (shownThisSession) return "alreadyShown";
  if (now - startedAt < TIP_STARTUP_GRACE_MS) return "startupGrace";
  if (now - lastUserActivityAt < USER_IDLE_MS) return "recentActivity";
  if (
    terminalFocused &&
    lastTerminalInputAt !== null &&
    now - lastTerminalInputAt < RECENT_TERMINAL_INPUT_MS
  ) {
    return "recentTerminalInput";
  }
  if (settings.lastShownAt) {
    const lastShownAt = Date.parse(settings.lastShownAt);
    const interval = settings.dismissRun >= 2
      ? BASE_TIP_INTERVAL_MS * 2
      : BASE_TIP_INTERVAL_MS;
    if (Number.isFinite(lastShownAt) && now - lastShownAt < interval) return "frequency";
  }
  return null;
}

export function selectFeatureTip(
  definitions: readonly FeatureTipDefinition[],
  seen: readonly string[],
  random = Math.random,
): FeatureTipDefinition | null {
  const seenIds = new Set(seen);
  const candidates = definitions.filter((tip) => !seenIds.has(tip.id) && (tip.eligible?.() ?? true));
  if (candidates.length === 0) return null;
  const totalWeight = candidates.reduce((total, tip) => total + Math.max(0, tip.weight ?? 1), 0);
  if (totalWeight === 0) return candidates[0];
  let threshold = random() * totalWeight;
  for (const tip of candidates) {
    threshold -= Math.max(0, tip.weight ?? 1);
    if (threshold < 0) return tip;
  }
  return candidates[candidates.length - 1];
}

export default function FeatureTips() {
  const tipsSettings = useSettingsStore((state) => state.settings?.tips ?? null);
  const statusMap = useTerminalStatusStore((state) => state.statusMap);
  const terminalFocused = useShortcutsStore((state) => state.terminalFocused);
  const { activeInterrupt, check, occupy, release } = useInterruptGate("tip");
  const [clock, setClock] = useState(Date.now);
  const [currentTip, setCurrentTip] = useState<FeatureTipDefinition | null>(null);
  const lastUserActivityAtRef = useRef(Date.now());
  const lastTerminalInputAtRef = useRef<number | null>(null);
  const shownThisSessionRef = useRef(false);
  const handlingResponseRef = useRef(false);

  const persistTips = useCallback(async (patch: Partial<TipsSettings>) => {
    const store = useSettingsStore.getState();
    if (!store.settings) return;
    await store.saveSettings({
      ...store.settings,
      tips: { ...store.settings.tips, ...patch },
    });
  }, []);

  useEffect(() => {
    if (!tipsSettings || sessionCountRecorded) return;
    sessionCountRecorded = true;
    void persistTips({ sessionCount: tipsSettings.sessionCount + 1 }).catch((reason) => {
      sessionCountRecorded = false;
      handleErrorSilent(reason, "persist feature tip session count");
    });
  }, [persistTips, tipsSettings]);

  useEffect(() => {
    const handlePointerActivity = () => {
      lastUserActivityAtRef.current = Date.now();
    };
    const handleKeyActivity = () => {
      const now = Date.now();
      lastUserActivityAtRef.current = now;
      if (useShortcutsStore.getState().terminalFocused) {
        lastTerminalInputAtRef.current = now;
      }
    };
    window.addEventListener("pointerdown", handlePointerActivity, true);
    window.addEventListener("keydown", handleKeyActivity, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerActivity, true);
      window.removeEventListener("keydown", handleKeyActivity, true);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (currentTip || !tipsSettings) return;
    if (checkFeatureTipTiming({
      settings: tipsSettings,
      now: clock,
      appStartedAt,
      lastUserActivityAt: lastUserActivityAtRef.current,
      lastTerminalInputAt: lastTerminalInputAtRef.current,
      terminalFocused,
      shownThisSession: shownThisSessionRef.current,
    }) !== null) return;
    if (check() !== null) return;
    const selected = selectFeatureTip(FEATURE_TIPS, tipsSettings.seen);
    if (!selected) return;

    shownThisSessionRef.current = true;
    handlingResponseRef.current = false;
    occupy();
    setCurrentTip(selected);
  }, [activeInterrupt, check, clock, currentTip, occupy, statusMap, terminalFocused, tipsSettings]);

  useEffect(() => {
    if (!currentTip || activeInterrupt !== "update") return;
    // 更新提示优先：不写 seen/lastShownAt，允许本会话空闲后重新候选。
    shownThisSessionRef.current = false;
    handlingResponseRef.current = false;
    setCurrentTip(null);
    release();
  }, [activeInterrupt, currentTip, release]);

  useEffect(() => () => release(), [release]);

  const closeTip = useCallback(() => {
    setCurrentTip(null);
    release();
  }, [release]);

  const markSeen = useCallback((tip: FeatureTipDefinition, tried: boolean) => {
    const settings = useSettingsStore.getState().settings?.tips;
    if (!settings) return;
    const seen = Array.from(new Set([...settings.seen, tip.id]));
    const triedIds = tried ? Array.from(new Set([...settings.tried, tip.id])) : settings.tried;
    void persistTips({
      seen,
      tried: triedIds,
      dismissRun: tried ? 0 : settings.dismissRun + 1,
      lastShownAt: new Date().toISOString(),
    }).catch((reason) => handleErrorSilent(reason, "persist feature tip result"));
  }, [persistTips]);

  const handleDismiss = useCallback(() => {
    if (!currentTip || handlingResponseRef.current) return;
    handlingResponseRef.current = true;
    markSeen(currentTip, false);
    closeTip();
  }, [closeTip, currentTip, markSeen]);

  const handleTry = useCallback(() => {
    if (!currentTip || handlingResponseRef.current) return;
    handlingResponseRef.current = true;
    const action = currentTip.tryAction;
    markSeen(currentTip, true);
    closeTip();
    if (action) window.requestAnimationFrame(action);
  }, [closeTip, currentTip, markSeen]);

  const handleDisable = useCallback(() => {
    if (handlingResponseRef.current) return;
    handlingResponseRef.current = true;
    void persistTips({ enabled: false }).catch((reason) => {
      handleErrorSilent(reason, "disable feature tips");
    });
    closeTip();
  }, [closeTip, persistTips]);

  const handleOpenShortcuts = useCallback(() => {
    if (!currentTip || handlingResponseRef.current) return;
    handlingResponseRef.current = true;
    markSeen(currentTip, false);
    closeTip();
    window.requestAnimationFrame(() => navigateToSettings({
      paneId: "shortcuts",
      targetSectionId: "shortcuts-list",
    }));
  }, [closeTip, currentTip, markSeen]);

  if (!currentTip) return null;
  return (
    <FeatureTip
      definition={currentTip}
      onTry={handleTry}
      onDismiss={handleDismiss}
      onDisable={handleDisable}
      onOpenShortcuts={handleOpenShortcuts}
    />
  );
}
