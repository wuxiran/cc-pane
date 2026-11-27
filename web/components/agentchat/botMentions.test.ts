import { describe, expect, it } from "vitest";
import type { AcpEngineInfo } from "@/types/agentChat";
import type { BotSummary } from "@/types/bot";
import type { BotMention } from "@/stores/useBotAskStore";
import {
  buildBotAskText,
  findMention,
  matchBots,
  matchEngines,
  mentionToken,
  mentionTokens,
  resolveBotRoute,
} from "./botMentions";

function bot(id: string, name: string, extra: Partial<BotSummary> = {}): BotSummary {
  return {
    id, name, avatar: "", color: "", persona: "", engineId: "claude", autoApproveKinds: [],
    createdAt: 0, updatedAt: 0, chatId: `bot-${id}`, effectiveCwd: "/home", ...extra,
  };
}

const engine = (id: string, label: string, available = true): AcpEngineInfo => ({ id, label, available, requirement: "" });

describe("mentionToken", () => {
  it("折叠空白、去掉 @，保留中文", () => {
    expect(mentionToken("Code Reviewer")).toBe("Code_Reviewer");
    expect(mentionToken("  周报 助手 ")).toBe("周报_助手");
    expect(mentionToken("a@b")).toBe("ab");
    expect(mentionToken("   ")).toBe("bot");
  });
});

describe("matchBots", () => {
  const bots = [
    bot("1", "Reviewer"),
    bot("2", "Code Reviewer"),
    bot("3", "周报助手"),
    bot("4", "Codex", { autoCreated: true }),
    bot("5", "Self"),
  ];

  it("不区分大小写，前缀优先于包含", () => {
    expect(matchBots(bots, "REV", "tab").map((item) => item.id)).toEqual(["1", "2"]);
  });

  it("空查询列出全部手建 Bot，自动 Bot 与当前对话自己的 Bot 不列", () => {
    expect(matchBots(bots, "", "bot-5").map((item) => item.id)).toEqual(["2", "1", "3"]);
  });

  it("中文名与 token 形式都能匹配", () => {
    expect(matchBots(bots, "周报", "tab").map((item) => item.id)).toEqual(["3"]);
    expect(matchBots(bots, "code_r", "tab").map((item) => item.id)).toEqual(["2"]);
  });
});

describe("matchEngines", () => {
  it("只列可用引擎，按 label 或 id 匹配", () => {
    const engines = [engine("claude", "Claude"), engine("codex-app-server", "Codex"), engine("gemini", "Gemini", false)];
    expect(matchEngines(engines, "").map((item) => item.id)).toEqual(["claude", "codex-app-server"]);
    expect(matchEngines(engines, "cod").map((item) => item.id)).toEqual(["codex-app-server"]);
    expect(matchEngines(engines, "gem")).toEqual([]);
  });
});

describe("resolveBotRoute", () => {
  const reviewer: BotMention = { kind: "bot", token: "Code_Reviewer", botId: "2", name: "Code Reviewer" };
  const codex: BotMention = { kind: "engine", token: "Codex", engineId: "codex", name: "Codex" };

  it("以 @Bot 开头：路由给 Bot，正文去掉 token", () => {
    expect(resolveBotRoute("@Code_Reviewer 看看这个 diff", [reviewer], null)).toEqual({
      mention: reviewer,
      message: "看看这个 diff",
    });
  });

  it("正文中间的提及也路由，取最靠前的那个", () => {
    const route = resolveBotRoute("帮我 @Codex 然后 @Code_Reviewer 复查", [reviewer, codex], null);
    expect(route?.mention).toBe(codex);
    expect(route?.message).toBe("帮我 然后 @Code_Reviewer 复查");
  });

  it("token 只按整词匹配，提及被删掉后不再路由", () => {
    expect(resolveBotRoute("@Codexx hi", [codex], null)).toBeNull();
    expect(resolveBotRoute("mail a@Codex", [codex], null)).toBeNull();
    expect(resolveBotRoute("plain text", [codex], null)).toBeNull();
  });

  it("提及记录丢失时，按已知手建 Bot 的 token 兜底识别开头", () => {
    const bots = [bot("2", "Code Reviewer"), bot("4", "Codex", { autoCreated: true })];
    expect(resolveBotRoute("@Code_Reviewer hi", [], bots)).toEqual({
      mention: { kind: "bot", token: "Code_Reviewer", botId: "2", name: "Code Reviewer" },
      message: "hi",
    });
    expect(resolveBotRoute("@Codex hi", [], bots)).toBeNull();
    expect(resolveBotRoute("hi @Code_Reviewer", [], bots)).toBeNull();
  });

  it("只有提及没有正文时 message 为空（界面据此禁用发送）", () => {
    expect(resolveBotRoute("@Codex", [codex], null)?.message).toBe("");
  });
});

describe("findMention / mentionTokens", () => {
  it("返回 @ 的位置", () => {
    expect(findMention("hi @a.b", "a.b")).toBe(3);
    expect(findMention("hi @axb", "a.b")).toBe(-1);
  });

  it("合并结构化提及与手建 Bot 的 token", () => {
    const tokens = mentionTokens(
      [{ kind: "engine", token: "Codex", engineId: "codex", name: "Codex" }],
      [bot("1", "Code Reviewer"), bot("2", "Auto", { autoCreated: true })],
    );
    expect([...tokens].sort()).toEqual(["Code_Reviewer", "Codex"]);
  });
});

describe("buildBotAskText", () => {
  it("相对 @文件换成绝对路径，带路径的附件按行追加，无路径图片计数", () => {
    const result = buildBotAskText(
      "看 @src/a.ts 和 @Codex",
      [
        { kind: "file", name: "b.md", path: "docs/b.md", mimeType: "text/plain", data: "" },
        { kind: "image", name: "shot.png", mimeType: "image/png", data: "AAAA" },
      ],
      "/repo",
      new Set(["Codex"]),
    );
    expect(result.text).toBe("看 @/repo/src/a.ts 和 @Codex\n@/repo/docs/b.md");
    expect(result.skippedImages).toBe(1);
  });
});
