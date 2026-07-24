"use client";

import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border border-[var(--app-border)] transition-colors outline-none",
        "data-[state=checked]:bg-[var(--app-accent)] data-[state=unchecked]:bg-[var(--app-hover)]",
        "focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-3.5 rounded-full bg-[var(--app-content)] shadow-sm transition-transform data-[state=checked]:translate-x-[15px] data-[state=unchecked]:translate-x-[1px]"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
