import { useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { loginAccountService } from "@/services/loginAccountService";
import { toastErr, toastInfo, toastOk, toastWarn } from "@/lib/feedback";
import { translateError } from "@/utils";
import { useProvidersStore } from "@/stores";
import { ACCOUNT_COLORS, loginCliToolsForProviderType } from "@/utils/providerAccounts";
import type { DeleteAccountOutcome, LoginAccountView, ProviderType } from "@/types/provider";
import AccountRow from "./AccountRow";
import DeleteAccountDialog from "./DeleteAccountDialog";
import KeychainLeftoverNotice from "./KeychainLeftoverNotice";
import NewLoginAccountDialog, { type NewLoginAccountInput } from "./NewLoginAccountDialog";
import { newKeyAccountDraft, type AccountDraft } from "./drafts";
import { loginViewKey, useLoginAccounts } from "./useLoginAccounts";
import { useLoginTerminal } from "./useLoginTerminal";

/** 已经在后端生效的账号变化（建登录账号 / 删账号）：表单草稿和「未保存」基准都要跟着改。 */
export type PersistedAccountChange =
  | { type: "added"; account: AccountDraft }
  | { type: "removed"; accountId: string };

interface ProviderAccountsSectionProps {
  providerId: string;
  providerType: ProviderType;
  accounts: AccountDraft[];
  defaultAccountId: string | null;
  onChange: (accounts: AccountDraft[], defaultAccountId: string | null) => void;
  onPersisted: (change: PersistedAccountChange) => void;
}

function draftFromLoginView(view: LoginAccountView): AccountDraft {
  return {
    id: view.accountId,
    name: view.name,
    color: view.color ?? null,
    kind: "login",
    secretStorage: "none",
    secret: "",
    cliTool: view.cliTool,
    configDir: view.configDir ?? null,
    env: [],
    isNew: false,
  };
}

function nextColor(accounts: AccountDraft[]): string {
  const used = new Set(accounts.map((account) => account.color));
  return ACCOUNT_COLORS.find((color) => !used.has(color)) ?? ACCOUNT_COLORS[0];
}

export default function ProviderAccountsSection({
  providerId,
  providerType,
  accounts,
  defaultAccountId,
  onChange,
  onPersisted,
}: ProviderAccountsSectionProps) {
  const { t } = useTranslation("providers");
  const loginTools = loginCliToolsForProviderType(providerType);
  const login = useLoginAccounts(providerId, loginTools.length > 0);
  const runLogin = useLoginTerminal();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newLoginOpen, setNewLoginOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AccountDraft | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [keychainNotice, setKeychainNotice] = useState<{ command?: string } | null>(null);

  const effectiveDefault = accounts.some((account) => account.id === defaultAccountId)
    ? defaultAccountId
    : accounts[0]?.id ?? null;
  const viewOf = (accountId: string, cliTool: string | null) =>
    login.views.find((view) => view.accountId === accountId && (!cliTool || view.cliTool === cliTool));
  const defaultLoginViews = login.views.filter((view) => view.isDefaultLogin
    && accounts.some((account) => account.kind === "login" && account.cliTool === view.cliTool));

  const patchAccount = (id: string, patch: Partial<AccountDraft>) =>
    onChange(accounts.map((account) => (account.id === id ? { ...account, ...patch } : account)), defaultAccountId);

  const addKeyAccount = () => {
    const draft = newKeyAccountDraft(
      t("providerAccounts.account.newKeyName", { index: accounts.length + 1 }),
      nextColor(accounts),
    );
    onChange([...accounts, draft], defaultAccountId ?? effectiveDefault);
    setEditingId(draft.id);
  };

  const handleCreateLogin = async (input: NewLoginAccountInput) => {
    const folded = input.name.toLowerCase();
    if (accounts.some((account) => account.name.trim().toLowerCase() === folded)) {
      toastErr(t("providerAccounts.accountProblem.name_duplicate", { name: input.name }));
      return;
    }
    setCreating(true);
    try {
      const view = await loginAccountService.createLoginAccount(providerId, input);
      login.upsert(view);
      onPersisted({ type: "added", account: draftFromLoginView(view) });
      void useProvidersStore.getState().loadProviders?.();
      setNewLoginOpen(false);
      toastOk(t("providerAccounts.newLogin.created", { name: view.name }));
      void runLogin(providerId, view.accountId, view.cliTool);
    } catch (error) {
      toastErr(translateError(error));
    } finally {
      setCreating(false);
    }
  };

  const requestDelete = (draft: AccountDraft) => {
    if (!draft.isNew) {
      setPendingDelete(draft);
      return;
    }
    const remaining = accounts.filter((account) => account.id !== draft.id);
    onChange(remaining, defaultAccountId === draft.id ? remaining[0]?.id ?? null : defaultAccountId);
  };

  const reportOutcome = (outcome: DeleteAccountOutcome, name: string) => {
    toastOk(t("providerAccounts.remove.done", { name }));
    const dir = outcome.configDir ?? "";
    if (outcome.dirDeleted) toastOk(t("providerAccounts.remove.dirDeleted"));
    if (outcome.dirKeptReason === "dir_missing") toastInfo(t("providerAccounts.remove.dirKept.dir_missing"));
    if (outcome.dirKeptReason === "external_dir") toastWarn(t("providerAccounts.remove.dirKept.external_dir", { dir }));
    if (outcome.dirKeptReason === "remove_failed") toastWarn(t("providerAccounts.remove.dirKept.remove_failed", { dir }));
    setKeychainNotice(outcome.keychainCredentialsMayRemain ? { command: outcome.logoutCommand } : null);
  };

  const confirmDelete = async (deleteDir: boolean) => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setDeleting(true);
    try {
      const outcome = await loginAccountService.deleteAccount(providerId, target.id, deleteDir);
      login.remove(target.id);
      onPersisted({ type: "removed", accountId: target.id });
      void useProvidersStore.getState().loadProviders?.();
      if (editingId === target.id) setEditingId(null);
      reportOutcome(outcome, target.name);
    } catch (error) {
      toastErr(translateError(error));
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  };

  return (
    <section className="pt-1" aria-labelledby="provider-accounts-title">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 id="provider-accounts-title" className="text-[length:var(--text-row)] font-semibold" style={{ color: "var(--app-text-primary)" }}>
            {t("providerAccounts.section.accounts")}
          </h3>
          <p className="mt-0.5 text-[length:var(--text-caption)] leading-4" style={{ color: "var(--app-text-secondary)" }}>
            {t("providerAccounts.section.accountsHint")}
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button type="button" variant="outline" size="sm" className="h-8 text-xs" disabled={accounts.length >= 32} onClick={addKeyAccount}>
            <KeyRound size={13} /> {t("providerAccounts.account.addKey")}
          </Button>
          {loginTools.length > 0 && (
            <Button type="button" variant="outline" size="sm" className="h-8 text-xs" disabled={accounts.length >= 32} onClick={() => setNewLoginOpen(true)}>
              <LogIn size={13} /> {t("providerAccounts.account.addLogin")}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {keychainNotice && (
          <KeychainLeftoverNotice logoutCommand={keychainNotice.command} onDismiss={() => setKeychainNotice(null)} />
        )}
        {accounts.map((account) => {
          const view = account.kind === "login" ? viewOf(account.id, account.cliTool) : undefined;
          const cliTool = account.cliTool ?? view?.cliTool ?? null;
          return (
            <AccountRow
              key={account.id}
              draft={account}
              cliTool={cliTool}
              loginStatus={view?.status}
              isDefault={account.id === effectiveDefault}
              editing={editingId === account.id}
              checking={!!cliTool && login.checking.has(loginViewKey(account.id, cliTool))}
              onToggleEdit={() => setEditingId((current) => (current === account.id ? null : account.id))}
              onChange={(patch) => patchAccount(account.id, patch)}
              onSetDefault={() => onChange(accounts, account.id)}
              onDelete={() => requestDelete(account)}
              onRecheck={account.kind === "login" && cliTool ? () => void login.recheck(account.id, cliTool) : undefined}
              onRelogin={account.kind === "login" && cliTool ? () => void runLogin(providerId, account.id, cliTool) : undefined}
            />
          );
        })}
        {defaultLoginViews.map((view) => (
          <AccountRow
            key={`default-login-${view.cliTool}`}
            cliTool={view.cliTool}
            loginStatus={view.status}
            isDefault={false}
            editing={false}
            checking={login.checking.has(loginViewKey(view.accountId, view.cliTool))}
            onRecheck={() => void login.recheck(view.accountId, view.cliTool)}
            onRelogin={() => void runLogin(providerId, view.accountId, view.cliTool)}
          />
        ))}
      </div>

      <NewLoginAccountDialog
        open={newLoginOpen}
        cliTools={loginTools}
        defaultColor={nextColor(accounts)}
        busy={creating}
        onCancel={() => setNewLoginOpen(false)}
        onCreate={(input) => void handleCreateLogin(input)}
      />
      <DeleteAccountDialog
        open={!!pendingDelete}
        name={pendingDelete?.name ?? ""}
        isLogin={pendingDelete?.kind === "login"}
        configDir={pendingDelete?.configDir}
        busy={deleting}
        onCancel={() => setPendingDelete(null)}
        onConfirm={(deleteDir) => void confirmDelete(deleteDir)}
      />
    </section>
  );
}
