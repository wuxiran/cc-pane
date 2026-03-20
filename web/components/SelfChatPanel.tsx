import { useTranslation } from "react-i18next";
import { Bot } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SelfChatManager } from "@/components/selfchat";

interface SelfChatPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SelfChatPanel({
  open,
  onOpenChange,
}: SelfChatPanelProps) {
  const { t } = useTranslation("common");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent resizable className="w-[90vw] h-[85vh] max-w-[95vw] max-h-[92vh] flex flex-col overflow-hidden p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Bot size={18} />
            {t("selfChat.title")}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-hidden">
          <SelfChatManager />
        </div>
      </DialogContent>
    </Dialog>
  );
}
