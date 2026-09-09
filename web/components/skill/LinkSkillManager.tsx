import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { RefreshCw, FolderPlus, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useLinkSkillStore } from "@/stores";
import { linkSkillService } from "@/services";
import type { LinkState, ManagedSkill } from "@/types";

const AGENT_COLORS: Record<string, string> = {
  ZCode: "var(--app-identity-provider-proxy)",
  Claude: "var(--app-identity-provider-anthropic)",
  Codex: "var(--app-identity-provider-open-ai)",
  Grok: "var(--app-identity-provider-grok)",
  OpenCode: "var(--app-identity-provider-opencode)",
};
const LETTERS: Record<string, string> = {
  ZCode: "Z",
  Claude: "C",
  Codex: "X",
  Grok: "G",
  OpenCode: "O",
};
type StateKey = "linkStateLinked" | "linkStateCopied" | "linkStateNone";
const STATE_KEY: Record<LinkState, StateKey> = {
  linked: "linkStateLinked",
  copied: "linkStateCopied",
  none: "linkStateNone",
};

function colorOf(agent: string): string {
  return AGENT_COLORS[agent] || "var(--app-identity-provider-config-profile)";
}

function letterOf(agent: string): string {
  return LETTERS[agent] || agent.charAt(0).toUpperCase();
}

const FILTERS: Array<{
  key: "all" | "linked" | "copied" | "none";
  labelKey: "linkFilterAll" | "linkFilterLinked" | "linkFilterCopied" | "linkFilterNone";
}> = [
  { key: "all", labelKey: "linkFilterAll" },
  { key: "linked", labelKey: "linkFilterLinked" },
  { key: "copied", labelKey: "linkFilterCopied" },
  { key: "none", labelKey: "linkFilterNone" },
];

