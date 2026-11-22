// 一条供应商下的登录账号视图（含合成的「默认登录」和登录状态），供账号节显示状态用。
import { useCallback, useEffect, useState } from "react";
import { loginAccountService } from "@/services/loginAccountService";
import { handleErrorSilent, translateError } from "@/utils";
import { toastErr } from "@/lib/feedback";
import type { LoginAccountCliTool, LoginAccountView } from "@/types/provider";

export interface LoginAccountsState {
  views: LoginAccountView[];
  /** 正在重新检查的账号（`accountId:cliTool`）。 */
  checking: ReadonlySet<string>;
  recheck: (accountId: string, cliTool: LoginAccountCliTool) => Promise<void>;
  upsert: (view: LoginAccountView) => void;
  remove: (accountId: string) => void;
}

export function loginViewKey(accountId: string, cliTool: string): string {
  return `${accountId}:${cliTool}`;
}

export function useLoginAccounts(providerId: string | null, enabled: boolean): LoginAccountsState {
  const [views, setViews] = useState<LoginAccountView[]>([]);
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!providerId || !enabled) {
      setViews([]);
      return;
    }
    let cancelled = false;
    loginAccountService.listLoginAccounts(providerId)
      .then((list) => { if (!cancelled) setViews(list); })
      .catch((error) => handleErrorSilent(error, "list login accounts"));
    return () => { cancelled = true; };
  }, [providerId, enabled]);

  const recheck = useCallback(async (accountId: string, cliTool: LoginAccountCliTool) => {
    if (!providerId) return;
    const key = loginViewKey(accountId, cliTool);
    setChecking((current) => new Set(current).add(key));
    try {
      const status = await loginAccountService.getLoginStatus(providerId, accountId, cliTool);
      setViews((current) => current.map((view) => (
        view.accountId === accountId && view.cliTool === cliTool ? { ...view, status } : view
      )));
    } catch (error) {
      toastErr(translateError(error));
    } finally {
      setChecking((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, [providerId]);

  const upsert = useCallback((view: LoginAccountView) => {
    setViews((current) => {
      const index = current.findIndex((item) => item.accountId === view.accountId && item.cliTool === view.cliTool);
      if (index < 0) return [...current, view];
      return current.map((item, itemIndex) => (itemIndex === index ? view : item));
    });
  }, []);

  const remove = useCallback((accountId: string) => {
    setViews((current) => current.filter((view) => view.accountId !== accountId || view.isDefaultLogin));
  }, []);

  return { views, checking, recheck, upsert, remove };
}
