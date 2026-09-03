# Sub2API（nocannobb）媒体生成接口对接参考

对接 `https://hub.nocannobb.com` 的异步图片 / 视频任务 API。本文件是适配器
（`cc-panes-core/src/services/media_provider.rs` 中的 `Sub2ApiMediaAdapter`）的
权威参考，字段以此为准。鉴权统一为 `Authorization: Bearer <API Key>`（`sk-` 开头，
Key 需绑定对应服务分组）。

## 共同约定

- 异步任务模式：`POST` 提交拿 `task_id` → `GET` 轮询（建议 3–5 秒）→ 下载成品。
- 提交请求必须带 `Idempotency-Key` 头（每个新任务全局唯一，如 UUID）。相同
  Key + 相同请求体返回同一任务；相同 Key + 不同请求体返回 409。
- 任务失败不扣费；HTTP 错误：401 鉴权失败、400 参数错误、404 任务不存在。
- 可选终态回调：`callback_url` + `callback_secret`（HMAC-SHA256，
  `v1=<hex>`，签名串 `timestamp + "." + 原始body`），本地桌面端暂不使用，轮询兜底。

## 视频任务

- 提交：`POST /api/v1/video-tasks`（HTTP 202）
- 查询：`GET /api/v1/video-tasks/{task_id}`
- 成功结果：`result.video_url`（平台签名地址，有有效期，同域 `?exp=&sig=`）
- 状态：`queued` / `running` / `succeeded` / `failed`

请求体字段（白名单，未列字段不要发）：

| 字段 | 说明 |
| --- | --- |
| `model` | 必填。`seedance-2.0[-fast/-mini][-z]`、`seedance-2.0-c`、`seedance-2.5[-z]`、`grok-video-3-y`、`minimax-h3`、`happyhorse-1.0`、`wan3.0-video` |
| `prompt` | 多数模型必填 |
| `duration` | 秒。4–15（seedance-2.5 为 4–30；grok 固定档位 6/10/12/16/20/25/30；minimax/wan 4–15） |
| `resolution` | `480p`/`720p`/`1080p`/`4k`（各模型支持不同；wan 不支持 4k；minimax 内部映射 768P/2K） |
| `aspect_ratio` | `16:9` `9:16` `3:4` `4:3` `1:1` `21:9` `adaptive` |
| `image` | 首帧图 URL（或 `{url}`） |
| `image_tail` | 尾帧，仅 seedance-2.5 与 2.0 的 C/Z 线 |
| `images` | 多图参考数组（seedance2.0≤9、2.5≤30、grok≤7、wan/minimax/happyhorse 支持） |
| `video` | 参考视频（仅 Seedance 与 wan3.0-video） |
| `audio` | 参考音频（仅 Seedance） |

注意：视频任务的素材 URL 官方要求为公网 HTTPS 直链；本地素材以 dataURL 兜底发送，
若上游拒绝会在任务失败原因里透出。

## 图片任务

- 提交：`POST /api/v1/image-tasks`（同一入口，带 `image` 即图生图/多图编辑）
- 查询：`GET /api/v1/image-tasks/{task_id}`
- 下载：`GET /api/v1/image-tasks/{task_id}/files/{idx}.{ext}`（需 Authorization）
- 成功结果：`result.data[]`，按提交时 `response_format` 为 `{url}` 或 `{b64_json}`
- 状态：`queued`/`running`/`succeeded`/`failed`/`expired`/`succeeded_storage_failed`
- 成品保留 3 天 / 总量 1GiB，过期转 `expired`，需及时下载（适配器提交后即下载落盘）

请求体字段（白名单）：

| 字段 | 说明 |
| --- | --- |
| `model` | `gpt-image-2`、`b/gpt-image-2`、`gemini-3.1-flash-image-preview[-plus]`、`gemini-3-pro-image-preview[-plus]`、`gemini-3.1-flash-lite-image` |
| `prompt` | 文生图必填；编辑时描述改动 |
| `image` | 字符串或数组；URL / base64 / dataURL 均可（多图编辑传数组） |
| `mask` | 可选，作用于第一张 image，仅 `gpt-image-2` 支持；不能单独传 |
| `size` | `宽x高` 任意比例，或 `1k`/`2k`/`4k`/`auto`；按最长边归档计费（≤1024=1K，≤2048=2K，其余 4K） |
| `n` | 张数，默认 1（`b/gpt-image-2` 只能 1） |
| `quality` | 透传（`high`/`medium`/`low`，依模型） |
| `response_format` | `url` 或 `b64_json`。适配器固定用 `url` + 带鉴权下载，避免超大 JSON |

## 状态映射（适配器内）

| sub2api | MediaRunStatus |
| --- | --- |
| `queued` | Queued |
| `running` | Processing |
| `succeeded` | Succeeded |
| `failed` / `expired` / `succeeded_storage_failed` | Failed（error.message 透出） |

## 避坑

- 负面词写自然语言（"不要出现 X"），不要 `--no`。
- 一次请求一个 `size`；多规格多次提交；同尺寸多张用 `n`。
- 视频固定档位模型（grok）费用与 `duration` 无关。
- 带参考视频优先 Z 线（`seedance-*-z`），参考视频时长不计费。
- 脚本被 Cloudflare 拦（error 1010）时带常规 `User-Agent`。
