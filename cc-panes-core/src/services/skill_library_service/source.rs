//! 粘贴安装的来源解析：命令行、本机路径、GitHub、任意 git 地址。
//!
//! 安全边界：结果里的地址、ref 会交给 `git`，所以这里拒绝以 `-` 开头（会被当成选项）、
//! 含 `::`（`ext::` 之类的远程助手）以及 URL 里带账号密码的输入。

use crate::models::skill_library::SkillSourceKind;
use crate::services::skill_repo_fetcher::{RepoRef, SkillRepoFetcher};
use crate::utils::{AppError, AppResult};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProbeSource {
    Folder {
        path: PathBuf,
    },
    Github {
        repo: RepoRef,
        git_ref: Option<String>,
        path: Option<String>,
    },
    Git {
        url: String,
        git_ref: Option<String>,
        path: Option<String>,
    },
}

impl ProbeSource {
    pub(crate) fn kind(&self) -> SkillSourceKind {
        match self {
            Self::Folder { .. } => SkillSourceKind::Folder,
            Self::Github { .. } => SkillSourceKind::Github,
            Self::Git { .. } => SkillSourceKind::Git,
        }
    }

    /// 回显给前端的规范化来源。
    pub(crate) fn display(&self) -> String {
        match self {
            Self::Folder { path } => path.to_string_lossy().to_string(),
            Self::Github {
                repo,
                git_ref,
                path,
            } => match (git_ref, path) {
                (None, None) => repo.slug(),
                (git_ref, path) => format!(
                    "{}/tree/{}/{}",
                    repo.homepage(),
                    git_ref.as_deref().unwrap_or("HEAD"),
                    path.as_deref().unwrap_or_default()
                )
                .trim_end_matches('/')
                .to_string(),
            },
            Self::Git { url, .. } => url.clone(),
        }
    }
}

fn reject(message: &str) -> AppError {
    AppError::from(message.to_string())
}

/// `npx|bunx|pnpm dlx … skills add <src>` → `<src>`；不是命令则原样返回。
fn strip_installer_command(input: &str) -> AppResult<String> {
    let tokens: Vec<&str> = input.split_whitespace().collect();
    let Some(first) = tokens.first() else {
        return Err(reject("Source is empty"));
    };
    let is_command =
        matches!(*first, "npx" | "bunx") || (*first == "pnpm" && tokens.get(1) == Some(&"dlx"));
    if !is_command {
        return Ok(input.to_string());
    }
    let skills_at = tokens
        .iter()
        .position(|token| *token == "skills" || token.starts_with("skills@"))
        .ok_or_else(|| reject("Only `skills add <source>` commands are supported"))?;
    if tokens.get(skills_at + 1) != Some(&"add") {
        return Err(reject("Only `skills add <source>` commands are supported"));
    }
    tokens[skills_at + 2..]
        .iter()
        .find(|token| !token.starts_with('-'))
        .map(|token| token.trim_matches(|ch| ch == '"' || ch == '\'').to_string())
        .ok_or_else(|| reject("The command does not name a source"))
}

fn validate_raw(src: &str) -> AppResult<()> {
    if src.is_empty() {
        return Err(reject("Source is empty"));
    }
    if src.starts_with('-') {
        return Err(reject("Source cannot start with '-'"));
    }
    if src.contains("::") {
        return Err(reject("Source cannot contain '::'"));
    }
    if src.chars().any(|ch| ch.is_control() || ch.is_whitespace()) {
        return Err(reject("Source cannot contain spaces or control characters"));
    }
    Ok(())
}

pub(crate) fn validate_git_ref(git_ref: &str) -> AppResult<()> {
    let valid = !git_ref.is_empty()
        && git_ref.len() <= 200
        && !git_ref.starts_with('-')
        && !git_ref.contains("..")
        && git_ref
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/' | '+'));
    if valid {
        Ok(())
    } else {
        Err(reject("Git ref contains unsupported characters"))
    }
}

fn clean_path(path: &str) -> AppResult<Option<String>> {
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty() {
        return Ok(None);
    }
    let trimmed = trimmed.strip_suffix("/SKILL.md").unwrap_or(trimmed);
    let trimmed = if trimmed == "SKILL.md" { "" } else { trimmed };
    if trimmed.is_empty() {
        return Ok(None);
    }
    if !SkillRepoFetcher::is_safe_relative_path(trimmed) {
        return Err(reject("Repository path is invalid"));
    }
    Ok(Some(trimmed.to_string()))
}

/// `<ref>/<path…>` 段：第一段是 ref，其余是目录。
fn split_ref_path(rest: &[&str]) -> AppResult<(Option<String>, Option<String>)> {
    let Some((git_ref, path)) = rest.split_first() else {
        return Ok((None, None));
    };
    let git_ref = urlencoding::decode(git_ref)
        .map(|value| value.into_owned())
        .unwrap_or_else(|_| git_ref.to_string());
    validate_git_ref(&git_ref)?;
    let path = path
        .iter()
        .map(|segment| {
            urlencoding::decode(segment)
                .map(|value| value.into_owned())
                .unwrap_or_else(|_| segment.to_string())
        })
        .collect::<Vec<_>>()
        .join("/");
    Ok((Some(git_ref), clean_path(&path)?))
}

