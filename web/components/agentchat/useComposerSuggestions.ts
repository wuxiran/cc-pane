// 输入框三种补全：`/` 命令（agent 上报的 available_commands）、`@` 先列 Bot 联系人与
// 引擎（默认 Bot，桌面端），再列文件（项目内模糊搜索，发送时由 buildPromptBlocks 转成
// resource_link）、`$` 使用技能（项目技能 + 用户技能）。只看草稿末尾的触发词——与原
// 斜杠菜单同一假设：补全总是在用户正在输入的位置。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AcpAvailableCommand } from "@/types/agentChat";
import { filesystemService } from "@/services/filesystemService";
import { skillService } from "@/services/skillService";
import { handleErrorSilent } from "@/utils/errorHandler";
import { useBotAskStore, type BotMention } from "@/stores/useBotAskStore";
import { ensureBotDirectory } from "./botAskActions";
import { matchBots, matchEngines, mentionToken } from "./botMentions";

export type SuggestionKind = "command" | "file" | "skill" | "bot" | "engine";

export interface ComposerSuggestion {
  key: string;
  kind: SuggestionKind;
  label: string;
  detail?: string | null;
  /** 选中后的完整草稿 */
  nextDraft: string;
  /** Bot / 引擎：选中时记下的结构化提及（发送按它路由）。 */
  mention?: BotMention;
  /** Bot 头像（emoji + 底色）。 */
  avatar?: { glyph: string; color: string };
}

interface SkillEntry {
  name: string;
  description?: string | null;
}

const MAX_ITEMS = 8;
const FILE_SEARCH_DEBOUNCE_MS = 120;

const MENTION_RE = /(?:^|\s)@([^\s@]*)$/;
const SKILL_RE = /(?:^|\s)\$([^\s$]*)$/;

/** 把草稿末尾的 `<trigger><query>` 换成 replacement（保留触发词前的空白）。 */
function replaceTail(draft: string, query: string, trigger: string, replacement: string): string {
  return `${draft.slice(0, draft.length - query.length - trigger.length)}${replacement}`;
}

