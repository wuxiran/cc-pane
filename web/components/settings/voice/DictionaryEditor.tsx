// 词典：人名、术语按你的写法拼。逗号或换行分隔一次加多个，回车添加。
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Textarea } from "@/components/ui/textarea";
import { VOICE_BUTTON_CLASS, VOICE_BUTTON_STYLE } from "./VoiceSettingsLayout";

// 与 Rust 侧 VOICE_CUSTOM_WORDS_LIMIT / VOICE_CUSTOM_WORD_MAX_CHARS 保持一致
export const DICTIONARY_LIMIT = 100;
export const DICTIONARY_WORD_MAX = 50;

const normalizeTerm = (value: string) => value.replace(/\s+/g, " ").trim().normalize("NFC");

/** 解析输入框里的新词：去空、去重（忽略大小写，含已有词）。 */
export function parseDictionaryDraft(draft: string, existing: readonly string[]): string[] {
  const seen = new Set(existing.map((word) => word.toLocaleLowerCase()));
  const terms: string[] = [];
  for (const raw of draft.split(/[,，、\n]/)) {
    const term = normalizeTerm(raw);
    const key = term.toLocaleLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

export default function DictionaryEditor({ words, onChange }: { words: string[]; onChange: (words: string[]) => void }) {
  const { t } = useTranslation("settings");
  const [draft, setDraft] = useState("");
  const newTerms = parseDictionaryDraft(draft, words);
  const tooLong = newTerms.some((term) => term.length > DICTIONARY_WORD_MAX);
  const overLimit = words.length + newTerms.length > DICTIONARY_LIMIT;
  const canAdd = newTerms.length > 0 && !tooLong && !overLimit;
  const add = () => {
    if (!canAdd) return;
    onChange([...words, ...newTerms]);
    setDraft("");
  };

  return (
    <div className="mt-3 flex flex-col gap-2.5">
      <div className="flex items-start gap-2">
        <Textarea
          value={draft}
          rows={1}
          aria-label={t("voiceDictionaryAdd")}
          placeholder={t("voiceDictionaryPlaceholder")}
          className="min-h-8 flex-1 resize-none py-1.5"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            add();
          }}
        />
        <button type="button" className={VOICE_BUTTON_CLASS} style={VOICE_BUTTON_STYLE} disabled={!canAdd} onClick={add}>
          <Plus aria-hidden="true" />
          {t("voiceDictionaryAddButton")}
        </button>
      </div>
      {tooLong || overLimit ? (
        <p role="alert" className="m-0 text-[length:var(--text-small)]" style={{ color: "var(--app-status-danger)" }}>
          {tooLong ? t("voiceDictionaryTooLong", { max: DICTIONARY_WORD_MAX }) : t("voiceDictionaryFull", { max: DICTIONARY_LIMIT })}
        </p>
      ) : null}
      {words.length > 0 ? (
        <ul aria-label={t("voiceDictionaryEntries")} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {words.map((word) => (
            <li
              key={word}
              className="flex items-center gap-0.5 rounded-md border py-0.5 pe-0.5 ps-2 text-[length:var(--text-small)]"
              style={{ borderColor: "var(--app-border)", background: "var(--app-hover)", color: "var(--app-text-primary)" }}
            >
              <span className="font-medium">{word}</span>
              <button
                type="button"
                aria-label={t("voiceDictionaryRemove", { word })}
                onClick={() => onChange(words.filter((entry) => entry !== word))}
                className="flex size-5 items-center justify-center rounded hover:bg-[var(--app-active-bg)]"
                style={{ color: "var(--app-text-tertiary)" }}
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
