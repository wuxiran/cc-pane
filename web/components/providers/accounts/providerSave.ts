// 供应商表单「保存」前的纯逻辑：校验 + 组装载荷。不碰 store / 网络，组件只负责提示与提交。
import type { Provider } from "@/types/provider";
import type { FormState } from "../providerFormState";
import { accountFormProblem, buildProviderPayload, normalizeFormModels } from "./providerPayload";

export type ProviderSaveProblem = { key: string; params?: { name: string } };

export type PreparedProviderSave = { provider: Provider } | { problem: ProviderSaveProblem };

export function prepareProviderSave(
  form: FormState,
  options: {
    /** 编辑既有供应商（update）；复制 / 新增为 false（add，重新生成 id）。 */
    saveAsUpdate: boolean;
    manageAccounts: boolean;
    editProvider?: Provider | null;
    providers: readonly Provider[];
    newId: () => string;
  },
): PreparedProviderSave {
  const { saveAsUpdate, manageAccounts, editProvider, providers, newId } = options;
  if (!form.name.trim()) return { problem: { key: "settings:nameRequired" } };
  const normalized = normalizeFormModels(form);
  if ("errorKey" in normalized) return { problem: { key: `settings:${normalized.errorKey}` } };
  const accountProblem = accountFormProblem(form, manageAccounts);
  if (accountProblem) return { problem: { key: `providers:${accountProblem.key}`, params: accountProblem.params } };

  // 只有 update 路径复用既有 id；add 路径（含复制种子）一律重新生成，
  // 防御调用方忘记换 id 时把复制写成覆盖原 Provider。
  const update = saveAsUpdate && editProvider ? editProvider : null;
  const existing = update ? providers.find((p) => p.id === update.id) : undefined;
  const provider = buildProviderPayload(form, {
    id: update ? update.id : newId(),
    models: normalized.models,
    isDefault: existing?.isDefault ?? false,
    manageAccounts,
    // 来源标记不在表单里：编辑时原样带回，否则保存会抹掉「从哪导入」。
    source: update ? existing?.source ?? update.source ?? null : null,
  });
  return { provider };
}
