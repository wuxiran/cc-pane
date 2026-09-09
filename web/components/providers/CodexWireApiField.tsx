import { useTranslation } from "react-i18next";
import { FormField } from "@/components/ui/form-field";

interface CodexWireApiFieldProps {
  value: string;
  onChange: (value: string) => void;
}

export default function CodexWireApiField({ value, onChange }: CodexWireApiFieldProps) {
  const { t } = useTranslation("settings");
  return (
    <FormField label={t("providerCodexWireApi")} className="flex flex-col gap-1.5" labelClassName="text-xs font-medium">
      {({ id }) => (
        <select
          id={id}
          className="h-10 rounded-md border border-border bg-card px-3 text-sm"
          value={value || "responses"}
          onChange={(event) => onChange(event.target.value === "responses" ? "" : event.target.value)}
        >
          <option value="responses">{t("providerWireApiResponses")}</option>
          <option value="chat">{t("providerWireApiChat")}</option>
        </select>
      )}
    </FormField>
  );
}
