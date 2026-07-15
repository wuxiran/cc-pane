import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Download, Trash2, Package, Store, Globe, ShieldCheck, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { skillService } from "@/services/skillService";
import type {
  BundledSkill,
  DiscoveredExternalSkill,
  ExternalSkillSource,
  InstalledUserSkill,
  SkillMarketEntry,
} from "@/types";
import { handleErrorSilent } from "@/utils";

function externalSourceLabel(s: ExternalSkillSource): string {
  if (s.kind === "plugin") return `plugin:${s.pluginId}`;
  return s.kind;
}

/**
 * 全局 Skills 管理（CC-Panes 层面，非项目 .claude/commands）。四段：
 * 1. 已安装用户 skills（~/.cc-panes/skills/user）—— 可删除
 * 2. 官方市场浏览 —— 一键安装（sha256 校验）
 * 3. 外部发现（只读）—— ~/.claude / ~/.codex / plugins 里已装的 skill
 * 4. 内置 ccpanes skills（只读）—— 启动时自动注入到各 CLI 的那批
 * 后端能力多数已存在（UserSkillService / SkillMarketService / ExternalSkillRegistry）。
 */
export default function GlobalSkillsPanel() {
  const { t } = useTranslation(["settings", "common"]);
  const [userSkills, setUserSkills] = useState<InstalledUserSkill[]>([]);
  const [market, setMarket] = useState<SkillMarketEntry[]>([]);
  const [external, setExternal] = useState<DiscoveredExternalSkill[]>([]);
  const [bundled, setBundled] = useState<BundledSkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);

  const installedIds = useMemo(() => new Set(userSkills.map((s) => s.id)), [userSkills]);

  const reload = useCallback(async () => {
    setLoading(true);
    const [u, m, e, b] = await Promise.all([
      skillService.listUserSkills().catch((err) => (handleErrorSilent(err, "list user skills"), [] as InstalledUserSkill[])),
      skillService.listSkillMarketEntries().catch((err) => (handleErrorSilent(err, "list market skills"), [] as SkillMarketEntry[])),
      skillService.listExternalSkills().catch((err) => (handleErrorSilent(err, "list external skills"), [] as DiscoveredExternalSkill[])),
      skillService.listBundledSkills().catch((err) => (handleErrorSilent(err, "list bundled skills"), [] as BundledSkill[])),
    ]);
    setUserSkills(u);
    setMarket(m);
    setExternal(e);
    setBundled(b);
    setLoading(false);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const handleInstall = useCallback(async (id: string) => {
    setInstalling(id);
    try {
      const installed = await skillService.installMarketSkill(id);
      toast.success(t("skillInstalled", { defaultValue: "已安装 {{name}}", name: installed.name }));
      setUserSkills((prev) => [installed, ...prev.filter((s) => s.id !== installed.id)]);
    } catch (err) {
      toast.error(t("skillInstallFailed", { defaultValue: "安装失败：{{error}}", error: String(err) }));
    } finally {
      setInstalling(null);
    }
  }, [t]);

  const handleRemove = useCallback(async (id: string) => {
    try {
      await skillService.removeUserSkill(id);
      setUserSkills((prev) => prev.filter((s) => s.id !== id));
      toast.success(t("skillRemoved", { defaultValue: "已移除" }));
    } catch (err) {
      toast.error(t("deleteFailed", { defaultValue: "删除失败：{{error}}", error: String(err) }));
    }
  }, [t]);

  return (
    <div className="max-w-4xl mx-auto px-6 py-6 flex flex-col gap-8">
      <div className="flex items-center justify-between">
        <div className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>
          {t("globalSkillsDesc", { defaultValue: "管理 CC-Panes 全局 Skills：市场安装、已装用户 skill、以及各 CLI 已有的 skill（只读）。" })}
        </div>
        <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
          {loading ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <RefreshCw size={14} className="mr-1.5" />}
          {t("refresh", { ns: "common", defaultValue: "刷新" })}
        </Button>
      </div>

      {/* 1. 已安装用户 skills */}
      <Section icon={<Package size={15} />} title={t("installedUserSkills", { defaultValue: "已安装 Skills" })} count={userSkills.length}>
        {userSkills.length === 0 ? (
          <Empty text={t("noUserSkills", { defaultValue: "还没有安装用户 Skill，去下方市场装一个。" })} />
        ) : (
          <div className="flex flex-col gap-2">
            {userSkills.map((s) => (
              <Row
                key={s.id}
                title={s.name}
                subtitle={s.description}
                meta={`v${s.version}${s.category ? " · " + s.category : ""}`}
                action={
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive" title={t("deleteBtn", { defaultValue: "删除" })} onClick={() => void handleRemove(s.id)}>
                    <Trash2 size={14} />
                  </Button>
                }
              />
            ))}
          </div>
        )}
      </Section>

      {/* 2. 市场 */}
      <Section icon={<Store size={15} />} title={t("skillMarket", { defaultValue: "Skill 市场" })} count={market.length}>
        {market.length === 0 ? (
          <Empty text={t("noMarketSkills", { defaultValue: "市场暂无条目（或未联网）。" })} />
        ) : (
          <div className="flex flex-col gap-2">
            {market.map((m) => {
              const installed = installedIds.has(m.id);
              return (
                <Row
                  key={m.id}
                  title={m.name}
                  subtitle={m.description}
                  meta={`v${m.version}${m.category ? " · " + m.category : ""}${m.recommended ? " · ★" : ""}`}
                  action={
                    <Button
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      disabled={installed || installing === m.id}
                      onClick={() => void handleInstall(m.id)}
                    >
                      {installing === m.id ? (
                        <Loader2 size={13} className="mr-1 animate-spin" />
                      ) : (
                        <Download size={13} className="mr-1" />
                      )}
                      {installed ? t("installed", { defaultValue: "已安装" }) : t("install", { defaultValue: "安装" })}
                    </Button>
                  }
                />
              );
            })}
          </div>
        )}
      </Section>

      {/* 3. 外部发现（只读） */}
      <Section icon={<Globe size={15} />} title={t("externalSkills", { defaultValue: "外部发现（只读）" })} count={external.length}>
        {external.length === 0 ? (
          <Empty text={t("noExternalSkills", { defaultValue: "未在 ~/.claude、~/.codex、plugins 中发现 skill。" })} />
        ) : (
          <div className="flex flex-col gap-2">
            {external.map((s) => (
              <Row key={s.id} title={s.name} subtitle={s.description} meta={externalSourceLabel(s.source)} readonly />
            ))}
          </div>
        )}
      </Section>

      {/* 4. 内置 ccpanes（只读） */}
      <Section icon={<ShieldCheck size={15} />} title={t("bundledSkills", { defaultValue: "内置 CC-Panes Skills（只读）" })} count={bundled.length}>
        {bundled.length === 0 ? (
          <Empty text={t("noBundledSkills", { defaultValue: "（内置 skill 列表不可用）" })} />
        ) : (
          <div className="flex flex-col gap-2">
            {bundled.map((s) => (
              <Row key={s.name} title={s.name} subtitle={s.description} meta="ccpanes" readonly />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({ icon, title, count, children }: { icon: React.ReactNode; title: string; count: number; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span style={{ color: "var(--app-text-secondary)" }}>{icon}</span>
        <span className="text-sm font-semibold" style={{ color: "var(--app-text-primary)" }}>{title}</span>
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{count}</Badge>
      </div>
      {children}
    </div>
  );
}

function Row({ title, subtitle, meta, action, readonly }: {
  title: string; subtitle?: string | null; meta?: string; action?: React.ReactNode; readonly?: boolean;
}) {
  return (
    <div
      className="flex items-center gap-3 rounded-lg px-3 py-2.5"
      style={{ border: "1px solid var(--app-border)", opacity: readonly ? 0.85 : 1 }}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate" style={{ color: "var(--app-text-primary)" }}>{title}</span>
          {meta && <span className="text-[11px] shrink-0" style={{ color: "var(--app-text-tertiary)" }}>{meta}</span>}
        </div>
        {subtitle && <div className="text-xs truncate mt-0.5" style={{ color: "var(--app-text-tertiary)" }}>{subtitle}</div>}
      </div>
      {action}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="text-xs px-3 py-4 rounded-lg text-center" style={{ color: "var(--app-text-tertiary)", border: "1px dashed var(--app-border)" }}>{text}</div>;
}
