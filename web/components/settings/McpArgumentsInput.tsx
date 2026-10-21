import { useTranslation } from "react-i18next";

interface McpArgumentsInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
}

export function McpArgumentsInput({ id, value, onChange, error }: McpArgumentsInputProps) {
  const { t } = useTranslation("settings");
  return (
    <div className="space-y-1.5">
      <textarea
        id={id}
        rows={2}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t("mcpArgsPlaceholder")}
        aria-invalid={Boolean(error)}
        aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
        className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <p id={`${id}-help`} className="text-xs text-muted-foreground">{t("mcpArgsHelp")}</p>
      {error && <p id={`${id}-error`} role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
