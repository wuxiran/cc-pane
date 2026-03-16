/**
 * 新手引导 Dialog — 环境检测 + 欢迎概念 + AI 引导入口
 */
import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, XCircle, Loader2, FolderTree, FolderOpen, Wrench, ArrowRight, ArrowLeft } from "lucide-react";
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

type Step = "env-check" | "cli-choice" | "welcome";

export default function OnboardingGuide() {
  const { t } = useTranslation("onboarding");
  const open = useDialogStore((s) => s.onboardingOpen);
  const closeOnboarding = useDialogStore((s) => s.closeOnboarding);

  const [step, setStep] = useState<Step>("env-check");
  const [envInfo, setEnvInfo] = useState<EnvironmentInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [cliChoice, setCliChoice] = useState<"claude" | "codex">("claude");

  const selectedCliReady = cliChoice === "codex"
    ? envInfo?.codex.installed
    : envInfo?.claude.installed;
  const envReady = envInfo?.node.installed && selectedCliReady;

  // 打开时自动检测环境 + 从设置恢复 CLI 选择
  useEffect(() => {
    if (!open) return;
    setStep("env-check");
    const saved = useSettingsStore.getState().settings?.general.defaultCliTool;
    if (saved === "claude" || saved === "codex") setCliChoice(saved);
    setChecking(true);
    terminalService
      .checkEnvironment()
      .then(setEnvInfo)
      .catch(console.error)
      .finally(() => setChecking(false));
  }, [open]);

  const handleSkip = useCallback(async () => {
    // 仅标记 onboarding 已完成，不覆盖用户已有的 CLI 选择
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
    // 标记 onboarding 已完成 + 保存 CLI 选择
    const settings = useSettingsStore.getState().settings;
    if (settings) {
      await useSettingsStore.getState().saveSettings({
        ...settings,
        general: { ...settings.general, onboardingCompleted: true, defaultCliTool: cliChoice },
      });
    }
    closeOnboarding();
    // 切换到 SelfChat 模式 + 标记 onboarding
    useSelfChatStore.getState().setOnboarding(true);
    useActivityBarStore.getState().toggleSelfChatMode();
  }, [closeOnboarding, cliChoice]);

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
                onClick={() => setStep("cli-choice")}
                disabled={checking || !envInfo}
              >
                {t("next")} <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            </DialogFooter>
          </>
        ) : step === "cli-choice" ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("cliChoice")}</DialogTitle>
              <DialogDescription>{t("cliChoiceDesc")}</DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-2 gap-3 py-2">
              <CliOptionCard
                selected={cliChoice === "claude"}
                onClick={() => setCliChoice("claude")}
                name={t("claudeCodeName")}
                description={t("claudeCodeDesc")}
                detected={envInfo?.claude.installed ?? false}
                detectedLabel={t("cliDetected")}
                notDetectedLabel={t("cliNotDetected")}
              />
              <CliOptionCard
                selected={cliChoice === "codex"}
                onClick={() => setCliChoice("codex")}
                name={t("codexCliName")}
                description={t("codexCliDesc")}
                detected={envInfo?.codex.installed ?? false}
                detectedLabel={t("cliDetected")}
                notDetectedLabel={t("cliNotDetected")}
              />
            </div>

            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setStep("env-check")}>
                <ArrowLeft className="w-4 h-4 mr-1" /> {t("back")}
              </Button>
              <Button size="sm" onClick={() => setStep("welcome")}>
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
              <Button variant="ghost" size="sm" onClick={() => setStep("cli-choice")}>
                <ArrowLeft className="w-4 h-4 mr-1" /> {t("back")}
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

/** CLI 工具选择卡片 */
function CliOptionCard({
  selected,
  onClick,
  name,
  description,
  detected,
  detectedLabel,
  notDetectedLabel,
}: {
  selected: boolean;
  onClick: () => void;
  name: string;
  description: string;
  detected: boolean;
  detectedLabel: string;
  notDetectedLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-2 rounded-lg border-2 p-4 text-center transition-colors cursor-pointer"
      style={{
        borderColor: selected ? "var(--app-accent)" : "var(--app-border)",
        backgroundColor: selected ? "var(--app-accent-muted, rgba(var(--app-accent-rgb, 59,130,246), 0.08))" : "transparent",
      }}
    >
      <div
        className="w-3 h-3 rounded-full border-2 flex items-center justify-center"
        style={{ borderColor: selected ? "var(--app-accent)" : "var(--app-text-tertiary)" }}
      >
        {selected && (
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: "var(--app-accent)" }}
          />
        )}
      </div>
      <span className="text-sm font-medium" style={{ color: "var(--app-text-primary)" }}>
        {name}
      </span>
      <span className="text-xs" style={{ color: "var(--app-text-secondary)" }}>
        {description}
      </span>
      <span
        className="text-xs flex items-center gap-1"
        style={{ color: detected ? "var(--app-success, #22c55e)" : "var(--app-text-tertiary)" }}
      >
        {detected ? (
          <CheckCircle2 className="w-3 h-3" />
        ) : (
          <XCircle className="w-3 h-3" />
        )}
        {detected ? detectedLabel : notDetectedLabel}
      </span>
    </button>
  );
}
