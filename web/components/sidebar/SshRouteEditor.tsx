import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SshRoutePreview } from "@/components/sidebar/SshRoutePreview";
import {
  proxyNeedsCredentials,
  routeFormToMachineFields,
  type RouteFormState,
} from "@/lib/sshRouteForm";
import type { SshProxyKind } from "@/types";

const NONE = "__none__";

interface SshRouteEditorProps {
  form: RouteFormState;
  setField: <K extends keyof RouteFormState>(
    key: K,
    value: RouteFormState[K],
  ) => void;
  /** 已保存机器，供跳板「引用模式」下拉与路由预览解析使用 */
  machines: readonly import("@/types").SshMachine[];
  /** 当前编辑的机器 id，用于把自己排除出跳板候选，避免自引用循环 */
  excludeMachineId?: string;
  /** keyring 中是否已存代理密码（来自原机器） */
  hasStoredProxyPassword: boolean;
  /** 目标机 host/port，用于路由预览的最后一跳 */
  targetHost: string;
  targetPort: number;
}

function SectionToggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="rounded px-3 py-1 text-xs transition-colors"
      style={{
        background: active ? "var(--app-accent)" : "var(--app-hover)",
        color: active ? "white" : "var(--app-text-primary)",
      }}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-[var(--app-text-secondary)]">
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * SSH 连接路由编辑器：每主机代理（socks5/http）+ 跳板机 + 实时路由预览。
 *
 * 纯受控组件，状态与收敛逻辑都在 `@/lib/sshRouteForm`，本文件只负责渲染。
 * 全部开关用 `aria-pressed` 按钮而非 checkbox，避免与登录密码区的 checkbox 冲突；
 * 代理密码只进内存表单与 keyring，绝不出现在预览或日志里。
 */
