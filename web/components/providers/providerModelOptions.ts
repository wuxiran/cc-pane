import type { ProviderModel } from "@/types/provider";

/**
 * 模型下拉的可选项：过滤掉「在下拉中隐藏」的模型，但**保留当前已选中的那一条**——
 * 已引用隐藏模型的启动档仍要能解析、显示为已选（调用方给它打「已隐藏」后缀），
 * 而不是因下拉里没有它就丢失选择。保持原有顺序。
 */
export function providerModelDropdownOptions(
  models: readonly ProviderModel[],
  selectedModelId: string | null | undefined,
): ProviderModel[] {
  return models.filter((model) => !model.hidden || model.id === selectedModelId);
}
