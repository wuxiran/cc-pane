// 「发现」：精选 + 热门快照，输入查询词时再搜官方 Registry。空查询不联网。
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, Loader2, Search } from "lucide-react";
import { iconGlyph, toneFor } from "@/components/skillmarket/skillMarketModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toastErr, toastOk } from "@/lib/feedback";
import { sharedMcpService } from "@/services";
import { useSharedMcpStore } from "@/stores/useSharedMcpStore";
import type { McpMarketResult, McpMarketServer } from "@/types/shared-mcp";
import { translateError } from "@/utils";
import { handleErrorSilent } from "@/utils/errorHandler";
import { buildSharedConfig, installedServer, marketDescription, missingRequiredInput, needsInputSheet } from "./mcpMarketModel";
import { nextSharedPorts } from "./resourceCenterModel";

const SEARCH_DEBOUNCE_MS = 320;
const PAGE_SIZE = 60;

/** 只在卡片进入视口时才取图标，一页 60 张不会一次发出 60 个请求。 */
function MarketIcon({ server }: { server: McpMarketServer }) {
  const [src, setSrc] = useState<string | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const tone = toneFor(server.name);

  useEffect(() => {
    const element = ref.current;
    if (!element || !server.icon) return;
    let cancelled = false;
    const load = () => {
      sharedMcpService.getMarketIcon(server.icon).then((value) => {
        if (!cancelled) setSrc(value);
      }).catch(() => undefined); // 取不到就留着首字母
    };
    if (typeof IntersectionObserver === "undefined") {
      load();
      return () => { cancelled = true; };
    }
    const observer = new IntersectionObserver((items) => {
      if (items.some((item) => item.isIntersecting)) {
        observer.disconnect();
        load();
      }
    });
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [server.icon]);

  return (
    <span
      ref={ref}
      aria-hidden="true"
      className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg text-sm font-semibold"
      style={{ background: `color-mix(in srgb, var(--app-tag-${tone}) 18%, transparent)`, color: `var(--app-tag-${tone})` }}
    >
      {src ? <img src={src} alt="" className="size-full object-contain" /> : iconGlyph(server.title || server.name)}
    </span>
  );
}

function MarketCard({
  server,
  added,
  busy,
  onAdd,
  onOpen,
}: {
  server: McpMarketServer;
  added: boolean;
  busy: boolean;
  onAdd: () => void;
  onOpen: () => void;
}) {
  const { t, i18n } = useTranslation("settings");
  const remote = Boolean(server.url);
  return (
    <div
      className="flex min-h-36 flex-col gap-2 rounded-xl border p-3"
      style={{ background: "var(--app-card, var(--app-home-surface))", borderColor: "var(--app-border)" }}
      data-testid="mcp-market-card"
      data-market-id={server.id}
    >
      <button type="button" className="flex min-w-0 flex-1 flex-col gap-2 text-left" onClick={onOpen}>
        <span className="flex min-w-0 items-start gap-2.5">
          <MarketIcon server={server} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[length:var(--text-row)] font-semibold" style={{ color: "var(--app-text-primary)" }}>{server.title}</span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[length:var(--text-small)]" style={{ color: "var(--app-text-tertiary)" }}>{server.publisher}</span>
              <Badge variant="secondary" className="shrink-0 text-[length:var(--text-micro)]">{remote ? t("resourceLibrary.remote") : server.runs}</Badge>
              {server.signIn && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="shrink-0" aria-label={t("resourceLibrary.marketSignIn")}><KeyRound size={12} style={{ color: "var(--app-text-tertiary)" }} /></span>
                  </TooltipTrigger>
                  <TooltipContent>{t("resourceLibrary.marketSignIn")}</TooltipContent>
                </Tooltip>
              )}
            </span>
          </span>
        </span>
        <span className="line-clamp-2 text-xs leading-relaxed" style={{ color: "var(--app-text-secondary)" }}>{marketDescription(server, i18n.language)}</span>
      </button>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>{server.name}</span>
        <Button size="sm" variant="outline" className="h-7 shrink-0 text-xs" disabled={added || busy} onClick={onAdd} data-testid="mcp-market-add">
          {busy && <Loader2 size={12} className="mr-1 animate-spin" />}
          {added ? t("resourceLibrary.marketAdded") : needsInputSheet(server) ? t("resourceLibrary.marketAddMore") : t("resourceLibrary.marketAdd")}
        </Button>
      </div>
    </div>
  );
}

