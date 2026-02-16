# 阶段 4：Provider 管理

> 状态：📋 待实现

## 目标

实现工作空间级别的 AI Provider 切换，参考 ccswitch 工具，为用户提供便捷的 Provider 管理和切换功能。

## 背景

Claude Code 支持多种 API Provider，通过环境变量进行切换：

| Provider 类型 | 关键环境变量 |
|---|---|
| Anthropic 直连 | `ANTHROPIC_API_KEY` |
| AWS Bedrock | `CLAUDE_CODE_USE_BEDROCK=1` |
| Google Vertex | `CLAUDE_CODE_USE_VERTEX=1` |

ccswitch 是一个专门的 Claude Code Provider 切换工具。CC-Panes 需要集成类似功能，让用户可以在工作空间或项目级别配置不同的 Provider，启动终端时自动注入对应的环境变量。

## 任务清单

- [ ] 定义 Provider 模型 (名称, 类型, 环境变量配置)
- [ ] 实现 Provider 配置读写 (TOML)
- [ ] 实现工作空间级 Provider 设置
- [ ] 实现项目级 Provider 覆盖 (可选)
- [ ] 启动终端时注入 Provider 环境变量
- [ ] GUI: Provider 选择下拉框 (工作空间设置)
- [ ] GUI: 快速切换 Provider 的工具栏按钮

## Provider 类型

### Anthropic 直连

最常见的使用方式，直接通过 Anthropic API 访问。

- 环境变量: `ANTHROPIC_API_KEY`
- 可选: `ANTHROPIC_BASE_URL` (用于代理)

### AWS Bedrock

通过 AWS Bedrock 服务访问 Claude。

- 环境变量: `CLAUDE_CODE_USE_BEDROCK=1`
- 可选: `AWS_REGION`, `AWS_PROFILE`

### Google Vertex

通过 Google Cloud Vertex AI 访问 Claude。

- 环境变量: `CLAUDE_CODE_USE_VERTEX=1`
- 可选: `CLOUD_ML_REGION`, `ANTHROPIC_VERTEX_PROJECT_ID`

## 环境变量注入方式

在创建 PTY 终端时，通过 portable-pty 的 `CommandBuilder::env()` 方法注入 Provider 相关的环境变量。这样每个终端实例可以使用不同的 Provider 配置，互不干扰。

## 配置层级

1. **全局默认** - 应用级别的默认 Provider
2. **工作空间级** - 每个工作空间可以设置自己的 Provider
3. **项目级** (可选) - 单个项目可以覆盖工作空间的 Provider 设置

优先级: 项目级 > 工作空间级 > 全局默认

## Provider 配置示例 (TOML)

```toml
[[providers]]
id = "anthropic"
name = "Anthropic 直连"
type = "anthropic"
api_key_env = "ANTHROPIC_API_KEY"

[[providers]]
id = "bedrock-us"
name = "AWS Bedrock (美东)"
type = "bedrock"
region = "us-east-1"
profile = "default"

[[providers]]
id = "vertex"
name = "Google Vertex AI"
type = "vertex"
region = "us-central1"
project_id = "my-project"
```
