// 剧本 → 分镜的 LLM 拆分契约（从 DramaStudio 拆出，行数棘轮）。

export const SPLIT_SYSTEM_PROMPT = "You are a storyboard artist for short-form drama. Split the given screenplay into 4 to 12 sequential shots. Respond with ONLY a JSON array; each element must be an object with keys \"title\" (short shot name in the screenplay language), \"dialogue\" (the dialogue or narration of the shot, may be empty) and \"prompt\" (a vivid English image-generation prompt describing the visual content of the shot). No commentary outside the JSON.";

export interface ParsedShot {
  title: string;
  dialogue: string;
  prompt: string;
}

/** Tolerant extraction of the shots array from an LLM reply. */
export function parseShotsReply(text: string): ParsedShot[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("No JSON array found in the reply");
  const parsed = JSON.parse(match[0]) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Reply is not a JSON array");
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const shot = entry as Record<string, unknown>;
    return [{
      title: typeof shot.title === "string" ? shot.title : "",
      dialogue: typeof shot.dialogue === "string" ? shot.dialogue : "",
      prompt: typeof shot.prompt === "string" ? shot.prompt : "",
    }];
  });
}