fn parse_github_path(segments: &[&str]) -> AppResult<ProbeSource> {
    if segments.len() < 2 {
        return Err(reject("Expected a GitHub owner/repo"));
    }
    let repo = SkillRepoFetcher::parse_repo(&format!("{}/{}", segments[0], segments[1]))?;
    let (git_ref, path) = match segments.get(2) {
        None => (None, None),
        Some(&"tree") | Some(&"blob") => split_ref_path(&segments[3..])?,
        Some(_) => return Err(reject("Unsupported GitHub link; use a repo or tree link")),
    };
    Ok(ProbeSource::Github {
        repo,
        git_ref,
        path,
    })
}

fn parse_url(src: &str) -> AppResult<ProbeSource> {
    let parsed = url::Url::parse(src).map_err(|_| reject("Source is not a valid URL"))?;
    let scheme = parsed.scheme();
    if !matches!(scheme, "https" | "http" | "ssh" | "git" | "file") {
        return Err(reject("Unsupported URL scheme"));
    }
    if parsed.password().is_some() {
        return Err(reject("Remove the password from the URL"));
    }
    if matches!(scheme, "https" | "http" | "file") && !parsed.username().is_empty() {
        return Err(reject("Remove the account from the URL"));
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let segments: Vec<&str> = parsed
        .path_segments()
        .map(|segments| segments.filter(|segment| !segment.is_empty()).collect())
        .unwrap_or_default();
    if matches!(scheme, "https" | "http") && (host == "github.com" || host == "www.github.com") {
        return parse_github_path(&segments);
    }
    if !matches!(scheme, "https" | "http") {
        return Ok(ProbeSource::Git {
            url: src.trim_end_matches('/').to_string(),
            git_ref: None,
            path: None,
        });
    }
    // GitLab: /group/proj/-/tree/<ref>/<path>；Gitea / Forgejo: /o/r/src/branch|tag/<ref>/<path>
    let base_and_rest = segments
        .iter()
        .position(|segment| *segment == "-")
        .filter(|at| matches!(segments.get(at + 1), Some(&"tree") | Some(&"blob")))
        .map(|at| (at, at + 2))
        .or_else(|| {
            segments
                .iter()
                .position(|segment| *segment == "src")
                .filter(|at| {
                    *at >= 2 && matches!(segments.get(at + 1), Some(&"branch") | Some(&"tag"))
                })
                .map(|at| (at, at + 2))
        });
    let origin = format!(
        "{}://{}{}",
        scheme,
        parsed.host_str().unwrap_or_default(),
        parsed
            .port()
            .map(|port| format!(":{}", port))
            .unwrap_or_default()
    );
    let (base_len, git_ref, path) = match base_and_rest {
        Some((base_len, rest_at)) => {
            let (git_ref, path) = split_ref_path(&segments[rest_at..])?;
            (base_len, git_ref, path)
        }
        None => (segments.len(), None, None),
    };
    if base_len == 0 {
        return Err(reject("URL does not point at a repository"));
    }
    Ok(ProbeSource::Git {
        url: format!("{}/{}", origin, segments[..base_len].join("/")),
        git_ref,
        path,
    })
}

fn is_scp_like(src: &str) -> bool {
    let Some((user_host, path)) = src.split_once(':') else {
        return false;
    };
    let Some((user, host)) = user_host.split_once('@') else {
        return false;
    };
    !user.is_empty()
        && !host.is_empty()
        && !path.is_empty()
        && !path.starts_with("//")
        && user
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        && host
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '.'))
}