export function SshRouteEditor({
  form,
  setField,
  machines,
  excludeMachineId,
  hasStoredProxyPassword,
  targetHost,
  targetPort,
}: SshRouteEditorProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const needsProxyPassword = proxyNeedsCredentials(form);
  const showProxyPasswordInput = needsProxyPassword && form.rememberProxyPassword;
  // 预览直接复用提交时的收敛逻辑，保证所见即所连。
  const derived = routeFormToMachineFields(form);

  const proxyKindOptions: { value: SshProxyKind; label: string }[] = [
    { value: "socks5", label: "SOCKS5" },
    { value: "http", label: "HTTP" },
  ];

  // 排除「引用自己」，避免循环跳板；预览仍用完整 machines 以便解析其它引用。
  const jumpCandidates = excludeMachineId
    ? machines.filter((m) => m.id !== excludeMachineId)
    : machines;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-[var(--app-border)] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-[var(--app-text-secondary)]">
          {t("ssh.route.sectionTitle", { defaultValue: "Connection Route" })}
        </span>
        <div className="flex gap-1">
          <SectionToggle
            active={form.proxyEnabled}
            onClick={() => setField("proxyEnabled", !form.proxyEnabled)}
          >
            {t("ssh.route.proxy", { defaultValue: "Proxy" })}
          </SectionToggle>
          <SectionToggle
            active={form.jumpEnabled}
            onClick={() => setField("jumpEnabled", !form.jumpEnabled)}
          >
            {t("ssh.route.jump", { defaultValue: "Jump host" })}
          </SectionToggle>
        </div>
      </div>

      {form.proxyEnabled && (
        <div className="flex flex-col gap-2 border-t border-[var(--app-border)] pt-2">
          <div className="flex gap-2">
            <div className="w-32">
              <Field label={t("ssh.route.proxyKind", { defaultValue: "Type" })}>
                <Select
                  value={form.proxyKind}
                  onValueChange={(v) =>
                    setField("proxyKind", v as SshProxyKind)
                  }
                >
                  <SelectTrigger size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {proxyKindOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <div className="flex-1">
              <Field
                label={t("ssh.route.proxyHost", { defaultValue: "Proxy host" })}
              >
                <Input
                  value={form.proxyHost}
                  onChange={(e) => setField("proxyHost", e.target.value)}
                  placeholder="proxy.example.com"
                />
              </Field>
            </div>
            <div className="w-24">
              <Field
                label={t("ssh.route.proxyPort", { defaultValue: "Port" })}
              >
                <Input
                  type="number"
                  value={form.proxyPort}
                  onChange={(e) => setField("proxyPort", e.target.value)}
                  placeholder="1080"
                />
              </Field>
            </div>
          </div>

          <Field
            label={t("ssh.route.proxyUsername", {
              defaultValue: "Proxy username (optional)",
            })}
          >
            <Input
              value={form.proxyUsername}
              onChange={(e) => setField("proxyUsername", e.target.value)}
              placeholder={t("ssh.route.proxyUsernamePlaceholder", {
                defaultValue: "Leave blank for anonymous proxy",
              })}
            />
          </Field>

          {needsProxyPassword && (
            <div className="flex flex-col gap-2">
              <SectionToggle
                active={form.rememberProxyPassword}
                onClick={() => {
                  setField("rememberProxyPassword", !form.rememberProxyPassword);
                  if (!form.rememberProxyPassword) {
                    setField("clearStoredProxyPassword", false);
                  }
                }}
              >
                {t("ssh.route.rememberProxyPassword", {
                  defaultValue: "Remember proxy password",
                })}
              </SectionToggle>
              {showProxyPasswordInput && (
                <Input
                  type="password"
                  value={form.proxyPasswordInput}
                  onChange={(e) => {
                    setField("proxyPasswordInput", e.target.value);
                    if (e.target.value.trim()) {
                      setField("clearStoredProxyPassword", false);
                    }
                  }}
                  placeholder={
                    hasStoredProxyPassword
                      ? t("ssh.route.proxyPasswordOptional", {
                          defaultValue: "Leave blank to keep stored password",
                        })
                      : t("ssh.route.proxyPasswordPlaceholder", {
                          defaultValue: "Proxy password",
                        })
                  }
                />
              )}
              {hasStoredProxyPassword && (
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setField("clearStoredProxyPassword", true);
                      setField("rememberProxyPassword", false);
                    }}
                  >
                    {t("ssh.route.clearProxyPassword", {
                      defaultValue: "Clear stored proxy password",
                    })}
                  </Button>
                  {form.clearStoredProxyPassword && (
                    <span className="text-[length:var(--text-micro)] text-[var(--app-text-muted)]">
                      {t("ssh.route.proxyPasswordClearPending", {
                        defaultValue:
                          "Stored proxy password will be removed when you save.",
                      })}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {form.jumpEnabled && (
        <div className="flex flex-col gap-2 border-t border-[var(--app-border)] pt-2">
          <Field
            label={t("ssh.route.jumpMode", { defaultValue: "Jump host source" })}
          >
            <Select
              value={form.jumpMode}
              onValueChange={(v) =>
                setField("jumpMode", v as "reference" | "inline")
              }
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="reference">
                  {t("ssh.route.jumpModeReference", {
                    defaultValue: "Saved machine",
                  })}
                </SelectItem>
                <SelectItem value="inline">
                  {t("ssh.route.jumpModeInline", {
                    defaultValue: "Manual host",
                  })}
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {form.jumpMode === "reference" ? (
            <Field
              label={t("ssh.route.jumpMachine", {
                defaultValue: "Jump machine",
              })}
            >
              <Select
                value={form.jumpMachineId || NONE}
                onValueChange={(v) =>
                  setField("jumpMachineId", v === NONE ? "" : v)
                }
              >
                <SelectTrigger size="sm">
                  <SelectValue
                    placeholder={t("ssh.route.jumpMachinePlaceholder", {
                      defaultValue: "Select a saved machine",
                    })}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>
                    {t("ssh.route.jumpMachineNone", {
                      defaultValue: "None selected",
                    })}
                  </SelectItem>
                  {jumpCandidates.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name} ({m.host}:{m.port})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <>
              <div className="flex gap-2">
                <div className="flex-1">
                  <Field
                    label={t("ssh.route.jumpHost", {
                      defaultValue: "Jump host",
                    })}
                  >
                    <Input
                      value={form.jumpHost}
                      onChange={(e) => setField("jumpHost", e.target.value)}
                      placeholder="jump.example.com"
                    />
                  </Field>
                </div>
                <div className="w-24">
                  <Field
                    label={t("ssh.route.jumpPort", { defaultValue: "Port" })}
                  >
                    <Input
                      type="number"
                      value={form.jumpPort}
                      onChange={(e) => setField("jumpPort", e.target.value)}
                      placeholder="22"
                    />
                  </Field>
                </div>
              </div>
              <Field
                label={t("ssh.route.jumpUser", {
                  defaultValue: "Jump user (optional)",
                })}
              >
                <Input
                  value={form.jumpUser}
                  onChange={(e) => setField("jumpUser", e.target.value)}
                  placeholder="root"
                />
              </Field>
              <Field
                label={t("ssh.route.jumpIdentityFile", {
                  defaultValue: "Jump identity file (optional)",
                })}
              >
                <Input
                  value={form.jumpIdentityFile}
                  onChange={(e) => setField("jumpIdentityFile", e.target.value)}
                  placeholder="~/.ssh/id_rsa"
                />
              </Field>
              <p className="text-[length:var(--text-micro)] text-[var(--app-text-muted)]">
                {t("ssh.route.jumpInlineHint", {
                  defaultValue:
                    "Inline jump hosts authenticate with an identity file or ssh-agent only. To reuse a stored password, reference a saved machine instead.",
                })}
              </p>
            </>
          )}
        </div>
      )}

      <SshRoutePreview
        machine={{
          host: targetHost,
          port: Number.isFinite(targetPort) ? targetPort : 22,
          proxy: derived.proxy,
          jumpHost: derived.jumpHost,
        }}
        machines={machines}
      />
    </div>
  );
}
