import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { settingsService } from "@/services";
import type { ProxySettings } from "@/types";

interface ProxySectionProps {
  value: ProxySettings;
  onChange: (value: ProxySettings) => void;
}

export default function ProxySection({ value, onChange }: ProxySectionProps) {
  function update<K extends keyof ProxySettings>(key: K, v: ProxySettings[K]) {
    onChange({ ...value, [key]: v });
  }

  async function testProxy() {
    try {
      await settingsService.testProxy();
      toast.success("代理连接测试成功");
    } catch (e) {
      toast.error(`代理测试失败: ${e}`);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[15px] font-semibold mb-1" style={{ color: "var(--app-text-primary)" }}>
        代理设置
      </h3>

      <div className="flex items-center justify-between">
        <Label>启用代理</Label>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => update("enabled", e.target.checked)}
          className="w-4 h-4 cursor-pointer"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>

      {value.enabled && (
        <>
          <div className="flex flex-col gap-1">
            <Label>代理类型</Label>
            <select
              value={value.proxyType}
              onChange={(e) => update("proxyType", e.target.value)}
              className="h-9 px-2 rounded-md text-[13px] outline-none"
              style={{
                border: "1px solid var(--app-border)",
                background: "var(--app-content)",
                color: "var(--app-text-primary)",
              }}
            >
              <option value="http">HTTP</option>
              <option value="socks5">SOCKS5</option>
            </select>
            {value.proxyType === "socks5" && (
              <div
                className="mt-1 px-2.5 py-2 text-xs leading-relaxed rounded-md"
                style={{
                  color: "#92700c",
                  background: "#fef9c3",
                  border: "1px solid #fde047",
                }}
              >
                &#9888; SOCKS5 代理可能不被所有工具支持（如 Claude Code、npm）。建议使用 HTTP 代理，或在本地用代理客户端将 SOCKS5 转为 HTTP 代理。
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <div className="flex flex-col gap-1 flex-1">
              <Label>主机</Label>
              <Input value={value.host} placeholder="127.0.0.1" onChange={(e) => update("host", e.target.value)} />
            </div>
            <div className="flex flex-col gap-1 w-28">
              <Label>端口</Label>
              <Input type="number" value={value.port} placeholder="7890" onChange={(e) => update("port", Number(e.target.value))} />
            </div>
          </div>

          <div className="flex gap-2">
            <div className="flex flex-col gap-1 flex-1">
              <Label>用户名（可选）</Label>
              <Input
                value={value.username ?? ""}
                placeholder="用户名"
                onChange={(e) => update("username", e.target.value || null)}
              />
            </div>
            <div className="flex flex-col gap-1 flex-1">
              <Label>密码（可选）</Label>
              <Input
                type="password"
                value={value.password ?? ""}
                placeholder="密码"
                onChange={(e) => update("password", e.target.value || null)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <Label>排除列表</Label>
            <Input
              value={value.noProxy ?? ""}
              placeholder="localhost,127.0.0.1"
              onChange={(e) => update("noProxy", e.target.value || null)}
            />
            <span className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
              多个地址用逗号分隔
            </span>
          </div>

          <div>
            <Button size="sm" variant="secondary" onClick={testProxy}>测试连接</Button>
          </div>
        </>
      )}
    </div>
  );
}
