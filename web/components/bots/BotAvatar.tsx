import { PetThumb } from "@/ccchan/SpritePet";
import { useCCChanStore } from "@/stores/useCCChanStore";
import type { Bot } from "@/types/bot";

type AvatarBot = Pick<Bot, "avatar" | "color" | "name"> & { petId?: string | null };

/** 圆形头像：选了桌宠形象就用精灵首帧缩略图；否则 emoji，再没有就用名字首字。 */
export default function BotAvatar({ bot, size = 28 }: { bot: AvatarBot; size?: number }) {
  const pet = useCCChanStore((state) =>
    bot.petId ? state.pets.find((item) => item.id === bot.petId) : undefined,
  );
  if (pet) {
    return (
      <span
        aria-hidden
        className="flex shrink-0 items-center justify-center overflow-hidden rounded-full"
        style={{ width: size, height: size, background: "var(--app-hover)" }}
      >
        <PetThumb pet={pet} size={size} />
      </span>
    );
  }
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
