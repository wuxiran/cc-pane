// 供应商编辑表单 → 保存载荷（add_provider / update_provider）。
//
// - 新增 / 复制：不带 `accounts`，走旧字段 `apiKey` / `baseUrl`，后端建默认账号——
//   普通密钥供应商的最短新增路径（名字、地址、密钥、保存）不变。
// - 编辑已带账号的供应商：带上 `accounts` / `defaultAccountId` / `endpoints` / `env`，
//   后端以它们为准，旧三字段被忽略。
import type { Provider, ProviderAccount, ProviderModel, ProviderOrigin } from "@/types/provider";
import { isValidProviderContextWindowTokens } from "@/types/provider";
import type { FormState } from "../providerFormState";
import { accountPayload, accountProblem, envPayload, envProblem } from "./drafts";
import { endpointsPayload, primaryEndpointKind } from "./endpoints";

export type ModelsResult =
  | { models: ProviderModel[] }
  | { errorKey: "providerModelIdRequired" | "providerModelContextWindowInvalid" | "providerModelIdsUnique" };

export function normalizeFormModels(form: FormState): ModelsResult {
  const models = form.models.map((model) => ({
    id: model.id.trim(),
    label: model.label?.trim() || null,
    defaultEffort: model.defaultEffort ?? null,
    ...(model.contextWindowTokens === undefined ? {} : { contextWindowTokens: model.contextWindowTokens ?? null }),
    ...(model.hidden ? { hidden: true } : {}),
  }));
  if (models.some((model) => !model.id)) return { errorKey: "providerModelIdRequired" };
  if (models.some((model) => !isValidProviderContextWindowTokens(model.contextWindowTokens))) {
    return { errorKey: "providerModelContextWindowInvalid" };
  }
  if (new Set(models.map((model) => model.id)).size !== models.length) return { errorKey: "providerModelIdsUnique" };
  return { models };
}

/** 表单里第一处账号 / 环境变量问题，返回 providers 命名空间下的文案键与参数。 */
export function accountFormProblem(
  form: FormState,
  manageAccounts: boolean,
): { key: string; params: { name: string } } | null {
  const env = envProblem(form.env);
  if (env) return { key: `providerAccounts.env.problem.${env.problem}`, params: { name: env.name } };
  if (!manageAccounts) return null;
  const account = accountProblem(form.accounts);
  if (account) return { key: `providerAccounts.accountProblem.${account.problem}`, params: { name: account.name } };
  for (const draft of form.accounts) {
    const problem = envProblem(draft.env);
    if (problem) return { key: `providerAccounts.env.problem.${problem.problem}`, params: { name: problem.name } };
  }
  return null;
}

function effectiveDefaultAccountId(form: FormState): string | null {
  if (form.accounts.some((account) => account.id === form.defaultAccountId)) return form.defaultAccountId;
  return form.accounts[0]?.id ?? null;
}

function accountsForSave(form: FormState): ProviderAccount[] {
  const defaultId = effectiveDefaultAccountId(form);
  return form.accounts.map((draft) => {
    const account = accountPayload(draft);
    if (draft.id !== defaultId) return account;
    if (form.providerType === "config_profile") {
      // 「配置目录」类型：默认账号就是一个 Claude 登录账号，目录取表单里的「配置路径」。
      return {
        ...account,
        kind: "login",
        cliTool: "claude",
        configDir: form.configDir.trim() || null,
        secret: null,
        secretStorage: "none",
      };
    }
    // 配置 JSON 里填的密钥：落到默认的密钥账号上（账号自己没填新密钥时）。
    if (account.kind === "api_key" && !account.secret && form.apiKey) {
      return { ...account, secret: form.apiKey, secretStorage: "none" };
    }
    return account;
  });
}

export function buildProviderPayload(
  form: FormState,
  options: {
    id: string;
    models: ProviderModel[];
    isDefault: boolean;
    manageAccounts: boolean;
    /** 编辑时原样带回的来源标记（表单不编辑它）；新增 / 复制不传。 */
    source?: ProviderOrigin | null;
  },
): Provider {
  const { id, models, isDefault, manageAccounts, source } = options;
  const provider: Provider = {
    id,
    name: form.name.trim(),
    providerType: form.providerType,
    apiKey: form.apiKey || null,
    baseUrl: form.baseUrl || null,
    region: form.region || null,
    projectId: form.projectId || null,
    awsProfile: form.awsProfile || null,
    configDir: form.configDir || null,
    codexWireApi: form.codexWireApi || null,
    models,
    defaultModelId: form.defaultModelIndex === null ? null : models[form.defaultModelIndex]?.id ?? models[0]?.id ?? null,
    isDefault,
    endpoints: endpointsPayload(primaryEndpointKind(form.providerType, form.codexWireApi), form.baseUrl, form.endpoints),
    env: envPayload(form.env),
    nativeOverrides: form.nativeOverrides,
    ...(source ? { source } : {}),
    alerts: form.alerts,
  };
  if (!manageAccounts) return provider;
  return {
    ...provider,
    apiKey: null,
    accounts: accountsForSave(form),
    defaultAccountId: effectiveDefaultAccountId(form),
  };
}
