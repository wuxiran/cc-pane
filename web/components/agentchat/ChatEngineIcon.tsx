// 按 ACP engineId 映射 CLI 品牌图标；没有品牌标的引擎（注册表安装、qwen/copilot 等）用通用图标。
import { Bot } from "lucide-react";
import CliBrandIcon, { CLI_BRAND_ICON_TOOLS } from "@/components/CliBrandIcon";
import { CODEX_APP_SERVER_ENGINE } from "@/lib/codexIntegration";

const BRANDED = new Set<string>(CLI_BRAND_ICON_TOOLS);

export function engineBrandId(engineId: string | undefined): string | null {
  if (!engineId) return null;
  if (engineId === CODEX_APP_SERVER_ENGINE) return "codex";
  return BRANDED.has(engineId) ? engineId : null;
}

export default function ChatEngineIcon({ engineId, className = "h-3 w-3" }: { engineId?: string; className?: string }) {
  const brand = engineBrandId(engineId);
  return brand
    ? <CliBrandIcon cliTool={brand} className={`shrink-0 ${className}`} />
    : <Bot className={`shrink-0 ${className}`} aria-hidden="true" data-engine-generic={engineId ?? ""} />;
}
