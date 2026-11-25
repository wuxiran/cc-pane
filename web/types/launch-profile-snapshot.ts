// 会话启动时「实际用的运行配置」快照：随终端 leaf / Agent Chat 标签持久化（布局快照、
// 关闭撤销、跨端同步都原样带着走）。全部字段只读展示用，不参与启动决策之外的任何逻辑。
//
// 可选字段、向后兼容：旧标签没有快照时，展示层沿用「按当前配置推断」的旧口径。

/** 凭证的展示形态（CLI 自带登录 / 登录账号 / 中转站）。只存名字，不存任何密钥。 */
export type LaunchCredentialDisplay =
  | { kind: "cli" }
  | { kind: "login"; name: string }
  | { kind: "relay"; name: string; accountName?: string }
  | { kind: "missingRelay" };

export interface LaunchProfileSnapshot {
  /** 启动时实际解析出的运行配置 id（含回落到默认配置）；null = 系统默认，未用运行配置。 */
  launchProfileId: string | null;
  /** 启动时的配置显示名：配置被删后仍能显示原名。 */
  name?: string;
  /** 未点名、由「默认运行配置」回落得到。 */
  implicitDefault?: boolean;
  /** 启动时的凭证；缺失 = 当时没解析出来（展示层按当前数据推断）。 */
  credential?: LaunchCredentialDisplay;
  /** 启动时的模型；null = CLI 默认。 */
  model: string | null;
  /** 记录时间（ISO 8601）。 */
  capturedAt: string;
}
