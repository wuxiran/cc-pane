import { useTranslation } from "react-i18next";
import { ListTodo } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import TodoManager from "@/components/todo/TodoManager";

interface TodoPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: string;
  scopeRef: string;
}

export default function TodoPanel({
  open,
  onOpenChange,
  scope,
  scopeRef,
}: TodoPanelProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const { t: tDialog } = useTranslation("dialogs");

  const scopeLabel = scope
    ? (
        {
          global: tDialog("todoScopeGlobal"),
          workspace: tDialog("todoScopeWorkspace"),
          project: tDialog("todoScopeProject"),
          external: tDialog("todoScopeExternal"),
          temp_script: tDialog("todoScopeScript"),
        } as Record<string, string>
      )[scope] ?? scope
    : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent resizable className="w-[90vw] h-[85vh] max-w-[95vw] max-h-[92vh] flex flex-col overflow-hidden p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <ListTodo size={18} />
            {t("todoList")}
            {scope && scopeRef && (
              <Badge variant="outline" className="text-xs font-normal">
                {scopeLabel}: {scopeRef}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-hidden">
          <TodoManager scope={scope} scopeRef={scopeRef} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
