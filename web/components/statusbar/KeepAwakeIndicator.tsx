import { useEffect, useState } from "react";
import { Coffee } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { keepAwakeService } from "@/services/keepAwakeService";
import { isTauriRuntime } from "@/services/runtime";
import { handleErrorSilent } from "@/utils";

/** 轮询间隔：后端拿锁 / 放锁本身有 5s 采样 + 60s 防抖，这里不需要更快。 */
export const KEEP_AWAKE_POLL_MS = 15_000;

/** 状态栏小图标：持有「阻止系统空闲休眠」锁时显示，否则不渲染。 */
export default function KeepAwakeIndicator() {
  const { t } = useTranslation();
  const [holding, setHolding] = useState(false);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    const refresh = () => {
      keepAwakeService
        .getStatus()
        .then((report) => {
          if (!cancelled) setHolding(report?.holding ?? false);
        })
        .catch((e) => handleErrorSilent(e, "load keep-awake status"));
    };
    refresh();
    const timer = window.setInterval(refresh, KEEP_AWAKE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (!holding) return null;
  const label = t("statusbar.keepAwake");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="img" aria-label={label} className="flex items-center">
          <Coffee className="w-3 h-3" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p>{label}</p>
      </TooltipContent>
    </Tooltip>
  );
}
