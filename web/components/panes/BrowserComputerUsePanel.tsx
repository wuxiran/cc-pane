import "@/i18n/browserToolsResources";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Camera, Copy, LoaderCircle, MousePointer2, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { browserService, type BrowserPageSnapshot } from "@/services/browserService";
import { Button } from "@/components/ui/button";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { getErrorMessage } from "@/utils";

/** Inspect and operate only this owned browser tab; page tokens fence navigation. */
export default function BrowserComputerUsePanel({ tabId, url, onClose }: {
  tabId: string; url: string; onClose: () => void;
}) {
  const { t } = useTranslation("browserTools");
  const [snapshot, setSnapshot] = useState<BrowserPageSnapshot | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [key, setKey] = useState("Enter");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const epoch = useRef(0);
  const lock = useRef(false);
  useEffect(() => {
    epoch.current++; lock.current = false;
    setSnapshot(null); setSelected(null); setError(null); setImage(null); setBusy(false); setText(""); setCopied(false);
    return () => { epoch.current++; };
  }, [tabId, url]);

  const run = useCallback(async (operation: () => Promise<void>) => {
    if (lock.current) return;
    const request = epoch.current;
    lock.current = true; setBusy(true); setError(null); setCopied(false);
    try { await operation(); }
    catch (cause) { if (epoch.current === request) { setError(getErrorMessage(cause)); setSnapshot(null); setSelected(null); } }
    finally { if (epoch.current === request) { lock.current = false; setBusy(false); } }
  }, []);
  const readPage = async () => {
    const request = epoch.current;
    const value = await browserService.snapshot(tabId);
    if (request === epoch.current) { setSnapshot(value); setSelected(null); }
  };
  const act = (operation: (token: string) => Promise<void>) => {
    if (!snapshot) return;
    const token = snapshot.pageToken;
    const request = epoch.current;
    void run(async () => { await operation(token); if (request === epoch.current) await readPage(); });
  };
  const screenshot = () => {
    const request = epoch.current;
    void run(async () => {
      const path = await browserService.screenshot(tabId);
      if (request === epoch.current) setImage(browserService.screenshotUrl(path));
    });
  };
  const copy = () => {
    if (!snapshot) return;
    const request = epoch.current;
    void run(async () => {
      await navigator.clipboard.writeText(`${snapshot.title}\n${snapshot.url}\n\n${snapshot.text}`);
      if (request === epoch.current) setCopied(true);
    });
  };
  const element = snapshot?.elements.find((item) => item.id === selected);
  const elements = snapshot?.elements.filter((item) => `${item.name} ${item.text} ${item.role}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [];

  return <aside aria-label={t("title")} aria-busy={busy} className="flex h-full w-80 max-w-[48%] shrink-0 flex-col border-l border-[var(--app-border)] bg-[var(--app-sidebar)] text-[var(--app-text-primary)]">
    <div className="flex items-center gap-2 border-b border-[var(--app-border)] px-3 py-3">
      <MousePointer2 className="size-4 text-[var(--app-accent)]" /><h2 className="flex-1 text-sm font-medium">{t("title")}</h2>
      <IconTooltipButton label={t("close")} className="size-7" onClick={onClose}><X className="size-4" /></IconTooltipButton>
    </div>
    <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3">
      <p className="text-xs leading-relaxed text-[var(--app-text-secondary)]">{t("description")}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(readPage)}>{busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}{t("readPage")}</Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={screenshot}><Camera className="size-3.5" />{t("screenshot")}</Button>
        <IconTooltipButton label={t("copyPage")} disabled={busy || !snapshot} className="size-8" onClick={copy}><Copy className="size-3.5" /></IconTooltipButton>
      </div>
      {copied && <p role="status" className="text-xs text-[var(--app-status-success)]">{t("copied")}</p>}
      {error && <p role="alert" className="break-words text-xs text-[var(--app-status-danger)]">{error}</p>}
      {snapshot && <>
        <div><h3 className="truncate text-sm font-medium" title={snapshot.title}>{snapshot.title || t("untitled")}</h3><p className="truncate text-xs text-[var(--app-text-tertiary)]" title={snapshot.url}>{snapshot.url}</p></div>
        {snapshot.truncated && <p className="text-xs text-[var(--app-status-warning)]">{t("truncated")}</p>}
        <div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => act((token) => browserService.scroll(tabId, token, 0, -Math.max(100, snapshot.viewport.height * .75)))}><ArrowUp className="size-3.5" />{t("scrollUp")}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => act((token) => browserService.scroll(tabId, token, 0, Math.max(100, snapshot.viewport.height * .75)))}><ArrowDown className="size-3.5" />{t("scrollDown")}</Button></div>
        <div className="space-y-2"><label className="block text-xs font-medium" htmlFor={`browser-elements-${tabId}`}>{t("elements", { count: snapshot.elements.length })}</label>
          <input id={`browser-elements-${tabId}`} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("searchElements")} className="h-8 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-content)] px-2 text-xs" />
          <ul className="max-h-52 space-y-1 overflow-auto" aria-label={t("elementList")}>
            {elements.map((item) => <li key={item.id}><button type="button" disabled={busy || item.disabled} aria-pressed={selected === item.id} onClick={() => { setSelected(item.id); setText(""); }} className={`block w-full rounded-lg border px-2 py-2 text-left text-xs disabled:opacity-50 ${selected === item.id ? "border-[var(--app-accent)] bg-[var(--app-active-bg)]" : "border-transparent hover:bg-[var(--app-hover)]"}`}>
              <span className="line-clamp-2 break-words">{item.name || item.text || item.tag}</span><span className="text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">{item.role || item.tag}</span>
            </button></li>)}
            {!elements.length && <li className="py-3 text-xs text-[var(--app-text-tertiary)]">{t("noElements")}</li>}
          </ul>
        </div>
        {element && <div className="space-y-2 rounded-xl border border-[var(--app-border)] p-2.5">
          <p className="truncate text-xs font-medium">{element.name || element.text || element.tag}</p>
          <Button size="sm" variant="outline" disabled={busy || element.disabled} onClick={() => act((token) => browserService.clickElement(tabId, token, element.id))}>{t("clickElement")}</Button>
          {element.editable && <><textarea aria-label={t("fillText")} value={text} onChange={(event) => setText(event.target.value)} maxLength={32768} rows={2} className="w-full resize-y rounded-lg border border-[var(--app-border)] bg-[var(--app-content)] p-2 text-xs" /><Button size="sm" disabled={busy || element.disabled} onClick={() => act((token) => browserService.fill(tabId, token, element.id, text))}>{t("fill")}</Button></>}
        </div>}
        <div className="flex items-center gap-2"><select aria-label={t("key")} value={key} onChange={(event) => setKey(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-content)] p-2 text-xs">{["Enter", "Tab", "Escape", "Backspace", "ArrowDown", "ArrowUp"].map((value) => <option key={value}>{value}</option>)}</select><Button size="sm" variant="outline" disabled={busy} onClick={() => act((token) => browserService.pressKey(tabId, token, key))}>{t("pressKey")}</Button></div>
        <details className="rounded-lg border border-[var(--app-border)] p-2 text-xs"><summary>{t("pageText")}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words leading-relaxed text-[var(--app-text-secondary)]">{snapshot.text}</pre></details>
      </>}
      {image && <figure><img src={image} alt={t("screenshotAlt")} className="w-full rounded-lg border border-[var(--app-border)]" /><figcaption className="mt-1 text-xs text-[var(--app-text-tertiary)]">{t("screenshotSaved")}</figcaption></figure>}
    </div>
  </aside>;
}