function InstallDialog({
  server,
  onClose,
  onSubmit,
}: {
  server: McpMarketServer;
  onClose: () => void;
  onSubmit: (values: Record<string, string>) => Promise<boolean>;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const missing = missingRequiredInput(server, values);
    if (missing) {
      toastErr(t("resourceLibrary.marketRequired", { name: missing.label }));
      return;
    }
    setSaving(true);
    const done = await onSubmit(values);
    setSaving(false);
    if (done) onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md" data-testid="mcp-market-install">
        <DialogHeader>
          <DialogTitle className="text-base">{t("resourceLibrary.marketInstallTitle", { name: server.title })}</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">{t("resourceLibrary.marketInstallHint")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {server.inputs.map((input) => (
            <FormField key={input.key} label={`${input.label}${input.required ? " *" : ""}`} className="space-y-1" labelClassName="text-xs">
              {({ id }) => (
                <div>
                  <Input
                    id={id}
                    type={input.secret ? "password" : "text"}
                    autoComplete="off"
                    value={values[input.key] ?? ""}
                    placeholder={input.placeholder}
                    className="h-8 font-mono text-sm"
                    onChange={(event) => setValues({ ...values, [input.key]: event.target.value })}
                  />
                  {input.description && <p className="mt-1 text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>{input.description}</p>}
                </div>
              )}
            </FormField>
          ))}
        </div>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onClose}>{t("common:cancel")}</Button>
          <Button size="sm" disabled={saving} onClick={() => void submit()} data-testid="mcp-market-install-submit">{t("resourceLibrary.marketAdd")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function McpMarketSection({ active }: { active: boolean }) {
  const { t } = useTranslation("settings");
  const servers = useSharedMcpStore((s) => s.servers);
  const config = useSharedMcpStore((s) => s.config);
  const fetchConfig = useSharedMcpStore((s) => s.fetchConfig);
  const upsertServer = useSharedMcpStore((s) => s.upsertServer);
  const startServer = useSharedMcpStore((s) => s.startServer);

  const [query, setQuery] = useState("");
  const [result, setResult] = useState<McpMarketResult>({ servers: [], partial: false });
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [busy, setBusy] = useState<string | null>(null);
  const [installing, setInstalling] = useState<McpMarketServer | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    if (active) void fetchConfig();
  }, [active, fetchConfig]);

  useEffect(() => {
    if (!active) return;
    const request = ++sequence.current;
    const term = query.trim();
    setLoading(true);
    const run = () => {
      sharedMcpService.searchMarket(term).then((next) => {
        if (request !== sequence.current) return;
        setResult(next);
        setLimit(PAGE_SIZE);
      }).catch((error) => {
        if (request === sequence.current) handleErrorSilent(error, "search mcp market");
      }).finally(() => {
        if (request === sequence.current) setLoading(false);
      });
    };
    const timer = window.setTimeout(run, term ? SEARCH_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [active, query]);

  const shown = useMemo(() => result.servers.slice(0, limit), [result.servers, limit]);

  /** 写入共享层并启动本地服务器。返回是否完成。 */
  const install = async (server: McpMarketServer, values: Record<string, string>): Promise<boolean> => {
    if (servers.some((item) => item.name === server.name)) {
      toastErr(t("resourceLibrary.marketNameExists", { name: server.name }));
      return false;
    }
    setBusy(server.id);
    try {
      let port = 0;
      if (!server.url) {
        if (!config) throw new Error(t("resourceCenter.paste.configNotReady"));
        [port] = nextSharedPorts(servers.map((item) => item.config.port), 1, { start: config.portRangeStart, end: config.portRangeEnd });
      }
      await upsertServer(server.name, buildSharedConfig(server, values, port));
      if (!server.url) await startServer(server.name);
      toastOk(t("resourceLibrary.marketAddedToast", { name: server.title }));
      return true;
    } catch (error) {
      toastErr(t("resourceCenter.saveFailed", { error: translateError(error) }));
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label={t("resourceLibrary.marketTitle")} data-testid="mcp-market-section">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xs font-medium" style={{ color: "var(--app-text-secondary)" }}>{t("resourceLibrary.marketTitle")}</h2>
        <span className="text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>{t("resourceLibrary.marketHint")}</span>
      </div>
      <div className="relative mb-3">
        <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: "var(--app-text-tertiary)" }} />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("resourceLibrary.marketSearch")}
          aria-label={t("resourceLibrary.marketSearch")}
          className="h-9 pl-8 text-sm"
          data-testid="mcp-market-search"
        />
      </div>
      {loading && query.trim() && (
        <p role="status" className="mb-2 flex items-center gap-1.5 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
          <Loader2 size={12} className="animate-spin" />{t("resourceLibrary.marketSearching")}
        </p>
      )}
      {result.partial && !loading && (
        <p role="status" className="mb-2 text-xs" style={{ color: "var(--app-status-warning, var(--app-text-tertiary))" }} data-testid="mcp-market-partial">
          {t("resourceLibrary.marketPartial")}
        </p>
      )}
      {!loading && shown.length === 0 && (
        <p className="py-6 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("resourceLibrary.marketEmpty")}</p>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
        {shown.map((server) => {
          const added = Boolean(installedServer(server, servers));
          return (
            <MarketCard
              key={server.id}
              server={server}
              added={added}
              busy={busy === server.id}
              onOpen={() => { if (server.inputs.length > 0 && !added) setInstalling(server); }}
              onAdd={() => { if (needsInputSheet(server)) setInstalling(server); else void install(server, {}); }}
            />
          );
        })}
      </div>
      {result.servers.length > limit && (
        <div className="mt-3 flex justify-center">
          <Button size="sm" variant="ghost" onClick={() => setLimit(limit + PAGE_SIZE)}>{t("resourceLibrary.marketMore")}</Button>
        </div>
      )}
      {installing && (
        <InstallDialog server={installing} onClose={() => setInstalling(null)} onSubmit={(values) => install(installing, values)} />
      )}
    </section>
  );
}
