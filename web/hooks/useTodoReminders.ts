/**
 * Todo 提醒轮询 Hook
 *
 * 每 60 秒调用 check_todo_reminders 命令，
 * 对到期的 Todo 显示 Sonner toast 通知。
 */
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { todoService } from "@/services";
import i18n from "@/i18n";

const POLL_INTERVAL_MS = 60_000;

export function useTodoReminders() {
  const notifiedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    async function checkReminders() {
      try {
        const dueTodos = await todoService.checkReminders();
        for (const todo of dueTodos) {
          if (!notifiedRef.current.has(todo.id)) {
            notifiedRef.current.add(todo.id);
            toast.info(
              i18n.t("todoReminderTriggered", {
                ns: "dialogs",
                title: todo.title,
              }),
              { duration: 8000 }
            );
            // 10 分钟后允许再次通知（防止永久静默）
            setTimeout(() => {
              notifiedRef.current.delete(todo.id);
            }, 600_000);
          }
        }
      } catch {
        // 轮询失败不影响应用
      }
    }

    // 初始延迟 5 秒后开始轮询
    const startDelay = setTimeout(() => {
      checkReminders();
      timer = setInterval(checkReminders, POLL_INTERVAL_MS);
    }, 5000);

    return () => {
      clearTimeout(startDelay);
      if (timer) clearInterval(timer);
    };
  }, []);
}
