---
name: video-transcribe
description: 下载用户投喂的单条短视频/视频链接（抖音、小红书、B 站、YouTube、X 等），转成带时间戳的文字稿，存为资料空间 uploads/ 条目。遇到视频链接、或用户说“转文字/扒文案/下载这个视频”时使用。
---

# video-transcribe：视频下载与转写

仅处理用户主动给的**单条**链接，仅供个人学习研究；不要批量或定时抓取。

## 0. 首次使用：检查依赖

```bash
python3 .claude/skills/video-transcribe/scripts/transcribe.py --check
```

输出会列出 yt-dlp、ffmpeg、本地 whisper 是否就绪，以及缺什么、怎么装。把缺失项和安装命令告诉用户，**由用户确认后**再替他执行安装命令。本地 whisper 推荐 whisper.cpp：

- macOS：`brew install yt-dlp ffmpeg whisper-cpp`，然后 `python3 …/transcribe.py --setup-model small` 下载模型（约 470 MB，仅一次）。
- Windows：`winget install yt-dlp.yt-dlp Gyan.FFmpeg`，whisper 用 `pip install faster-whisper`（首次运行自动下载模型）。

## 1. 下载并转写

```bash
python3 .claude/skills/video-transcribe/scripts/transcribe.py "<链接>" --library .
```

- 脚本会自己创建 `uploads/YYYY/MM/<id>-<slug>/`，写入 `assets/video.*`、`assets/cover.jpg`、`assets/meta.json`、`assets/transcript.md`，以及带 frontmatter 的 `index.md`，最后一行打印 JSON 结果（含 `item_dir`、`transcript_source`、`warnings`）。
- 平台有字幕时直接用字幕（快、准）；没有才用本地 whisper 转写。
- 常用参数：`--lang zh`（默认自动识别）、`--model small|medium|large-v3`、`--no-video`（只要音频和文字稿，省空间）、`--cookies-from-browser chrome`（需要登录才能看的视频，**必须先征得用户同意**）。

## 2. 失败时

| 现象 | 处理 |
|---|---|
| 抖音/小红书报需要登录或 Fresh cookies | 征得用户同意后加 `--cookies-from-browser chrome`（或 safari、edge）重试 |
| yt-dlp 报 Unsupported URL | 先 `yt-dlp -U` 升级；仍不支持就让用户把视频文件直接拖进 `inbox/`，再对本地文件运行 `transcribe.py <文件路径> --library .` |
| 没有本地 whisper | 只保存视频、封面和平台文案，`summary` 注明“未转写”，告诉用户安装方法 |

## 3. 收尾
1. 读 `assets/transcript.md`，在 `index.md` 正文里写 3–5 行内容概要，修正 `title`（平台标题常带话题标签和表情，去掉它们）。
2. 告诉用户：条目路径、时长、文字稿来源（字幕 / whisper）。
3. 用户要拆解爆款结构时，再按 `organize` skill 处理这一条。
