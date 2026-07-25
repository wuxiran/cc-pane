import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface GuidedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  visual: ReactNode;
  footer: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Standard two-column shell for onboarding and feature-introduction flows. */
export default function GuidedDialog({
  open,
  onOpenChange,
  title,
  description,
  visual,
  footer,
  children,
  className,
}: GuidedDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "h-[min(680px,calc(100vh-2rem))] gap-0 overflow-hidden p-0 sm:max-w-[880px]",
          className,
        )}
        showCloseButton={false}
      >
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(180px,0.55fr)] md:grid-cols-[minmax(320px,0.9fr)_minmax(360px,1.1fr)] md:grid-rows-1">
          <section
            className="flex min-h-0 flex-col bg-[var(--app-content)]"
            data-testid="guided-dialog-copy"
          >
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5 pt-6 sm:px-7 sm:pt-7">
              <DialogHeader>
                <DialogTitle>{title}</DialogTitle>
                <DialogDescription>{description}</DialogDescription>
              </DialogHeader>
              <div className="mt-6">{children}</div>
            </div>
            <DialogFooter
              className="shrink-0 border-t border-[var(--app-border)] px-6 py-4 sm:px-7"
              data-testid="guided-dialog-footer"
            >
              {footer}
            </DialogFooter>
          </section>

          <aside
            aria-hidden="true"
            className="relative min-h-0 overflow-hidden border-t border-[var(--app-border)] bg-[var(--app-panel-bg)] md:border-l md:border-t-0"
            data-testid="guided-dialog-visual"
          >
            {visual}
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}
