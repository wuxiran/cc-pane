import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Info } from "lucide-react";
import type { KnownCliTool } from "@/types/terminal";
import type { FormState } from "../providerFormState";
import EnvPreviewSection from "./EnvPreviewSection";
import EnvVarsEditor from "./EnvVarsEditor";
import ProviderAccountsSection, { type PersistedAccountChange } from "./ProviderAccountsSection";

interface ProviderAccountSectionsProps {
  /** 已保存的供应商 id（编辑时）；新增 / 复制时为 null。 */
  providerId: string | null;
  /** 编辑的供应商带了账号（新后端）：显示账号节。 */
  manageAccounts: boolean;
  form: FormState;
  dirty: boolean;
  activeTab?: KnownCliTool;
  onChange: (partial: Partial<FormState>) => void;
  onPersisted: (change: PersistedAccountChange) => void;
}

/**
 * 供应商编辑页的「账号」「环境变量」「启动时实际注入（预览）」三节。
 * 新增时只露出一句说明和折叠的环境变量：普通密钥供应商仍是填名字、地址、密钥、保存。
 */
export default function ProviderAccountSections({
  providerId,
  manageAccounts,
  form,
  dirty,
  activeTab,
  onChange,
  onPersisted,
}: ProviderAccountSectionsProps) {
  const { t } = useTranslation("providers");
  const [envOpen, setEnvOpen] = useState(form.env.length > 0 || !!providerId);
  const showAccounts = !!providerId && manageAccounts && form.providerType !== "config_profile";

  const envEditor = (
    <EnvVarsEditor
      entries={form.env}
      onChange={(env) => onChange({ env })}
      scopeLabel={t("providerAccounts.section.env")}
    />
  );

  return (
    <>
      {showAccounts && providerId && (
        <ProviderAccountsSection
          providerId={providerId}
          providerType={form.providerType}
          accounts={form.accounts}
          defaultAccountId={form.defaultAccountId}
          onChange={(accounts, defaultAccountId) => onChange({ accounts, defaultAccountId })}
          onPersisted={onPersisted}
        />
      )}

      <section className="pt-1" aria-labelledby="provider-env-title">
        <button
          type="button"
          aria-expanded={envOpen}
          className="flex items-center gap-1 text-left"
          onClick={() => setEnvOpen((open) => !open)}
        >
          {envOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <h3 id="provider-env-title" className="text-[length:var(--text-row)] font-semibold" style={{ color: "var(--app-text-primary)" }}>
            {providerId ? t("providerAccounts.section.env") : t("providerAccounts.section.envOptional")}
            {form.env.length > 0 && <span className="ml-1 font-normal opacity-70">({form.env.length})</span>}
          </h3>
        </button>
        {envOpen && (
          <div className="mt-2 flex flex-col gap-2">
            <p className="text-[length:var(--text-caption)] leading-4" style={{ color: "var(--app-text-secondary)" }}>
              {t("providerAccounts.section.envHint")}
            </p>
            {envEditor}
          </div>
        )}
      </section>

      {providerId ? (
        <EnvPreviewSection
          providerId={providerId}
          providerType={form.providerType}
          accounts={form.accounts}
          defaultAccountId={form.defaultAccountId}
          activeTab={activeTab}
          dirty={dirty}
        />
      ) : (
        <p className="flex items-start gap-1.5 text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>
          <Info size={12} className="mt-0.5 shrink-0" />
          {t("providerAccounts.section.afterSaveHint")}
        </p>
      )}
    </>
  );
}
