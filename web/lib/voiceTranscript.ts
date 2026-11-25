// 转写结果的本地后处理：两个录音入口与设置页试转写共用。
import type { VoiceSettings } from "@/types";

// 中文语气词只在「独立成词」时去掉：句首/标点后，且后面跟标点、空白或结尾。
// 「额」常见于「额外」「额度」，所以必须后接标点才算语气词。
// 字面量写成 \u 转义（嗯 55EF、呃 5443、额 989D、唔 5514；全角标点 FF0C 3002 FF01 FF1F 3001 FF1B、省略号 2026），
// 免得被「裸中文文案」护栏当成界面文字。
const ZH_PUNCT = "\\s\uFF0C\u3002\uFF01\uFF1F\u3001\uFF1B,.!?;";
const ZH_FILLER = new RegExp(
  `(^|[${ZH_PUNCT}])(?:\u55EF+|\u5443+|\u989D|\u5514+)(?:[\uFF0C\u3001,\u3002.\u2026\\s]+|$)`,
  "gu",
);
// 句首紧贴正文的「嗯/呃」（如「呃我想」）也去掉；这两个字几乎不出现在实词里。
const ZH_LEADING_FILLER = /^(?:\u55EF+|\u5443+)(?=\p{Script=Han})/u;
const EN_FILLER = /(^|[\s,.!?;])(?:u+h+m*|u+m+|erm+|hmm+|mm+)(?:[,.]+|\s+|$)/giu;

export function removeFillerWords(text: string): string {
  let next = text;
  // 连续语气词（「嗯，呃，」）要多跑几轮，因为前缀分组会吃掉分隔符
  for (let pass = 0; pass < 3; pass += 1) {
    const before = next;
    next = next.replace(ZH_FILLER, "$1").replace(EN_FILLER, "$1").replace(ZH_LEADING_FILLER, "");
    if (next === before) break;
  }
  return next
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[\s\uFF0C\u3001,]+/u, "")
    .trim();
}

export function finalizeTranscript(text: string, voice: Pick<VoiceSettings, "removeFillerWords"> | undefined): string {
  const trimmed = text.trim();
  if (!voice?.removeFillerWords) return trimmed;
  return removeFillerWords(trimmed);
}
