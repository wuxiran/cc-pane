import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import type { ProviderEndpointKind } from "@/types/provider";
import { ENDPOINT_KINDS, filledOtherEndpointCount, type EndpointDraft } from "./endpoints";

interface EndpointsFieldProps {
  /** 主接口：类型只用到一个接口时，它就是原来的「地址」框。 */
  primaryKind: ProviderEndpointKind;
  primary: string;
  others: EndpointDraft;
  onPrimaryChange: (value: string) => void;
  onOthersChange: (others: EndpointDraft) => void;
  placeholder: string;
  /** 预设固定的地址：只读显示。 */
  primaryReadOnly?: boolean;
}

/** 「接口地址」：主接口一直露出；其余三个折叠在「更多接口」里，填过的默认展开。 */
export default function EndpointsField({
  primaryKind,
  primary,
  others,
  onPrimaryChange,
  onOthersChange,
  placeholder,
  primaryReadOnly,
}: EndpointsFieldProps) {
  const { t } = useTranslation(["settings", "providers"]);
  const filled = filledOtherEndpointCount(primaryKind, others);
  const [expanded, setExpanded] = useState(filled > 0);
  const otherKinds = ENDPOINT_KINDS.filter((kind) => kind !== primaryKind);

  return (
    <div className="flex flex-col gap-1.5">
      <FormField label={t("settings:baseUrl")} className="flex flex-col gap-1.5" labelClassName="text-xs font-medium">
        {({ id }) => (
          <Input
            id={id}
            className="h-10 text-sm"
            value={primary}
            onChange={(event) => onPrimaryChange(event.target.value)}
            placeholder={placeholder}
            readOnly={primaryReadOnly}
            style={primaryReadOnly ? { opacity: 0.6 } : undefined}
          />
        )}
      </FormField>
      <div className="text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>
        {t("providers:providerAccounts.endpoints.primaryIs", {
          kind: t(`providers:providerAccounts.endpoints.kind.${primaryKind}`),
        })}
      </div>
      <button
        type="button"
        aria-expanded={expanded}
        className="inline-flex w-fit items-center gap-1 text-[length:var(--text-caption)] hover:underline"
        style={{ color: "var(--app-text-link, var(--app-accent))" }}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {filled > 0
          ? t("providers:providerAccounts.endpoints.moreFilled", { count: filled })
          : t("providers:providerAccounts.endpoints.more")}
      </button>
      {expanded && (
        <div
          className="flex flex-col gap-2 rounded-md border p-3"
          style={{ borderColor: "var(--app-border)", background: "var(--app-panel-bg)" }}
        >
          <p className="text-[length:var(--text-caption)] leading-4" style={{ color: "var(--app-text-secondary)" }}>
            {t("providers:providerAccounts.endpoints.hint")}
          </p>
          {otherKinds.map((kind) => (
            <FormField
              key={kind}
              label={t(`providers:providerAccounts.endpoints.kind.${kind}`)}
              className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-2"
              labelClassName="text-xs font-medium"
            >
              {({ id }) => (
                <Input
                  id={id}
                  className="h-9 text-sm"
                  value={others[kind]}
                  onChange={(event) => onOthersChange({ ...others, [kind]: event.target.value })}
                  placeholder={t("providers:providerAccounts.endpoints.notSet")}
                />
              )}
            </FormField>
          ))}
        </div>
      )}
    </div>
  );
}
