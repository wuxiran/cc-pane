import { useThemeStore } from "@/stores";

/** 渐变球体背景（仅 Dark 模式渲染） */
export default function DarkOrbsBackground() {
  const isDark = useThemeStore((s) => s.isDark);
  if (!isDark) return null;
  return (
    <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden">
      <div
        className="absolute rounded-full mix-blend-screen opacity-60"
        style={{
          width: 600,
          height: 600,
          top: -200,
          left: -100,
          background: "var(--app-orb-1)",
          filter: "blur(120px)",
        }}
      />
      <div
        className="absolute rounded-full mix-blend-screen opacity-60"
        style={{
          width: 500,
          height: 500,
          top: "30%",
          right: -150,
          background: "var(--app-orb-2)",
          filter: "blur(150px)",
        }}
      />
      <div
        className="absolute rounded-full mix-blend-screen opacity-60"
        style={{
          width: 400,
          height: 400,
          bottom: -100,
          left: "40%",
          background: "var(--app-orb-3)",
          filter: "blur(130px)",
        }}
      />
    </div>
  );
}
