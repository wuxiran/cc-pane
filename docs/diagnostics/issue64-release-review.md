# Issue #64 集成与发布审阅

本批集成四个 worker 的终端、启动、用量、主题和线程错误处理改动，保留原有文档站死链与 leader 重新注册修复。代码合入开发分支不代表已经发布。

## 对外行为与契约

- MCP/REST 派工支持可选 `cwd`，独立于项目身份与工作空间配置根。缺省目录由实际 local/WSL/SSH 运行时的项目路径决定；显式路径仍需该运行时校验。core wire 字段为 `launchCwd`。
- `permissionMode` 缺省继承 profile，`default` 关闭本次 CC-Panes YOLO 覆盖，`bypassPermissions` 受 `allowMcpYoloProfiles` 控制。CLI 自身的权限配置仍独立生效。
- Claude MCP 配置只有明确 retired 且超过 7 天才回收；未知旧文件、活跃文件和 Pi 配置保留。Claude 自身 jobs/adopt/respawn 的外部身份问题不在本次闭环内。
- CLI 设置编辑器不依赖宿主检测成功。10 秒结束加载等待，未知状态不当作未安装；当前请求迟到成功仍更新，旧刷新与卸载后的结果不再覆盖。
- `/clear` 的 SessionEnd 清理旧身份，SessionStart clear 回填新身份；历史 CAS/tombstone 与前端来源优先级阻止旧身份、旧用量回灌。
- 显式 cwd 的 hooks 写到实际启动目录，配置偏好仍来自工作空间；历史、启动事件、标签持久化与恢复保持独立 cwd。
- 数据库 v39 仅新增可空的 `terminal_sessions.launch_cwd`，按精确 PTY 从历史回填；旧客户端缺字段更新保留已知 cwd。包含旧库迁移、幂等与读写回归，不操作用户运行中的数据库。
- 纯文本终端观察使用有界 VT 状态，单行 slash 保留键入语义，多行仍使用 bracketed paste。
- `SessionOutput.exited` 只代表实际 PTY wait 证据，`retained` 只在输出可从磁盘读取时为真。归档位于数据目录 `terminal-output`，限制 128 个文件、128 MiB、30 天；单文件最多 2 MiB。旧协议缺字段时不自动收窗。
- 完成任务自动收窗默认关闭，须逐 binding 明确选择会话，并同时满足 completed、非空摘要、实际退出、输出保留。30 秒后复核身份与布局，只关闭单个标签，不 kill、不放入用户撤销栈；摘要与输出仍可回看。

## 发布前审阅发现并修复

1. 静态 CLI fallback 原先把所有工具写为未安装，检测超时会永久禁用启动菜单；已把静态元数据限制在设置编辑器，并保留迟到成功结果。
2. SessionStart 缺少 clear matcher，清理身份后无法回填；已补 matcher 与旧 hook 配置升级测试。
3. 显式 cwd 启动与 hooks 安装目录不一致；已分离配置根和 hook 生效目录。
4. 历史记录与恢复链路丢失显式 cwd；已独立传递并补恢复回归。
5. SSH URI/WSL 本地代理路径不能作为真实 cwd；缺省 cwd 延迟到运行时解析之后确定。

## 验证边界

执行记录与精确退出码保存在工作空间 `evidence/dev-integration-review-20260919`。Windows Node/Rust 检查、浏览器静态像素回放、真实 Windows 桌面与公开 Release 验证分别记账，不能相互替代。

发布仍须针对最终提交核对跨平台 CI、完整安装附件、五平台 updater 元数据及签名。真实 Claude `/clear`、WSL hook 生效、daemon 实际换代、冷恢复与 Windows IME 人工清单未由本文件宣称通过。安装目录文件 hash 一致也不能证明保留中的 daemon 已加载新代码。