export function useComposerSuggestions({
  chatId = "",
  draft,
  cwd,
  availableCommands,
}: {
  chatId?: string;
  draft: string;
  cwd: string;
  availableCommands: AcpAvailableCommand[];
}) {
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [files, setFiles] = useState<{ query: string; paths: string[] } | null>(null);
  const [skills, setSkills] = useState<SkillEntry[] | null>(null);
  const skillsCwdRef = useRef<string | null>(null);
  const bots = useBotAskStore((state) => state.bots);
  const engines = useBotAskStore((state) => state.engines);

  const slashQuery = draft.startsWith("/") && !/\s/.test(draft) ? draft.slice(1) : null;
  const mentionQuery = slashQuery === null ? (MENTION_RE.exec(draft)?.[1] ?? null) : null;
  const skillQuery = slashQuery === null && mentionQuery === null ? (SKILL_RE.exec(draft)?.[1] ?? null) : null;

  useEffect(() => {
    setIndex(0);
    setDismissed(false);
  }, [draft]);

  // `@`：首次触发时加载 Bot / 引擎目录（Web 壳下为空，不显示这两组）。
  useEffect(() => {
    if (mentionQuery !== null) ensureBotDirectory();
  }, [mentionQuery]);

  // `@`：防抖后搜项目文件；过期的响应按 query 丢弃。
  useEffect(() => {
    if (mentionQuery === null || !cwd) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      filesystemService
        .searchProjectFiles(cwd, mentionQuery, MAX_ITEMS)
        .then((result) => {
          if (!cancelled) setFiles({ query: mentionQuery, paths: result.paths });
        })
        .catch((error) => {
          // 远端（SSH）会话的 cwd 不在本机：搜不到就退回纯文本引用，不打扰用户。
          handleErrorSilent(error, "search files for @ mention");
          if (!cancelled) setFiles({ query: mentionQuery, paths: [] });
        });
    }, FILE_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mentionQuery, cwd]);

  // `$`：首次触发时按 cwd 拉一次技能（项目 + 用户，同名去重，项目优先）。
  useEffect(() => {
    if (skillQuery === null || skillsCwdRef.current === cwd) return;
    skillsCwdRef.current = cwd;
    void Promise.allSettled([
      cwd ? skillService.listProjectSkills(cwd) : Promise.resolve([]),
      skillService.listUserSkills(),
    ]).then(([project, user]) => {
      const merged = new Map<string, SkillEntry>();
      for (const result of [project, user]) {
        if (result.status !== "fulfilled") continue;
        for (const skill of result.value) {
          if (!merged.has(skill.name)) merged.set(skill.name, { name: skill.name, description: skill.description });
        }
      }
      setSkills([...merged.values()].sort((a, b) => a.name.localeCompare(b.name)));
    });
  }, [skillQuery, cwd]);

  const items = useMemo<ComposerSuggestion[]>(() => {
    if (dismissed) return [];
    if (slashQuery !== null) {
      const query = slashQuery.toLowerCase();
      return availableCommands
        .filter((command) => command.name.toLowerCase().startsWith(query))
        .slice(0, MAX_ITEMS)
        .map((command) => ({
          key: `command:${command.name}`,
          kind: "command",
          label: `/${command.name}`,
          detail: command.description,
          nextDraft: `/${command.name} `,
        }));
    }
    if (mentionQuery !== null) {
      const insert = (token: string) => replaceTail(draft, mentionQuery, "@", `@${token} `);
      const engineLabel = new Map((engines ?? []).map((engine) => [engine.id, engine.label]));
      const botItems = matchBots(bots ?? [], mentionQuery, chatId).map<ComposerSuggestion>((bot) => {
        const token = mentionToken(bot.name);
        return {
          key: `bot:${bot.id}`,
          kind: "bot",
          label: bot.name,
          detail: engineLabel.get(bot.engineId) ?? bot.engineId,
          nextDraft: insert(token),
          mention: { kind: "bot", token, botId: bot.id, name: bot.name },
          avatar: { glyph: bot.avatar.trim() || Array.from(bot.name.trim())[0] || "?", color: bot.color },
        };
      });
      const engineItems = matchEngines(engines ?? [], mentionQuery).map<ComposerSuggestion>((engine) => {
        const token = mentionToken(engine.label);
        return {
          key: `engine:${engine.id}`,
          kind: "engine",
          label: engine.label,
          detail: engine.id === engine.label ? null : engine.id,
          nextDraft: insert(token),
          mention: { kind: "engine", token, engineId: engine.id, name: engine.label },
        };
      });
      const fileItems = files && files.query === mentionQuery
        ? files.paths.map<ComposerSuggestion>((path) => ({
          key: `file:${path}`,
          kind: "file",
          label: path.split("/").pop() || path,
          detail: path,
          nextDraft: insert(path),
        }))
        : [];
      return [...botItems, ...engineItems, ...fileItems];
    }
    if (skillQuery !== null && skills) {
      const query = skillQuery.toLowerCase();
      const commandNames = new Set(availableCommands.map((command) => command.name));
      const prefix = replaceTail(draft, skillQuery, "$", "");
      return skills
        .filter((skill) => skill.name.toLowerCase().includes(query))
        .slice(0, MAX_ITEMS)
        .map((skill) => ({
          key: `skill:${skill.name}`,
          kind: "skill",
          label: `$${skill.name}`,
          detail: skill.description,
          // agent 把这个技能暴露成斜杠命令且它是整条消息的开头 → 用 agent 原生的 `/name`；
          // 否则写 `$name`（Codex / fx 等原生认 `$`，其余 agent 也能读懂这是技能名）。
          nextDraft: commandNames.has(skill.name) && prefix.trim() === ""
            ? `/${skill.name} `
            : `${prefix}$${skill.name} `,
        }));
    }
    return [];
  }, [dismissed, slashQuery, mentionQuery, skillQuery, availableCommands, files, skills, draft, bots, engines, chatId]);

  const move = useCallback(
    (delta: 1 | -1) => setIndex((previous) => (previous + delta + items.length) % Math.max(items.length, 1)),
    [items.length],
  );

  return {
    items,
    index: Math.min(index, Math.max(items.length - 1, 0)),
    setIndex,
    move,
    dismiss: () => setDismissed(true),
    /** 正在 `@` 但还没有结果（无匹配 / 搜索中）时给一行提示。 */
    mentionPending: !dismissed && mentionQuery !== null && items.length === 0 ? mentionQuery : null,
  };
}
