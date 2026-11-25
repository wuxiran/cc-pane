import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  BROWSER_IMPORT_ERROR_CODES,
  browserImportService,
  type BrowserCookieImportResult,
  type BrowserImportErrorCode,
  type BrowserImportSource,
} from "@/services/browserImportService";
import { getErrorMessage } from "@/utils";
import { getErrorCode } from "@/utils/errorTranslation";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; sources: BrowserImportSource[] }
  | { status: "error"; message: string };

type ImportState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: BrowserCookieImportResult }
  | { status: "error"; message: string };

function isKnownCode(code: string | null): code is BrowserImportErrorCode {
  return code !== null && (BROWSER_IMPORT_ERROR_CODES as readonly string[]).includes(code);
}

function describeImportError(error: unknown, t: TFunction<"settings">): string {
  const code = getErrorCode(error);
  return isKnownCode(code) ? t(`browserImport.errors.${code}`) : getErrorMessage(error);
}

export default function BrowserImportSection() {
  const { t } = useTranslation("settings");
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [sourceId, setSourceId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [importState, setImportState] = useState<ImportState>({ status: "idle" });

  const describeError = (error: unknown) => describeImportError(error, t);

  useEffect(() => {
    let cancelled = false;
    browserImportService.listSources().then(
      (sources) => {
        if (cancelled) return;
        setLoad({ status: "ready", sources });
        const first = sources[0];
        if (first) {
          setSourceId(first.id);
          setProfileId(first.profiles[0]?.id ?? "");
        }
      },
      (error: unknown) => {
        if (!cancelled) setLoad({ status: "error", message: describeImportError(error, t) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [t]);

  const sources = load.status === "ready" ? load.sources : [];
  const source = useMemo(() => sources.find((s) => s.id === sourceId), [sources, sourceId]);

  const selectSource = (next: string) => {
    setSourceId(next);
    setProfileId(sources.find((s) => s.id === next)?.profiles[0]?.id ?? "");
    setImportState({ status: "idle" });
  };

  const runImport = async () => {
    if (!sourceId || !profileId) return;
    setImportState({ status: "running" });
    try {
      const result = await browserImportService.importCookies(sourceId, profileId);
      setImportState({ status: "done", result });
    } catch (error) {
      setImportState({ status: "error", message: describeError(error) });
    }
  };

  const sourceName = source?.name ?? "Chrome";

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[length:var(--text-title)] font-semibold mb-1" style={{ color: "var(--app-text-primary)" }}>
        {t("browserImport.title")}
      </h3>
      <p className="text-xs mb-3" style={{ color: "var(--app-text-tertiary)" }}>
        {t("browserImport.description")}
      </p>

      <div data-settings-section="browser-import-sources" className="flex flex-col gap-3">
        <div>
          <Label>{t("browserImport.importTitle")}</Label>
          <p className="text-xs mt-0.5" style={{ color: "var(--app-text-tertiary)" }}>
            {t("browserImport.importHint")}
          </p>
        </div>

        {load.status === "loading" && (
          <p className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("browserImport.loading")}</p>
        )}
        {load.status === "error" && (
          <p role="alert" className="text-xs" style={{ color: "var(--app-status-danger)" }}>{load.message}</p>
        )}
        {load.status === "ready" && sources.length === 0 && (
          <p className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("browserImport.noSources")}</p>
        )}

        {load.status === "ready" && sources.length > 0 && (
          <>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="browser-import-source">{t("browserImport.browser")}</Label>
              <Select value={sourceId} onValueChange={selectSource}>
                <SelectTrigger id="browser-import-source" aria-label={t("browserImport.browser")} className="w-56 shrink-0 bg-[var(--app-content)] text-[length:var(--text-row)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sources.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="browser-import-profile">{t("browserImport.profile")}</Label>
              <Select value={profileId} onValueChange={(next) => { setProfileId(next); setImportState({ status: "idle" }); }}>
                <SelectTrigger id="browser-import-profile" aria-label={t("browserImport.profile")} className="w-56 shrink-0 bg-[var(--app-content)] text-[length:var(--text-row)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(source?.profiles ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name === p.id ? p.name : `${p.name} (${p.id})`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <ul className="list-disc pl-5 text-xs leading-relaxed" style={{ color: "var(--app-text-secondary)" }}>
              <li>{t("browserImport.noteQuit", { browser: sourceName })}</li>
              <li>{t("browserImport.noteKeychain")}</li>
              <li>{t("browserImport.noteOneTime")}</li>
              <li>{t("browserImport.noteRelogin")}</li>
            </ul>

            <div className="flex items-center justify-end gap-3">
              <Button
                size="sm"
                onClick={runImport}
                disabled={!profileId || importState.status === "running"}
              >
                {importState.status === "running"
                  ? t("browserImport.importing")
                  : t("browserImport.importButton", { browser: sourceName })}
              </Button>
            </div>

            {importState.status === "done" && (
              <p role="status" className="text-xs" style={{ color: "var(--app-text-secondary)" }}>
                {t("browserImport.result", {
                  imported: importState.result.imported,
                  domains: importState.result.domains,
                })}
                {importState.result.failed > 0 &&
                  ` ${t("browserImport.resultFailed", { failed: importState.result.failed })}`}
              </p>
            )}
            {importState.status === "error" && (
              <p role="alert" className="text-xs" style={{ color: "var(--app-status-danger)" }}>
                {importState.message}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
