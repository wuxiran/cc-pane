import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface SshPasswordSectionProps {
  value: string;
  onValueChange: (value: string) => void;
  remember: boolean;
  onRememberChange: (remember: boolean) => void;
  clear: boolean;
  onClearChange: (clear: boolean) => void;
  hasStoredPassword: boolean;
}

/**
 * 登录密码存储区块（仅密码认证时显示）。
 *
 * 从 `SshMachineDialog` 抽出以腾出行预算给路由编辑器；行为与文案保持不变：
 * 输入密码即取消「清除」，勾选记住即取消「清除」，密码只存在于内存与 keyring。
 */
export function SshPasswordSection({
  value,
  onValueChange,
  remember,
  onRememberChange,
  clear,
  onClearChange,
  hasStoredPassword,
}: SshPasswordSectionProps) {
  const { t } = useTranslation(["sidebar", "common"]);

  return (
    <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg-secondary)] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-[var(--app-text-secondary)]">
          {t("ssh.passwordSection", {
            defaultValue: "Password Storage",
          })}
        </span>
        {hasStoredPassword && (
          <span className="text-[length:var(--text-micro)] text-[var(--app-text-muted)]">
            {t("ssh.passwordStored", {
              defaultValue: "Password stored in system keychain",
            })}
          </span>
        )}
      </div>
      <Input
        type="password"
        value={value}
        onChange={(e) => {
          onValueChange(e.target.value);
          if (e.target.value.trim()) {
            onClearChange(false);
          }
        }}
        placeholder={
          hasStoredPassword
            ? t("ssh.passwordPlaceholderOptional", {
                defaultValue: "Leave blank to keep existing password",
              })
            : t("ssh.passwordPlaceholder", {
                defaultValue: "Enter password",
              })
        }
      />
      <label className="mt-2 flex items-center gap-2 text-xs text-[var(--app-text-secondary)]">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => {
            onRememberChange(e.target.checked);
            if (e.target.checked) {
              onClearChange(false);
            }
          }}
        />
        <span>
          {t("ssh.rememberPassword", {
            defaultValue: "Remember password in system credential store",
          })}
        </span>
      </label>
      {hasStoredPassword && (
        <div className="mt-2 flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              onClearChange(true);
              onRememberChange(false);
            }}
          >
            {t("ssh.clearStoredPassword", {
              defaultValue: "Clear stored password",
            })}
          </Button>
          {clear && (
            <span className="text-[length:var(--text-micro)] text-[var(--app-text-muted)]">
              {t("ssh.passwordClearPending", {
                defaultValue: "Stored password will be removed when you save.",
              })}
            </span>
          )}
        </div>
      )}
      <p className="mt-2 text-[length:var(--text-micro)] text-[var(--app-text-muted)]">
        {t("ssh.passwordNote", {
          defaultValue:
            "Only the first password factor is auto-filled. MFA verification still continues interactively in the terminal.",
        })}
      </p>
    </div>
  );
}
