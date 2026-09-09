//! 远程更新：把 GitHub 来源技能的最新版拉取并替换 master 原件。
//! 定位策略：git trees API 枚举 `*/SKILL.md`（任意层级），按路径名匹配，
//! 改名场景用 frontmatter name 兜底；下载 tarball 后只解出所需子树，备份+回滚原子替换。
use crate::utils::{AppError, AppResult};
use cc_panes_core::models::link_skill::UpdateOutcome;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

const USER_AGENT: &str = "skills-manager";

pub struct SkillRemoteUpdateService {
    http: reqwest::Client,
}

impl SkillRemoteUpdateService {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(180))
            .build()
            .unwrap_or_default();
        Self { http }
    }

    /// 读取 gh CLI 的认证 token（存在则大幅提高 GitHub API 限额；不存在则匿名访问）
    fn gh_token(&self) -> Option<String> {
        let out = std::process::Command::new("gh")
            .args(["auth", "token"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if token.is_empty() {
            None
        } else {
            Some(token)
        }
    }

    async fn gh_json(&self, path: &str, token: Option<&str>) -> AppResult<Value> {
        let mut req = self
            .http
            .get(format!("https://api.github.com{path}"))
            .header("accept", "application/vnd.github+json");
        if let Some(token) = token {
            req = req.bearer_auth(token);
        }
        let resp = req
            .send()
            .await
            .map_err(|err| AppError::from(format!("GitHub API 请求失败: {err}")))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|err| AppError::from(format!("GitHub API 响应读取失败: {err}")))?;
        if !status.is_success() {
            return Err(AppError::from(format!("GitHub API {status}: {text}")));
        }
        serde_json::from_str(&text)
            .map_err(|err| AppError::from(format!("GitHub API 响应解析失败: {err}")))
    }

    fn parse_repo_url(repo_url: &str) -> Option<(String, String)> {
        let rest = repo_url.strip_prefix("https://github.com/")?;
        let rest = rest.trim_end_matches('/');
        let rest = rest.strip_suffix(".git").unwrap_or(rest);
        let (owner, repo) = rest.split_once('/')?;
        if owner.is_empty() || repo.is_empty() {
            return None;
        }
        Some((owner.to_string(), repo.to_string()))
    }

    /// 在仓库树中定位技能目录：路径名匹配（最浅优先）→ frontmatter name 兜底
    async fn locate_skill_dir(
        &self,
        base: &str,
        dir_name: &str,
        branch: &str,
        token: Option<&str>,
    ) -> AppResult<String> {
        let tree = self
            .gh_json(
                &format!("{base}/git/trees/{}?recursive=1", path_encode(branch)),
                token,
            )
            .await?;
        if tree["truncated"].as_bool().unwrap_or(false) {
            return Err(AppError::from("仓库文件树过大，无法枚举（truncated）"));
        }
        let paths: Vec<String> = tree["tree"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|t| t["path"].as_str())
                    .filter(|p| *p == "SKILL.md" || p.ends_with("/SKILL.md"))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();

        let mut by_name: Vec<String> = paths
            .iter()
            .filter(|p| {
                p.as_str() == format!("{dir_name}/SKILL.md")
                    || p.ends_with(&format!("/{dir_name}/SKILL.md"))
            })
            .cloned()
            .collect();
        by_name.sort_by_key(|p| p.matches('/').count());
        if let Some(shallowest) = by_name.first() {
            return Ok(shallowest
                .strip_suffix("/SKILL.md")
                .unwrap_or(shallowest)
                .to_string());
        }

        // 改名兜底：读候选 SKILL.md（raw），比较 frontmatter name
        for p in paths.iter().take(12) {
            let raw_url = format!(
                "https://raw.githubusercontent.com/{}/{branch}/{}",
                base.trim_start_matches("/repos/"),
                path_encode(p)
            );
            if let Ok(content) = self.fetch_text(&raw_url).await {
                if frontmatter_name(&content).as_deref() == Some(dir_name) {
                    return Ok(p.strip_suffix("/SKILL.md").unwrap_or(p).to_string());
                }
            }
        }
        Err(AppError::from(format!(
            "仓库中未找到技能 {dir_name}（共 {} 个 SKILL.md，路径名与 frontmatter 均不匹配）",
            paths.len()
        )))
    }

    async fn fetch_text(&self, url: &str) -> AppResult<String> {
        let resp = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|err| AppError::from(format!("下载失败: {err}")))?;
        if !resp.status().is_success() {
            return Err(AppError::from(format!("下载失败 HTTP {}", resp.status())));
        }
        resp.text()
            .await
            .map_err(|err| AppError::from(format!("下载内容读取失败: {err}")))
    }

    async fn download_to_file(&self, url: &str, dest: &Path, token: Option<&str>) -> AppResult<()> {
        let mut req = self.http.get(url);
        if let Some(token) = token {
            req = req.bearer_auth(token);
        }
        let resp = req
            .send()
            .await
            .map_err(|err| AppError::from(format!("tarball 下载失败: {err}")))?;
        if !resp.status().is_success() {
            return Err(AppError::from(format!(
                "tarball 下载失败 HTTP {}",
                resp.status()
            )));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|err| AppError::from(format!("tarball 读取失败: {err}")))?;
        std::fs::write(dest, &bytes)
            .map_err(|err| AppError::from(format!("tarball 写盘失败: {err}")))
    }

    fn pick_tar() -> PathBuf {
        if cfg!(target_os = "windows") {
            // 优先系统自带 bsdtar；Git 自带的 GNU tar 在无特权时创建 symlink 会失败
            let bsdtar =
                PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()))
                    .join("System32")
                    .join("tar.exe");
            if bsdtar.is_file() {
                return bsdtar;
            }
        }
        PathBuf::from("tar")
    }

    /// 在临时目录内：列出 tarball 顶层目录 + 只解出所需子树
    fn tar_list_and_extract(tar_bin: &Path, tmp: &Path, skill_dir: &str) -> AppResult<String> {
        let run = |args: &[&str]| -> AppResult<String> {
            let out = std::process::Command::new(tar_bin)
                .args(args)
                .current_dir(tmp)
                .output()
                .map_err(|err| AppError::from(format!("tar 启动失败: {err}")))?;
            if !out.status.success() {
                return Err(AppError::from(format!(
                    "tar 失败: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                )));
            }
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        };
        let listing = run(&["-tzf", "repo.tgz"])?;
        let top = listing
            .lines()
            .next()
            .unwrap_or("")
            .trim_end_matches('/')
            .to_string();
        if top.is_empty() {
            return Err(AppError::from("下载的压缩包为空"));
        }
        let member = if skill_dir.is_empty() {
            top.clone()
        } else {
            format!("{top}/{skill_dir}")
        };
        run(&["-xzf", "repo.tgz", &member])?;
        Ok(top)
    }

    /// 更新单个技能（repo_url 来自 .skill-lock.json 溯源）
    pub async fn update_skill(
        &self,
        master_dir: &Path,
        dir_name: &str,
        repo_url: &str,
    ) -> UpdateOutcome {
        let Some((owner, repo)) = Self::parse_repo_url(repo_url) else {
            return UpdateOutcome {
                dir: dir_name.into(),
                status: "unsupported".into(),
                detail: Some(format!("仅支持 github.com 来源（{repo_url}）")),
            };
        };
        let token = self.gh_token();
        let base = format!("/repos/{owner}/{repo}");

        let branch = match self.gh_json(&base, token.as_deref()).await {
            Ok(info) => info["default_branch"]
                .as_str()
                .unwrap_or("main")
                .to_string(),
            Err(err) => {
                return UpdateOutcome {
                    dir: dir_name.into(),
                    status: "error".into(),
                    detail: Some(format!("读取仓库信息失败: {err}")),
                }
            }
        };

        let skill_dir = match self
            .locate_skill_dir(&base, dir_name, &branch, token.as_deref())
            .await
        {
            Ok(dir) => dir,
            Err(err) => {
                return UpdateOutcome {
                    dir: dir_name.into(),
                    status: "error".into(),
                    detail: Some(err.to_string()),
                }
            }
        };

        let tmp = match tempfile::tempdir() {
            Ok(dir) => dir,
            Err(err) => {
                return UpdateOutcome {
                    dir: dir_name.into(),
                    status: "error".into(),
                    detail: Some(err.to_string()),
                }
            }
        };
        if let Err(err) = self
            .download_to_file(
                &format!(
                    "https://api.github.com/repos/{owner}/{repo}/tarball/{}",
                    path_encode(&branch)
                ),
                &tmp.path().join("repo.tgz"),
                token.as_deref(),
            )
            .await
        {
            return UpdateOutcome {
                dir: dir_name.into(),
                status: "error".into(),
                detail: Some(err.to_string()),
            };
        }

        // tar -f 用相对路径（GNU tar 会把 "C:\..." 解析成 远程主机:文件）
        let tar_bin = Self::pick_tar();
        let tmp_path = tmp.path().to_path_buf();
        let skill_dir_for_tar = skill_dir.clone();
        let top = match tauri::async_runtime::spawn_blocking(move || {
            Self::tar_list_and_extract(&tar_bin, &tmp_path, &skill_dir_for_tar)
        })
        .await
        {
            Ok(Ok(top)) => top,
            Ok(Err(err)) => {
                return UpdateOutcome {
                    dir: dir_name.into(),
                    status: "error".into(),
                    detail: Some(err.to_string()),
                }
            }
            Err(err) => {
                return UpdateOutcome {
                    dir: dir_name.into(),
                    status: "error".into(),
                    detail: Some(format!("tar 任务失败: {err}")),
                }
            }
        };

        let src = if skill_dir.is_empty() {
            tmp.path().join(&top)
        } else {
            tmp.path().join(&top).join(&skill_dir)
        };
        if !src.join("SKILL.md").is_file() {
            return UpdateOutcome {
                dir: dir_name.into(),
                status: "error".into(),
                detail: Some("下载内容缺少 SKILL.md，放弃替换".into()),
            };
        }

        // 备份 → 替换 → 失败回滚（链接按路径解析，同路径重建后仍有效）
        let dest = master_dir.join(dir_name);
        let bak = tmp.path().join("old");
        let had_old = dest.exists();
        if had_old {
            if let Err(err) = copy_dir_recursive(&dest, &bak) {
                return UpdateOutcome {
                    dir: dir_name.into(),
                    status: "error".into(),
                    detail: Some(format!("备份失败: {err}")),
                };
            }
        }
        if let Err(err) = std::fs::remove_dir_all(&dest) {
            return UpdateOutcome {
                dir: dir_name.into(),
                status: "error".into(),
                detail: Some(format!("移除旧版本失败: {err}")),
            };
        }
        if let Err(err) = copy_dir_recursive(&src, &dest) {
            let _ = std::fs::remove_dir_all(&dest);
            if had_old {
                let _ = copy_dir_recursive(&bak, &dest);
            }
            return UpdateOutcome {
                dir: dir_name.into(),
                status: "error".into(),
                detail: Some(format!("替换失败: {err}")),
            };
        }
        let from = if skill_dir.is_empty() {
            format!("{owner}/{repo}@{branch}")
        } else {
            format!("{owner}/{repo}@{branch}/{skill_dir}")
        };
        UpdateOutcome {
            dir: dir_name.into(),
            status: "updated".into(),
            detail: Some(format!("{dir_name} ← {from}")),
        }
    }
}

impl Default for SkillRemoteUpdateService {
    fn default() -> Self {
        Self::new()
    }
}

fn path_encode(s: &str) -> String {
    s.split('/')
        .map(|seg| {
            seg.replace('%', "%25")
                .replace('?', "%3F")
                .replace('#', "%23")
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn frontmatter_name(content: &str) -> Option<String> {
    let content = content.trim_start_matches('\u{feff}');
    if !content.starts_with("---") {
        return None;
    }
    for line in content.lines().skip(1).take(20) {
        if line.trim() == "---" {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            if key.trim() == "name" {
                let value = value.trim().trim_matches('"').trim_matches('\'').trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> AppResult<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let target = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}
