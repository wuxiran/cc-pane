import type { Bot } from "@/types/bot";

/** 圆形头像：emoji 优先，没有就用名字首字。 */
export default function BotAvatar({ bot, size = 28 }: { bot: Pick<Bot, "avatar" | "color" | "name">; size?: number }) {
  const glyph = bot.avatar.trim() || Array.from(bot.name.trim())[0] || "?";
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full font-medium text-white"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.5),
        background: bot.color || "var(--app-accent)",
      }}
    >
      {glyph}
    </span>
  );
}
