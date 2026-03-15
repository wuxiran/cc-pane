/**
 * 新手引导 Dialog — 环境检测 + 欢迎概念 + AI 引导入口
 */
import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, XCircle, Loader2, FolderTree, FolderOpen, Wrench, ArrowRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useDialogStore, useSettingsStore, useActivityBarStore, useSelfChatStore } from "@/stores";
import { terminalService } from "@/services";
import type { EnvironmentInfo } from "@/types";

type Step = "env-check" | "welcome";

export default function OnboardingGuide() {
  const { t } = useTranslation("onboarding");
  const open = useDialogStore((s) => s.onboardingOpen);
  const closeOnboarding = useDialogStore((s) => s.closeOnboarding);

  const [step, setStep] = useState<Step>("env-check");
  const [envInfo, setEnvInfo] = useState<EnvironmentInfo | null>(null);
  const [checking, setChecking] = useState(false);

  const envReady = envInfo?.node.installed && envInfo?.claude.installed;

  // 打开时自动检测环境
  useEffect(() => {
    if (!open) return;
    setStep("env-check");
    setChecking(true);
    terminalService
      .checkEnvironment()
      .then(setEnvInfo)
      .catch(console.error)
      .finally(() => setChecking(false));
  }, [open]);

  const handleSkip = useCallback(async () => {
    // 标记 onboarding 已完成
    const settings = useSettingsStore.getState().settings;
    if (settings) {
      await useSettingsStore.getState().saveSettings({
        ...settings,
        general: { ...settings.general, onboardingCompleted: true },
      });
    }
    closeOnboarding();
  }, [closeOnboarding]);

  const handleStartAiGuide = useCallback(async () => {
    // 标记 onboarding 已完成
    const settings = useSettingsStore.getState().settings;
    if (settings) {
      await useSettingsStore.getState().saveSettings({
        ...settings,
        general: { ...settings.general, onboardingCompleted: true },
      });
    }
    closeOnboarding();
    // 切换到 SelfChat 模式 + 标记 onboarding
    useSelfChatStore.getState().setOnboarding(true);
    useActivityBarStore.getState().toggleSelfChatMode();
  }, [closeOnboarding]);

  const handleOpenChange = useCallback(
    (value: boolean) => {
      if (!value) closeOnboarding();
    },
    [closeOnboarding]
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[480px]" showCloseButton={false}>
        {step === "env-check" ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("envCheck")}</DialogTitle>
              <DialogDescription>{t("envCheckDesc")}</DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3 py-2">
              {/* Node.js */}
              <EnvItem
                label={t("nodeJs")}
                installed={envInfo?.node.installed ?? null}
                version={envInfo?.node.version ?? null}
                hint={t("installNodeHint")}
                checking={checking}
              />
              {/* Claude Code */}
              <EnvItem
                label={t("claudeCode")}
                installed={envInfo?.claude.installed ?? null}
                version={envInfo?.claude.version ?? null}
                hint={t("installClaudeHint")}
                checking={checking}
              />

              {/* 状态提示 */}
              {!checking && envInfo && (
                <p
                  className="text-xs mt-1"
                  style={{ color: envReady ? "var(--app-success, #22c55e)" : "var(--app-accent)" }}
                >
                  {envReady ? t("envReady") : t("envNotReady")}
                </p>
              )}
            </div>

            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={handleSkip}>
                {t("skip")}
              </Button>
              <Button
                size="sm"
                onClick={() => setStep("welcome")}
                disabled={checking}
              >
                {t("next")} <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("welcome")}</DialogTitle>
              <DialogDescription>{t("welcomeDesc")}</DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3 py-2">
              <h4 className="text-sm font-medium" style={{ color: "var(--app-text-primary)" }}>
                {t("conceptTitle")}
              </h4>
              <p className="text-xs" style={{ color: "var(--app-text-secondary)" }}>
                {t("conceptDesc")}
              </p>
              <div className="flex flex-col gap-2 pl-1">
                <ConceptRow
                  icon={<FolderTree className="w-4 h-4 shrink-0" style={{ color: "var(--app-accent)" }} />}
                  text={t("conceptWorkspace")}
                />
                <ConceptRow
                  icon={<FolderOpen className="w-4 h-4 shrink-0" style={{ color: "var(--app-accent)" }} />}
                  text={t("conceptProject")}
                />
                <ConceptRow
                  icon={<Wrench className="w-4 h-4 shrink-0" style={{ color: "var(--app-accent)" }} />}
                  text={t("conceptTask")}
                />
              </div>

              <p className="text-xs mt-2" style={{ color: "var(--app-text-secondary)" }}>
                {t("aiGuideIntro")}
              </p>
            </div>

            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setStep("env-check")}>
                {t("back")}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleSkip}>
                {t("skip")}
              </Button>
              <Button
                size="sm"
                onClick={handleStartAiGuide}
                disabled={!envReady}
                title={!envReady ? t("startAiGuideDisabled") : undefined}
              >
                {t("startAiGuide")} <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 环境检测行 */
function EnvItem({
  label,
  installed,
  version,
  hint,
  checking,
}: {
  label: string;
  installed: boolean | null;
  version: string | null;
  hint: string;
  checking: boolean;
}) {
  const { t } = useTranslation("onboarding");

  return (
    <div className="flex items-center gap-3">
      {checking ? (
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      ) : installed ? (
        <CheckCircle2 className="w-4 h-4" style={{ color: "var(--app-success, #22c55e)" }} />
      ) : installed === false ? (
        <XCircle className="w-4 h-4" style={{ color: "var(--destructive, #ef4444)" }} />
      ) : (
        <div className="w-4 h-4" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium" style={{ color: "var(--app-text-primary)" }}>
            {label}
          </span>
          {!checking && installed && version && (
            <span className="text-xs font-mono" style={{ color: "var(--app-text-tertiary)" }}>
              {version}
            </span>
          )}
        </div>
        {!checking && installed === false && (
          <p className="text-xs mt-0.5" style={{ color: "var(--app-text-tertiary)" }}>
            {hint}
          </p>
        )}
      </div>
      <span
        className="text-xs"
        style={{
          color: checking
            ? "var(--app-text-tertiary)"
            : installed
              ? "var(--app-success, #22c55e)"
              : "var(--destructive, #ef4444)",
        }}
      >
        {!checking && installed !== null && (installed ? t("installed") : t("notInstalled"))}
      </span>
    </div>
  );
}

/** 概念介绍行 */
function ConceptRow({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-start gap-2">
      {icon}
      <span className="text-xs" style={{ color: "var(--app-text-secondary)" }}>
        {text}
      </span>
    </div>
  );
}
