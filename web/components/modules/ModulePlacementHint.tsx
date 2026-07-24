import { useState } from "react";
import { CircleHelp } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const MODULE_PLACEMENT_HINT_KEY = "cc-panes-module-placement-hint-seen";

function reserveFirstHint(): boolean {
  try {
    if (sessionStorage.getItem(MODULE_PLACEMENT_HINT_KEY)) return false;
    sessionStorage.setItem(MODULE_PLACEMENT_HINT_KEY, "reserved");
    return true;
  } catch {
    return false;
  }
}

interface ModulePlacementHintProps {
  label: string;
}

export default function ModulePlacementHint({ label }: ModulePlacementHintProps) {
  const [open, setOpen] = useState(reserveFirstHint);

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          className="ml-auto inline-flex size-4 items-center justify-center text-[var(--app-text-tertiary)]"
        >
          <CircleHelp aria-hidden="true" className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-64 text-[12px]">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