export default function LinkSkillManager() {
  const { t } = useTranslation("linkSkills");
  const { t: tNotify } = useTranslation("linkSkills");

  const snapshot = useLinkSkillStore((s) => s.snapshot);
  const loading = useLinkSkillStore((s) => s.loading);
  const busy = useLinkSkillStore((s) => s.busy);
  const targetAgent = useLinkSkillStore((s) => s.targetAgent);
  const statusFilter = useLinkSkillStore((s) => s.statusFilter);
  const keyword = useLinkSkillStore((s) => s.keyword);
  const selection = useLinkSkillStore((s) => s.selection);
  const refresh = useLinkSkillStore((s) => s.refresh);
  const switchWorkspace = useLinkSkillStore((s) => s.switchWorkspace);
  const addWorkspace = useLinkSkillStore((s) => s.addWorkspace);
  const setTargetAgent = useLinkSkillStore((s) => s.setTargetAgent);
  const setStatusFilter = useLinkSkillStore((s) => s.setStatusFilter);
  const setKeyword = useLinkSkillStore((s) => s.setKeyword);
  const toggleSelect = useLinkSkillStore((s) => s.toggleSelect);
  const selectAll = useLinkSkillStore((s) => s.selectAll);
  const invertSelection = useLinkSkillStore((s) => s.invertSelection);
  const clearSelection = useLinkSkillStore((s) => s.clearSelection);
  const enableSelected = useLinkSkillStore((s) => s.enableSelected);
  const disableSelected = useLinkSkillStore((s) => s.disableSelected);
  const updateSelected = useLinkSkillStore((s) => s.updateSelected);

  const [overwrite, setOverwrite] = useState(false);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const rows = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.rows.filter((row) => {
      if (statusFilter !== "all" && !row.statuses.some((s) => s.state === statusFilter)) {
        return false;
      }
      if (keyword) {
        const k = keyword.toLowerCase();
        if (!`${row.skill} ${row.description ?? ""} ${row.repo ?? ""}`.toLowerCase().includes(k)) {
          return false;
        }
      }
      return true;
    });
  }, [snapshot, statusFilter, keyword]);

  const groups = useMemo(() => {
    const order: string[] = [];
    const byRepo = new Map<string, ManagedSkill[]>();
    for (const row of rows) {
      const repo = row.repo ?? t("linkUngrouped");
      if (!byRepo.has(repo)) {
        byRepo.set(repo, []);
        order.push(repo);
      }
      byRepo.get(repo)!.push(row);
    }
    return order.map((repo) => ({ repo, items: byRepo.get(repo)! }));
  }, [rows, t]);

  const targetName = targetAgent === "*" ? t("linkTargetAll") : targetAgent;

  const handleEnable = async () => {
    try {
      const counts = await enableSelected(overwrite);
      toast.success(
        tNotify("linkEnableDone", {
          ok: counts.ok,
          skip: counts.skip,
          conflict: counts.conflict,
          nomaster: counts.nomaster,
          fail: counts.fail,
        })
      );
    } catch (e) {
      toast.error(tNotify("operationFailed", { error: String(e) }));
    }
  };

  const handleDisable = async () => {
    try {
      const counts = await disableSelected();
      toast.success(
        tNotify("linkDisableDone", {
          ok: counts.ok,
          skip: counts.skip,
          protected: counts.protected,
          fail: counts.fail,
        })
      );
    } catch (e) {
      toast.error(tNotify("operationFailed", { error: String(e) }));
    }
  };

  const handleUpdate = async () => {
    if (selection.size === 0) {
      toast.warning(tNotify("linkSelectFirst"));
      return;
    }
    toast.info(tNotify("linkUpdateProgress", { count: selection.size }));
    try {
      const outcomes = await updateSelected();
      const ok = outcomes.filter((o) => o.status === "updated");
      const skipped = outcomes.filter((o) => o.status === "no-source");
      if (ok.length > 0) toast.success(tNotify("linkUpdateDone", { count: ok.length, dirs: ok.map((o) => o.dir).join(", ") }));
      if (skipped.length > 0)
        toast.warning(
          tNotify("linkUpdateNoSource", { count: skipped.length, dirs: skipped.map((o) => o.dir).join(", ") })
        );
    } catch (e) {
      toast.error(tNotify("operationFailed", { error: String(e) }));
    }
  };

  const handleAddWorkspace = async () => {
    const path = window.prompt(t("linkAddProjectPrompt"));
    if (!path) return;
    try {
      const msg = await addWorkspace(path.trim());
      toast.success(msg);
    } catch (e) {
      toast.error(tNotify("operationFailed", { error: String(e) }));
    }
  };

  const toggleAgentForSkill = async (dir: string, agent: string, current: LinkState) => {
    const turnOn = current !== "linked";
    try {
      if (turnOn) {
        const counts = await linkSkillService.enable([dir], agent, null, false);
        if (counts.fail > 0) toast.error(`${dir} @ ${agent}: ${tNotify("operationFailed", { error: "fail" })}`);
        else if (counts.conflict > 0) toast.warning(`${dir} @ ${agent}: ${tNotify("linkConflictSkip")}`);
        else
          toast.success(
            `${dir} @ ${agent} → ${t(STATE_KEY.linked)}${counts.skip ? `（${tNotify("linkAlreadyState")}）` : ""}`
          );
      } else {
        const counts = await linkSkillService.disable([dir], agent, null);
        if (counts.fail > 0) toast.error(`${dir} @ ${agent}: ${tNotify("operationFailed", { error: "fail" })}`);
        else if (counts.protected > 0) toast.warning(`${dir} @ ${agent}: ${tNotify("linkProtectedSkip")}`);
        else toast.success(`${dir} @ ${agent} → ${t(STATE_KEY.none)}`);
      }
      await refresh();
    } catch (e) {
      toast.error(tNotify("operationFailed", { error: String(e) }));
    }
  };

  return (
    <div className="flex h-full flex-col bg-background">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <select
          className="h-8 rounded-md border border-border bg-card px-2 text-xs"
          value={snapshot?.activeWorkspace ?? ""}
          onChange={(e) => switchWorkspace(e.target.value)}
        >
          {(snapshot?.workspaces ?? []).map((w) => (
            <option key={w.name} value={w.name}>
              {w.name}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={handleAddWorkspace}>
          <FolderPlus size={14} className="mr-1" /> {t("linkAddProject")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || selection.size === 0}
          onClick={handleUpdate}
          title={t("linkUpdateTooltip")}
        >
          {busy ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Download size={14} className="mr-1" />}
          {t("linkUpdateSelected")}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => refresh()}>
          <RefreshCw size={14} className="mr-1" /> {t("linkRefresh")}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {/* Agent 计数徽章（点击设为批量目标） */}
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-2.5 shadow-sm">
          {snapshot?.agents.map((agent) => {
            const count = snapshot.rows.filter((r) =>
              r.statuses.some((s) => s.agent === agent.name && s.state === "linked")
            ).length;
            const color = colorOf(agent.name);
            const active = targetAgent === agent.name;
            return (
              <span
                key={agent.name}
                className={`cursor-pointer select-none rounded-full px-3 py-1 text-xs transition-colors ${
                  active ? "ring-2 ring-offset-1" : ""
                }`}
                style={{
                  color,
                  background: `color-mix(in srgb, ${color} 12%, transparent)`,
                  boxShadow: active ? `0 0 0 1px ${color}` : undefined,
                }}
                onClick={() => setTargetAgent(agent.name)}
                title={t("linkTargetTooltip")}
              >
                {agent.name}: <b>{count}</b>
              </span>
            );
          })}
          <span
            className={`cursor-pointer select-none rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground ${
              targetAgent === "*" ? "ring-2 ring-ring ring-offset-1" : ""
            }`}
            onClick={() => setTargetAgent("*")}
          >
            🎯 {t("linkTargetAll")}
          </span>
        </div>

        {/* 搜索 + 状态筛选 */}
        <div className="mt-3 flex items-center gap-2">
          <Input
            className="h-9 flex-1"
            placeholder={t("linkSearchPlaceholder")}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <div className="flex gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  statusFilter === f.key
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-card text-muted-foreground hover:bg-accent/50"
                }`}
                onClick={() => setStatusFilter(f.key)}
              >
                {t(f.labelKey)}
              </button>
            ))}
          </div>
        </div>

        {/* 分组卡片列表 */}
        {loading && !snapshot && (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" /> {t("loading")}
          </div>
        )}
        {snapshot && rows.length === 0 && (
          <div className="py-16 text-center text-sm text-muted-foreground">{t("linkNoMatch")}</div>
        )}
        {groups.map(({ repo, items }) => (
          <div key={repo} className="mt-4">
            <div className="mb-2 flex items-center gap-2 px-1 text-xs font-semibold text-muted-foreground">
              <span className="text-[10px]">◆</span>
              <span>{repo}</span>
              <span className="font-normal">
                ({items.length} {t("linkCountSuffix")})
              </span>
              <span
                className="cursor-pointer rounded bg-accent/60 px-1.5 py-0.5 font-normal hover:bg-accent"
                onClick={() => selectAll(items.map((r) => r.dir))}
                title={t("linkGroupSelectAll")}
              >
                {t("linkGroupSelectAll")}
              </span>
              <span
                className="cursor-pointer rounded bg-accent/60 px-1.5 py-0.5 font-normal hover:bg-accent"
                onClick={() => invertSelection(items.map((r) => r.dir))}
                title={t("linkGroupInvert")}
              >
                {t("linkGroupInvert")}
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {items.map((row) => (
                <div
                  key={row.dir}
                  className={`flex items-center gap-3 rounded-xl border bg-card p-3 shadow-sm transition-colors hover:border-accent/60 ${
                    selection.has(row.dir) ? "border-ring bg-accent/20" : "border-border"
                  }`}
                  onClick={() => toggleSelect(row.dir)}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 cursor-pointer accent-primary"
                    checked={selection.has(row.dir)}
                    onChange={() => toggleSelect(row.dir)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold">{row.skill}</span>
                      {row.url && (
                        <a
                          href={row.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-muted-foreground/70 hover:text-primary"
                          title={t("linkOpenSource")}
                          onClick={(e) => e.stopPropagation()}
                        >
                          ↗
                        </a>
                      )}
                      <Badge variant="secondary" className="text-[11px] font-normal">
                        {row.repo}
                      </Badge>
                      {row.url && (
                        <a
                          className="cursor-pointer text-xs text-muted-foreground/70 hover:text-primary"
                          title={t("linkUpdateOne")}
                          onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              const outcomes = await linkSkillService.update([row.dir], null);
                              const out = outcomes[0];
                              if (out.status === "updated") {
                                toast.success(tNotify("linkUpdatedOne", { detail: out.detail ?? row.dir }));
                                await refresh();
                              } else {
                                toast.warning(`${out.dir}: ${out.detail ?? out.status}`);
                              }
                            } catch (err) {
                              toast.error(tNotify("operationFailed", { error: String(err) }));
                            }
                          }}
                        >
                          ↻ {t("linkUpdateSelected")}
                        </a>
                      )}
                    </div>
                    {row.description && (
                      <div className="truncate text-xs text-muted-foreground">{row.description}</div>
                    )}
                  </div>
                  <div className="flex flex-none items-center gap-1.5">
                    {snapshot?.agents.map((agent) => {
                      const st = row.statuses.find((s) => s.agent === agent.name)?.state ?? "none";
                      const color = colorOf(agent.name);
                      return (
                        <span
                          key={agent.name}
                          title={`${agent.name}: ${t(STATE_KEY[st])}（${t("linkToggleTooltip")}）`}
                          className={`flex h-6 w-6 cursor-pointer items-center justify-center rounded-full text-[11px] font-bold transition-transform hover:scale-110 ${
                            st === "linked"
                              ? "text-white"
                              : st === "copied"
                                ? "border border-primary/60 bg-card text-primary"
                                : "border border-transparent bg-muted text-muted-foreground/60"
                          }`}
                          style={st === "linked" ? { background: color } : undefined}
                          onClick={async (e) => {
                            e.stopPropagation();
                            await toggleAgentForSkill(row.dir, agent.name, st);
                          }}
                        >
                          {letterOf(agent.name)}
                        </span>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* 底部批量操作栏 */}
      {selection.size > 0 && (
        <div className="border-t border-border bg-card px-4 py-2.5">
          <div className="flex items-center gap-3 text-xs">
            <span className="text-muted-foreground">
              {t("linkSelected", { count: selection.size, target: targetName })}
            </span>
            <label className="flex cursor-pointer items-center gap-1 text-muted-foreground" title={t("linkOverwriteTooltip")}>
              <input
                type="checkbox"
                className="h-3.5 w-3.5"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
              />
              {t("linkOverwrite")}
            </label>
            <div className="flex-1" />
            <Button size="sm" disabled={busy} onClick={handleEnable}>
              {t("linkBatchEnable")}
            </Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={handleDisable}>
              {t("linkBatchDisable")}
            </Button>
            <Button size="sm" variant="ghost" onClick={clearSelection}>
              {t("linkClear")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
