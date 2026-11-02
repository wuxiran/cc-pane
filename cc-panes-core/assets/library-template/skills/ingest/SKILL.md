---
name: ingest
description: 把投进资料空间的新素材（inbox/ 里的文件，或用户在对话里给的链接、文字、图片）整理成 uploads/ 下的标准条目。用户投喂内容、说“收一下/存下来”、或 inbox/ 有新文件时使用。
---

# ingest：收素材

## 输入
- `inbox/` 下的文件：`.md`/`.txt`（文字或链接）、图片、音频转写稿等。投喂入口写入的 `.md` 可能带 frontmatter（`url`、`captured_from`、`note`）。
- 或用户在对话里直接贴的内容。

## 步骤
1. **判断类型**
   - 视频平台链接（douyin.com、v.douyin.com、xiaohongshu.com/xhslink.com 的视频笔记、bilibili.com/b23.tv、youtube.com/youtu.be、x.com/twitter.com 带视频、weixin 视频号、weibo 视频）→ 转去执行 `video-transcribe` skill，结束。
   - 文章链接（zhuanlan.zhihu.com、zhihu.com/question/…/answer、mp.weixin.qq.com、x.com 推文/长文、普通网页）→ 第 2 步。
   - 纯文字 / 灵感 → `type: idea`。图片 / 截图 → `type: image`。提示词或 skill → `type: skill`。
2. **抓正文**（文章类）：用你可用的网页抓取工具获取正文，转成干净的 Markdown（保留标题层级、列表、引用、代码块；去掉导航、广告、推荐阅读）。图片下载到 `assets/` 并改为相对链接；下载失败就保留原图 URL。
   - 遇到登录墙或反爬（公众号、知乎部分回答、X 常见）：先告诉用户，再尝试 CC-Panes 内置浏览器（`"$CC_PANES_CTL" call browser_navigate` / `browser_evaluate`，它使用用户在 CC-Panes 里的登录态）。仍拿不到时，只保存链接、标题和用户附带的说明，`summary` 注明“正文未抓取”。
3. **建条目**：`uploads/YYYY/MM/<id>-<slug>/index.md`，按 `CLAUDE.md` 填 frontmatter：`type`、`title`、`platform`、`url`、`author`、`created`（素材发布时间未知就用收集时间）、`status: new`。正文顶部一段 `> ` 引用写一句话摘要，下面放正文或原始内容。
4. **去重**：同一 `url` 已存在条目时，不新建，告诉用户已有条目路径；若用户附带了新说明，追加到原条目末尾的 `## 补充` 小节。
5. **清理**：处理成功后把 `inbox/` 原件移到条目的 `assets/`（保留原始投喂记录）；失败则留在 `inbox/` 并说明原因。
6. **回报**：一两句话说明收到了什么、存在哪。不要自动做深度整理，除非用户要求（那是 `organize` 的事）。
