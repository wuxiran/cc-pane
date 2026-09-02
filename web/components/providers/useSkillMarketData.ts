import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { skillService } from "@/services/skillService";
import type { DiscoveredExternalSkill, InstalledUserSkill, SkillMarketEntry } from "@/types";
import { useExperimentalFeature } from "@/hooks/useExperimentalFeature";

/**
 * Skill 市场 / 已安装 / 外部发现三份只读数据的加载与安装动作。
 *
 * 刻意**不依赖 draft**：`installSkill` 装完只更新自己的列表，再把安装结果经
 * `onInstalled` 回调交给调用方去改 draft（草稿变换全在
 * `launchProfileSkillPolicy.ts`）。这样 hook 可以独立复用，也不会把
 * draft 拖进依赖数组。
 */
export function useSkillMarketData() {
  const { t } = useTranslation(["providers", "common"]);
  const [marketEntries, setMarketEntries] = useState<SkillMarketEntry[]>([]);
  const [userSkills, setUserSkills] = useState<InstalledUserSkill[]>([]);
  const [externalSkills, setExternalSkills] = useState<DiscoveredExternalSkill[]>([]);
  const [skillMarketLoading, setSkillMarketLoading] = useState(false);
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null);
  // Skill 市场是实验功能：未勾选时市场清单恒为空（不发请求），已装/外部照常加载。
  const skillMarketEnabled = useExperimentalFeature("skillMarket");

  const refreshSkillMarket = useCallback(async () => {
    setSkillMarketLoading(true);
    try {
      const [entries, installed, external] = await Promise.all([
        skillMarketEnabled ? skillService.listSkillMarketEntries() : Promise.resolve([]),
        skillService.listUserSkills(),
        skillService.listExternalSkills(),
      ]);
      setMarketEntries(entries);
      setUserSkills(installed);
      setExternalSkills(external);
    } catch (error) {
      toast.error(t("toast.loadSkillFailed", { error: String(error) }));
    } finally {
      setSkillMarketLoading(false);
    }
  }, [skillMarketEnabled, t]);

  useEffect(() => {
    refreshSkillMarket();
  }, [refreshSkillMarket]);

  const installSkill = useCallback(
    async (entry: SkillMarketEntry, onInstalled: (installed: InstalledUserSkill) => void) => {
      setInstallingSkillId(entry.id);
      try {
        const installed = await skillService.installMarketSkill(entry.id);
        setUserSkills((current) => {
          const next = current.filter((skill) => skill.id !== installed.id);
          next.push(installed);
          return next.sort((left, right) => left.name.localeCompare(right.name));
        });
        onInstalled(installed);
        toast.success(t("toast.installedAndEnabled", { name: installed.name }));
      } catch (error) {
        toast.error(t("toast.installSkillFailed", { error: String(error) }));
      } finally {
        setInstallingSkillId(null);
      }
    },
    [t],
  );

  return {
    marketEntries,
    userSkills,
    externalSkills,
    skillMarketLoading,
    installingSkillId,
    refreshSkillMarket,
    installSkill,
  };
}
