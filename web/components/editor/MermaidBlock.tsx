import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useThemeStore } from "@/stores/useThemeStore";

// mermaid 走动态 import：~2MB 依赖只在文档真的含 ```mermaid 块时才拉取独立 chunk。
// 渲染失败（语法错/环境不支持）回落为原始代码块 + 错误行，不炸预览。
export default function MermaidBlock({ code }: { code: string }) {
  const { t } = useTranslation("editor");
  const isDark = useThemeStore((s) => s.isDark);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reactId = useId();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: isDark ? "dark" : "default",
        });
        const domId = `mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, "")}`;
        const rendered = await mermaid.render(domId, code);
        if (!cancelled) {
          setSvg(rendered.svg);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, isDark, reactId]);

  if (error) {
    return (
      <div>
        <div className="text-xs text-[var(--app-status-danger)]">{t("mermaidError")}</div>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
  }
  if (!svg) {
    // 加载/渲染期间先展示原文，避免闪空
    return (
      <pre>
        <code>{code}</code>
      </pre>
    );
  }
  // biome-ignore/eslint 说明：svg 由 mermaid strict 模式生成，无用户注入 HTML 通路
  return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}
