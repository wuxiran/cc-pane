import { Shuffle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ActiveTerminalContext } from "@/hooks/useActiveTerminalSession";
import { useMagpieSessionRoute } from "@/hooks/useMagpieSessionRoute";
import type { MagpieRoute } from "@/types/magpie";

interface MagpieRouteIndicatorProps {
  terminalContext: ActiveTerminalContext;
  enabled?: boolean;
}

/** 当前落在哪个成员：正在试的 / 最后试的，没有就是 agent 点名的模型。 */
export function currentMagpieModel(route: MagpieRoute): string {
  return route.model?.trim() || route.asked;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex justify-between gap-2">
      <span className="shrink-0">{label}</span>
      <span className="truncate text-right text-[var(--app-text-primary)]" title={value}>{value}</span>
    </p>
  );
}

/**
 * 会话走 Magpie 时，状态栏显示这一轮落到哪个账号 / 模型以及换过几次；悬浮看完整路由。
 * Magpie 不在线、会话不走 Magpie、还没有路由时整段不渲染。
 */
export default function MagpieRouteIndicator({
  terminalContext,
  enabled = true,
}: MagpieRouteIndicatorProps) {
  const { t } = useTranslation("common");
  const { cliTool, ssh } = terminalContext;
  const supported = !ssh && (cliTool === "claude" || cliTool === "codex");
  const sessionId = supported ? terminalContext.sessionId ?? null : null;
  const status = useMagpieSessionRoute(sessionId, enabled);
  const route = status?.route;
  if (!status?.available || !route) return null;

  const model = currentMagpieModel(route);
  const switched = status.switchCount > 0
    ? ` · ${t("magpieRoute.switched", { n: status.switchCount })}`
    : "";
  const withEffort = (name: string, effort?: string | null) => (effort ? `${name} · ${effort}` : name);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="magpie-route-indicator"
          aria-label={t("magpieRoute.title")}
          className="flex min-w-0 max-w-48 shrink items-center gap-0.5 whitespace-nowrap"
          style={{ color: "var(--app-text-tertiary)" }}
        >
          <Shuffle className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{`${model}${switched}`}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={8}
        className="w-[280px] space-y-1 rounded-sm border border-[var(--app-border)] bg-[var(--app-overlay)] px-2.5 py-2 text-left text-[11px] text-[var(--app-text-secondary)] shadow-lg text-pretty"
      >
        <p className="font-semibold text-[var(--app-text-primary)]">{t("magpieRoute.title")}</p>
        <DetailRow label={t("magpieRoute.asked")} value={withEffort(route.asked, route.askedEffort)} />
        {route.group ? <DetailRow label={t("magpieRoute.group")} value={route.group} /> : null}
        {route.rule && route.rule.n > 0 ? (
          <DetailRow
            label={t("magpieRoute.rule", { n: route.rule.n })}
            value={[route.rule.useMember, route.rule.pick].filter(Boolean).join(" · ") || "—"}
          />
        ) : null}
        <DetailRow label={t("magpieRoute.current")} value={withEffort(model, route.effort)} />
        {route.served && route.served !== model ? (
          <DetailRow label={t("magpieRoute.served")} value={route.served} />
        ) : null}
        {route.tries.length > 1 ? (
          <div data-testid="magpie-route-tries">
            <p>{t("magpieRoute.tries")}</p>
            <ol className="list-decimal ps-4">
              {route.tries.map((attempt, index) => (
                <li key={`${attempt.model}-${index}`} className="truncate" title={attempt.fail ?? undefined}>
                  {attempt.model}
                  {attempt.fail ? (
                    <span style={{ color: "var(--app-status-warning)" }}>
                      {` · ${attempt.status ? `${attempt.status} ` : ""}${attempt.fail}`}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        <p className="text-[var(--app-text-tertiary)]">
          {route.done
            ? t("magpieRoute.done", { status: route.status ?? "—" })
            : t("magpieRoute.inFlight")}
          {route.ttftMs ? ` · ${t("magpieRoute.ttft", { ms: route.ttftMs })}` : ""}
        </p>
        {status.switchCount > 0 ? (
          <p className="text-[var(--app-text-tertiary)]">{t("magpieRoute.switchedHint", { n: status.switchCount })}</p>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