fn looks_like_windows_path(src: &str) -> bool {
    let bytes = src.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

fn is_owner_repo(src: &str) -> bool {
    let parts: Vec<&str> = src.trim_end_matches('/').split('/').collect();
    parts.len() == 2 && SkillRepoFetcher::parse_repo(src).is_ok()
}

/// 解析粘贴进来的来源。`home` 用于展开 `~/`。
pub(crate) fn parse_probe_source(input: &str, home: Option<&Path>) -> AppResult<ProbeSource> {
    let src = strip_installer_command(input.trim())?;
    validate_raw(&src)?;

    if src == "~" || src.starts_with("~/") {
        let home = home.ok_or_else(|| reject("Home directory is unknown"))?;
        let rest = src.trim_start_matches('~').trim_start_matches('/');
        return Ok(ProbeSource::Folder {
            path: if rest.is_empty() {
                home.to_path_buf()
            } else {
                home.join(rest)
            },
        });
    }
    if src.contains("://") {
        return parse_url(&src);
    }
    if Path::new(&src).is_absolute() || looks_like_windows_path(&src) {
        return Ok(ProbeSource::Folder {
            path: PathBuf::from(&src),
        });
    }
    if is_scp_like(&src) {
        return Ok(ProbeSource::Git {
            url: src,
            git_ref: None,
            path: None,
        });
    }
    let lower = src.to_ascii_lowercase();
    if lower.starts_with("github.com/") || lower.starts_with("www.github.com/") {
        return parse_url(&format!("https://{}", src));
    }
    if is_owner_repo(&src) {
        return Ok(ProbeSource::Github {
            repo: SkillRepoFetcher::parse_repo(&src)?,
            git_ref: None,
            path: None,
        });
    }
    Err(reject(
        "Unrecognized source; paste a GitHub repo, a git URL, or a local folder path",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn github(src: &str) -> (String, Option<String>, Option<String>) {
        match parse_probe_source(src, None).unwrap() {
            ProbeSource::Github {
                repo,
                git_ref,
                path,
            } => (repo.slug(), git_ref, path),
            other => panic!("{src} parsed as {other:?}"),
        }
    }

    fn git(src: &str) -> (String, Option<String>, Option<String>) {
        match parse_probe_source(src, None).unwrap() {
            ProbeSource::Git { url, git_ref, path } => (url, git_ref, path),
            other => panic!("{src} parsed as {other:?}"),
        }
    }

    #[test]
    fn installer_commands_only_keep_the_source() {
        for command in [
            "npx skills add anthropics/skills",
            "npx -y skills@latest add anthropics/skills --skill pdf",
            "bunx skills add anthropics/skills",
            "pnpm dlx skills add -g anthropics/skills",
        ] {
            assert_eq!(github(command).0, "anthropics/skills", "{command}");
        }
        assert!(parse_probe_source("npx create-react-app x", None).is_err());
        assert!(parse_probe_source("npx skills remove x/y", None).is_err());
        assert!(parse_probe_source("npx skills add --all", None).is_err());
    }

    #[test]
    fn github_forms() {
        assert_eq!(
            github("anthropics/skills"),
            ("anthropics/skills".into(), None, None)
        );
        assert_eq!(github("github.com/o/r").0, "o/r");
        assert_eq!(github("https://github.com/o/r.git").0, "o/r");
        assert_eq!(
            github("https://github.com/o/r/tree/main/skills/pdf"),
            ("o/r".into(), Some("main".into()), Some("skills/pdf".into()))
        );
        assert_eq!(
            github("https://github.com/o/r/blob/v1/skills/pdf/SKILL.md"),
            ("o/r".into(), Some("v1".into()), Some("skills/pdf".into()))
        );
        assert_eq!(
            github("https://github.com/o/r/tree/main"),
            ("o/r".into(), Some("main".into()), None)
        );
        assert!(parse_probe_source("https://github.com/o/r/issues/1", None).is_err());
    }

    #[test]
    fn other_git_forms() {
        assert_eq!(
            git("https://gitlab.com/group/proj/-/tree/dev/skills/x"),
            (
                "https://gitlab.com/group/proj".into(),
                Some("dev".into()),
                Some("skills/x".into())
            )
        );
        assert_eq!(
            git("https://gitea.example.com/o/r/src/branch/main/sk"),
            (
                "https://gitea.example.com/o/r".into(),
                Some("main".into()),
                Some("sk".into())
            )
        );
        assert_eq!(
            git("https://git.example.com/o/r.git").0,
            "https://git.example.com/o/r.git"
        );
        assert_eq!(
            git("ssh://git@host:2222/o/r.git").0,
            "ssh://git@host:2222/o/r.git"
        );
        assert_eq!(
            git("git@gitlab.com:group/proj.git").0,
            "git@gitlab.com:group/proj.git"
        );
        assert_eq!(
            git("file:///srv/repos/skills").0,
            "file:///srv/repos/skills"
        );
    }

    #[test]
    fn folder_forms() {
        let home = Path::new("/home/me");
        assert_eq!(
            parse_probe_source("~/skills/mine", Some(home)).unwrap(),
            ProbeSource::Folder {
                path: home.join("skills/mine")
            }
        );
        #[cfg(unix)]
        assert_eq!(
            parse_probe_source("/opt/skills", None).unwrap().kind(),
            SkillSourceKind::Folder
        );
        assert_eq!(
            parse_probe_source("C:\\skills\\x", None).unwrap().kind(),
            SkillSourceKind::Folder
        );
    }

    #[test]
    fn rejects_dangerous_or_unknown_sources() {
        for src in [
            "",
            "   ",
            "-oProxyCommand=evil",
            "--upload-pack=touch /tmp/x",
            "ext::sh -c touch% /tmp/pwned",
            "ext::sh",
            "https://user:secret@github.com/o/r",
            "https://token@gitlab.com/g/p.git",
            "ssh://git:pw@host/o/r",
            "file://user@host/srv/x",
            "ftp://host/x",
            "https://github.com/o/r/tree/-evil/x",
            "https://github.com/o/r/tree/main/../../etc",
            "skills",
            "a/b/c",
            "npx skills add -- --upload-pack=x",
        ] {
            assert!(
                parse_probe_source(src, None).is_err(),
                "{src:?} must be rejected"
            );
        }
    }
}
