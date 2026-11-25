// Composer 的合并选择器（对标 T3）：一个 chip「引擎图标 模型 · 推理档位」，展开为
// 左栏引擎轨（★收藏 + 各引擎，只浏览不切换）/ 中栏可搜索模型表（⌘1…⌘9、显示更多、悬停收藏）/
// 右栏推理档位 / 底栏访问模式。切换到别的引擎的模型才提交换引擎，走调用方给的既有流程。
import { useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import ChatEngineIcon from "./ChatEngineIcon";
import { loadModelFavorites, saveModelFavorites } from "./chatModelFavorites";
import {
  FAVORITES_RAIL, MAX_SHORTCUTS, favoriteRows, filterRows, isFavorite, modelShortName, rowKey,
  shortcutIndex, toggleFavorite, visibleRows, type EffortControl, type PickerModelRow,
} from "./chatModelPickerModel";
import { PickerEffortColumn, PickerModelItem, PickerRail, type PickerEngine } from "./ChatModelPickerParts";

export type { PickerEngine } from "./ChatModelPickerParts";

export interface ChatModelPickerProps {
  /** null = 引擎列表加载中。 */
  engines: readonly PickerEngine[] | null;
  currentEngineId: string | null;
  currentModelId: string | null;
  /** 某引擎可选的模型行（当前引擎来自会话广告，其余来自握手缓存）。 */
  modelsOf: (engineId: string) => PickerModelRow[];
  /** 非当前引擎的模型不可选时给出原因（null = 可选）。 */
  blockedReason: (engineId: string) => string | null;
  /** 浏览非当前引擎时的提示（如「换到另一个引擎继续本对话」）。 */
  switchHint?: string;
  effort: EffortControl | null;
  /** 没有推理档位时右栏的说明（缺省「此模型不支持」）。 */
  effortNote?: string;
  onPickModel: (engineId: string, modelId: string | null) => void;
  onPickEffort?: (value: string) => void;
  /** 底栏右侧（访问模式下拉）。 */
  footer?: ReactNode;
  onBrowseRegistry?: () => void;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}

function detectMac(): boolean {
  return typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");
}

/**
 * 与 formatKeyCombo(`Ctrl+N`) 同口径（mac ⌘N，其余 Ctrl+N）。不直接 import 它：
 * useShortcutsStore → useSettingsStore 的模块环会让单独挂载本组件的测试在导入期崩溃。
 */
function shortcutLabel(index: number, isMac: boolean): string {
  return isMac ? `\u2318${index + 1}` : `Ctrl+${index + 1}`;
}

export default function ChatModelPicker(props: ChatModelPickerProps) {
  const { engines, currentEngineId, currentModelId, modelsOf, effort } = props;
  const { t } = useTranslation("panes");
  const [open, setOpen] = useState(false);
  const [browse, setBrowse] = useState<string>(currentEngineId ?? FAVORITES_RAIL);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [favorites, setFavorites] = useState(loadModelFavorites);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isMac = useMemo(detectMac, []);

  const engineById = (id: string | null) => engines?.find((engine) => engine.id === id) ?? null;
  const engineLabel = (id: string) => engineById(id)?.label ?? id;
  const currentRows = currentEngineId ? modelsOf(currentEngineId) : [];
  const currentRow = currentRows.find((row) => row.modelId === currentModelId) ?? null;
  // 「引擎默认」行（modelId = null）在 chip 上显示引擎名，比「默认模型」更有信息量。
  const modelLabel = (currentRow?.modelId != null ? currentRow.label : null) ?? currentModelId
    ?? (currentEngineId ? engineLabel(currentEngineId) : t("agentChatPickEngine"));
  const effortLabel = effort?.choices.find((choice) => choice.value === effort.current)?.label ?? effort?.current ?? null;

  const sourceRows = browse === FAVORITES_RAIL
    ? favoriteRows(favorites, modelsOf, (id) => engineById(id) !== null)
    : modelsOf(browse);
  const filtered = filterRows(sourceRows, query, engineLabel);
  const { rows, hidden } = visibleRows(filtered, { expanded, query });

  const reset = (nextOpen: boolean) => {
    setOpen(nextOpen);
    props.onOpenChange?.(nextOpen);
    if (!nextOpen) return;
    setBrowse(currentEngineId ?? FAVORITES_RAIL);
    setQuery("");
    setExpanded(false);
    setFavorites(loadModelFavorites());
  };

  const rowBlocked = (row: PickerModelRow) => row.engineId !== currentEngineId ? props.blockedReason(row.engineId) : null;
  const pick = (row: PickerModelRow) => {
    if (rowBlocked(row) !== null) return;
    setOpen(false);
    props.onOpenChange?.(false);
    const same = row.engineId === currentEngineId && row.modelId === currentModelId;
    if (!same) props.onPickModel(row.engineId, row.modelId);
  };
  const flipFavorite = (row: PickerModelRow) => {
    const next = toggleFavorite(favorites, row);
    setFavorites(next);
    saveModelFavorites(next);
  };

  const browsedBlocked = browse !== FAVORITES_RAIL && browse !== currentEngineId ? props.blockedReason(browse) : null;
  const browseNote = browsedBlocked ?? (browse !== FAVORITES_RAIL && browse !== currentEngineId ? props.switchHint : null);
  const loading = engines === null;

  return (
    <Popover open={open} onOpenChange={reset}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={props.disabled || (loading && !currentEngineId)}
          data-testid="chat-model-picker"
          aria-label={t("agentChatModelPickerAria", { label: [modelLabel, effortLabel].filter(Boolean).join(" · ") })}
          className="flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-transparent px-2 text-xs text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] disabled:pointer-events-none disabled:opacity-50"
        >
          {loading && !currentEngineId
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <ChatEngineIcon engineId={currentEngineId ?? undefined} className="h-3.5 w-3.5" />}
          <span className="max-w-40 truncate">{modelLabel}</span>
          {effortLabel ? (
            <>
              <span aria-hidden="true" className="text-[var(--app-text-tertiary)]">·</span>
              <span className="max-w-20 truncate">{effortLabel}</span>
            </>
          ) : null}
          <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        data-testid="chat-model-picker-popover"
        className="w-[min(30rem,calc(100vw-1rem))] overflow-hidden rounded-xl border-[var(--app-border)] bg-[var(--app-overlay)] p-0 text-[var(--app-text-primary)] shadow-[var(--sh-lg)]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
        onKeyDown={(event) => {
          const index = shortcutIndex(event, isMac);
          if (index === null || index >= Math.min(rows.length, MAX_SHORTCUTS)) return;
          event.preventDefault();
          pick(rows[index]);
        }}
      >
        <div className="flex h-[min(22rem,60vh)] min-h-0">
          <PickerRail engines={engines ?? []} browse={browse} currentEngineId={currentEngineId}
            onBrowse={(id) => { setBrowse(id); setExpanded(false); }} onBrowseRegistry={props.onBrowseRegistry} />
          <Command shouldFilter={false} loop className="min-w-0 flex-1 rounded-none bg-transparent">
            <CommandInput ref={inputRef} value={query} onValueChange={setQuery} placeholder={t("agentChatModelSearch")} />
            {browseNote ? (
              <p className="px-3 pt-2 text-[length:var(--text-caption)] leading-snug text-[var(--app-text-tertiary)]">{browseNote}</p>
            ) : null}
            <CommandList className="max-h-none flex-1">
              {loading ? (
                <p className="py-6 text-center text-xs text-[var(--app-text-tertiary)]">{t("agentChatHandoffLoading")}</p>
              ) : rows.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-[var(--app-text-tertiary)]">
                  {query.trim() ? t("agentChatModelNoMatch") : browse === FAVORITES_RAIL ? t("agentChatModelFavoritesEmpty") : t("agentChatModelNone")}
                </p>
              ) : null}
              {rows.map((row, index) => (
                <PickerModelItem
                  key={rowKey(row)}
                  row={row}
                  current={row.engineId === currentEngineId && row.modelId === currentModelId}
                  disabled={rowBlocked(row) !== null}
                  title={rowBlocked(row) ?? undefined}
                  favorite={isFavorite(favorites, row)}
                  shortcut={index < MAX_SHORTCUTS ? shortcutLabel(index, isMac) : null}
                  onPick={() => pick(row)}
                  onToggleFavorite={() => flipFavorite(row)}
                />
              ))}
              {hidden > 0 ? (
                <CommandItem value="__show-more__" onSelect={() => setExpanded(true)}
                  className="justify-center text-xs text-[var(--app-text-secondary)]">
                  {t("agentChatModelShowMore", { count: hidden })}
                </CommandItem>
              ) : null}
            </CommandList>
          </Command>
          <PickerEffortColumn modelLabel={modelShortName(modelLabel)} effort={effort} note={props.effortNote}
            onPick={props.onPickEffort} />
        </div>
        {props.footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-[var(--app-border)] px-2 py-1.5">
            {props.footer}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
