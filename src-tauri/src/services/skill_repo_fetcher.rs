//! Read-only access to skill directories hosted in public GitHub repositories.
//!
//! Two transports back the same listing/fetch API:
//! - GitHub: `api.github.com` git-tree listing (one call per repo) + `raw.githubusercontent.com`.
//! - jsDelivr mirror: `data.jsdelivr.com` flat listing + `cdn.jsdelivr.net`, reachable from
//!   networks where GitHub is slow or blocked.
//!
//! The first transport that succeeds is remembered for the process lifetime so a user behind a
//! restrictive network does not pay the GitHub timeout on every request.

use crate::utils::{AppError, AppResult};
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tracing::{debug, warn};

const GITHUB_TIMEOUT: Duration = Duration::from_secs(12);
const MIRROR_TIMEOUT: Duration = Duration::from_secs(15);
const MIRROR_DEFAULT_REFS: [&str; 2] = ["main", "master"];
const USER_AGENT: &str = "cc-panes-skill-market";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
    pub owner: String,
    pub repo: String,
}

impl RepoRef {
    pub fn slug(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }

    pub fn homepage(&self) -> String {
        format!("https://github.com/{}/{}", self.owner, self.repo)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoFile {
    pub path: String,
    pub size: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct RepoListing {
    /// Commit sha (GitHub) or branch name (mirror) that all subsequent fetches pin to.
    pub git_ref: String,
    pub via_mirror: bool,
    pub files: Vec<RepoFile>,
}

impl RepoListing {
    pub fn files_under<'a>(&'a self, dir: &str) -> Vec<&'a RepoFile> {
        let prefix = format!("{}/", dir.trim_matches('/'));
        self.files
            .iter()
            .filter(|file| file.path.starts_with(&prefix))
            .collect()
    }

    /// Find the directory holding `SKILL.md` for a skill. An explicit `hint_path` wins when it
    /// really contains a SKILL.md; otherwise the shallowest `<skill_id>/SKILL.md` match is used,
    /// falling back to a root-level SKILL.md when the repository is itself a single skill.
    pub fn locate_skill_dir(&self, hint_path: Option<&str>, skill_id: &str) -> Option<String> {
        if let Some(hint) = hint_path.map(|value| value.trim_matches('/')) {
            if !hint.is_empty() {
                let skill_md = format!("{}/SKILL.md", hint);
                if self.files.iter().any(|file| file.path == skill_md) {
                    return Some(hint.to_string());
                }
            }
        }
        let wanted = skill_id.trim().to_ascii_lowercase();
        let mut best: Option<&str> = None;
        for file in &self.files {
            let Some(dir) = file.path.strip_suffix("/SKILL.md") else {
                continue;
            };
            let leaf = dir.rsplit('/').next().unwrap_or(dir);
            if leaf.to_ascii_lowercase() != wanted {
                continue;
            }
            let depth = dir.matches('/').count();
            let shallower = match best {
                None => true,
                Some(current) => depth < current.matches('/').count(),
            };
            if shallower {
                best = Some(dir);
            }
        }
        if let Some(dir) = best {
            return Some(dir.to_string());
        }
        if self.files.iter().any(|file| file.path == "SKILL.md") {
            return Some(String::new());
        }
        None
    }
}

#[derive(Debug, Deserialize)]
struct GithubTreeResponse {
    sha: String,
    #[serde(default)]
    tree: Vec<GithubTreeNode>,
    #[serde(default)]
    truncated: bool,
}

#[derive(Debug, Deserialize)]
struct GithubTreeNode {
    path: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    size: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct JsdelivrFlatResponse {
    #[serde(default)]
    files: Vec<JsdelivrFile>,
}

#[derive(Debug, Deserialize)]
struct JsdelivrFile {
    name: String,
    #[serde(default)]
    size: Option<u64>,
}

pub struct SkillRepoFetcher {
    client: reqwest::Client,
    prefer_mirror: AtomicBool,
    github_token: Option<String>,
}

impl SkillRepoFetcher {
    pub fn new(client: reqwest::Client) -> Self {
        let github_token = ["CCPANES_GITHUB_TOKEN", "GITHUB_TOKEN"]
            .iter()
            .find_map(|key| std::env::var(key).ok())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        Self {
            client,
            prefer_mirror: AtomicBool::new(false),
            github_token,
        }
    }

    /// Accepts `owner/repo`, `github.com/owner/repo`, or a full GitHub URL (with optional `.git`).
    pub fn parse_repo(spec: &str) -> AppResult<RepoRef> {
        let trimmed = spec.trim();
        let without_scheme = trimmed
            .strip_prefix("https://")
            .or_else(|| trimmed.strip_prefix("http://"))
            .unwrap_or(trimmed);
        let without_host = without_scheme
            .strip_prefix("www.github.com/")
            .or_else(|| without_scheme.strip_prefix("github.com/"))
            .unwrap_or(without_scheme);
        let mut parts = without_host.trim_matches('/').split('/');
        let owner = parts.next().unwrap_or_default().trim();
        let repo = parts
            .next()
            .unwrap_or_default()
            .trim()
            .trim_end_matches(".git");
        let valid = |value: &str| {
            !value.is_empty()
                && value.len() <= 100
                && value
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
                && value != "."
                && value != ".."
        };
        if !valid(owner) || !valid(repo) {
            return Err(AppError::from(format!(
                "Invalid GitHub repository '{}'; expected owner/repo",
                spec
            )));
        }
        Ok(RepoRef {
            owner: owner.to_string(),
            repo: repo.to_string(),
        })
    }

    /// Reject paths that could escape the target directory when written to disk.
    pub fn is_safe_relative_path(path: &str) -> bool {
        if path.is_empty() || path.starts_with('/') || path.contains('\\') || path.contains('\0') {
            return false;
        }
        path.split('/').all(|segment| {
            !segment.is_empty() && segment != "." && segment != ".." && !segment.ends_with(':')
        })
    }

    pub async fn list_files(
        &self,
        repo: &RepoRef,
        git_ref: Option<&str>,
    ) -> AppResult<RepoListing> {
        let git_ref = git_ref.map(str::trim).filter(|value| !value.is_empty());
        if self.prefer_mirror.load(Ordering::Relaxed) {
            match self.list_via_mirror(repo, git_ref).await {
                Ok(listing) => return Ok(listing),
                Err(error) => debug!(
                    "[skill_repo] mirror listing failed, trying GitHub: {}",
                    error
                ),
            }
            return self.list_via_github(repo, git_ref).await;
        }
        match self.list_via_github(repo, git_ref).await {
            Ok(listing) => Ok(listing),
            Err(github_error) => {
                warn!(
                    "[skill_repo] GitHub listing failed for {}: {}; trying jsDelivr mirror",
                    repo.slug(),
                    github_error
                );
                let listing =
                    self.list_via_mirror(repo, git_ref)
                        .await
                        .map_err(|mirror_error| {
                            AppError::from(format!(
                                "Failed to list {} via GitHub ({}) and mirror ({})",
                                repo.slug(),
                                github_error,
                                mirror_error
                            ))
                        })?;
                self.prefer_mirror.store(true, Ordering::Relaxed);
                Ok(listing)
            }
        }
    }

    pub async fn fetch_bytes(
        &self,
        repo: &RepoRef,
        listing: &RepoListing,
        path: &str,
    ) -> AppResult<Vec<u8>> {
        if !Self::is_safe_relative_path(path) {
            return Err(AppError::from(format!(
                "Refusing unsafe repository path '{}'",
                path
            )));
        }
        let (url, timeout) = if listing.via_mirror {
            (
                Self::mirror_file_url(repo, &listing.git_ref, path),
                MIRROR_TIMEOUT,
            )
        } else {
            (
                Self::github_raw_url(repo, &listing.git_ref, path),
                GITHUB_TIMEOUT,
            )
        };
        let response = self
            .client
            .get(&url)
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .timeout(timeout)
            .send()
            .await
            .map_err(|err| AppError::from(format!("Failed to download {}: {}", path, err)))?
            .error_for_status()
            .map_err(|err| AppError::from(format!("Failed to download {}: {}", path, err)))?;
        let bytes = response
            .bytes()
            .await
            .map_err(|err| AppError::from(format!("Failed to read {}: {}", path, err)))?;
        Ok(bytes.to_vec())
    }

    pub async fn fetch_text(
        &self,
        repo: &RepoRef,
        listing: &RepoListing,
        path: &str,
    ) -> AppResult<String> {
        let bytes = self.fetch_bytes(repo, listing, path).await?;
        String::from_utf8(bytes)
            .map_err(|_| AppError::from(format!("{} is not valid UTF-8 text", path)))
    }

    async fn list_via_github(
        &self,
        repo: &RepoRef,
        git_ref: Option<&str>,
    ) -> AppResult<RepoListing> {
        let url = format!(
            "https://api.github.com/repos/{}/{}/git/trees/{}?recursive=1",
            repo.owner,
            repo.repo,
            git_ref.unwrap_or("HEAD")
        );
        let mut request = self
            .client
            .get(&url)
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .timeout(GITHUB_TIMEOUT);
        if let Some(token) = &self.github_token {
            request = request.bearer_auth(token);
        }
        let response = request
            .send()
            .await
            .map_err(|err| AppError::from(format!("GitHub request failed: {}", err)))?;
        if response.status() == reqwest::StatusCode::FORBIDDEN
            || response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
        {
            return Err(AppError::from(
                "GitHub API rate limit reached; set CCPANES_GITHUB_TOKEN to raise it",
            ));
        }
        let payload: GithubTreeResponse = response
            .error_for_status()
            .map_err(|err| AppError::from(format!("GitHub request failed: {}", err)))?
            .json()
            .await
            .map_err(|err| AppError::from(format!("Invalid GitHub tree response: {}", err)))?;
        if payload.truncated {
            warn!(
                "[skill_repo] GitHub tree for {} was truncated; some files may be missing",
                repo.slug()
            );
        }
        let files = payload
            .tree
            .into_iter()
            .filter(|node| node.kind == "blob" && Self::is_safe_relative_path(&node.path))
            .map(|node| RepoFile {
                path: node.path,
                size: node.size,
            })
            .collect();
        Ok(RepoListing {
            git_ref: payload.sha,
            via_mirror: false,
            files,
        })
    }

    async fn list_via_mirror(
        &self,
        repo: &RepoRef,
        git_ref: Option<&str>,
    ) -> AppResult<RepoListing> {
        let candidates: Vec<&str> = match git_ref {
            Some(value) => vec![value],
            None => MIRROR_DEFAULT_REFS.to_vec(),
        };
        let mut last_error = None;
        for candidate in candidates {
            let url = format!(
                "https://data.jsdelivr.com/v1/packages/gh/{}/{}@{}?structure=flat",
                repo.owner, repo.repo, candidate
            );
            let result = self
                .client
                .get(&url)
                .header(reqwest::header::USER_AGENT, USER_AGENT)
                .timeout(MIRROR_TIMEOUT)
                .send()
                .await
                .map_err(|err| AppError::from(format!("Mirror request failed: {}", err)))
                .and_then(|response| {
                    response
                        .error_for_status()
                        .map_err(|err| AppError::from(format!("Mirror request failed: {}", err)))
                });
            let response = match result {
                Ok(response) => response,
                Err(error) => {
                    last_error = Some(error);
                    continue;
                }
            };
            let payload: JsdelivrFlatResponse = response
                .json()
                .await
                .map_err(|err| AppError::from(format!("Invalid mirror listing: {}", err)))?;
            let files = payload
                .files
                .into_iter()
                .map(|file| RepoFile {
                    path: file.name.trim_start_matches('/').to_string(),
                    size: file.size,
                })
                .filter(|file| Self::is_safe_relative_path(&file.path))
                .collect::<Vec<_>>();
            if files.is_empty() {
                last_error = Some(AppError::from(format!(
                    "Mirror returned no files for {}@{}",
                    repo.slug(),
                    candidate
                )));
                continue;
            }
            return Ok(RepoListing {
                git_ref: candidate.to_string(),
                via_mirror: true,
                files,
            });
        }
        Err(last_error.unwrap_or_else(|| AppError::from("Mirror listing failed")))
    }

    fn github_raw_url(repo: &RepoRef, git_ref: &str, path: &str) -> String {
        format!(
            "https://raw.githubusercontent.com/{}/{}/{}/{}",
            repo.owner,
            repo.repo,
            git_ref,
            encode_path(path)
        )
    }

    fn mirror_file_url(repo: &RepoRef, git_ref: &str, path: &str) -> String {
        format!(
            "https://cdn.jsdelivr.net/gh/{}/{}@{}/{}",
            repo.owner,
            repo.repo,
            git_ref,
            encode_path(path)
        )
    }
}

fn encode_path(path: &str) -> String {
    path.split('/')
        .map(|segment| {
            let mut encoded = String::with_capacity(segment.len());
            for byte in segment.bytes() {
                match byte {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                        encoded.push(byte as char)
                    }
                    _ => encoded.push_str(&format!("%{:02X}", byte)),
                }
            }
            encoded
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listing(paths: &[&str]) -> RepoListing {
        RepoListing {
            git_ref: "abc".to_string(),
            via_mirror: false,
            files: paths
                .iter()
                .map(|path| RepoFile {
                    path: path.to_string(),
                    size: Some(1),
                })
                .collect(),
        }
    }

    #[test]
    fn parses_repo_specs() {
        for spec in [
            "anthropics/skills",
            "https://github.com/anthropics/skills",
            "https://github.com/anthropics/skills.git",
            "github.com/anthropics/skills/",
        ] {
            let parsed = SkillRepoFetcher::parse_repo(spec).unwrap();
            assert_eq!(parsed.owner, "anthropics");
            assert_eq!(parsed.repo, "skills");
        }
        assert!(SkillRepoFetcher::parse_repo("skills").is_err());
        assert!(SkillRepoFetcher::parse_repo("../x/y").is_err());
        assert!(SkillRepoFetcher::parse_repo("a b/c").is_err());
    }

    #[test]
    fn rejects_unsafe_paths() {
        assert!(SkillRepoFetcher::is_safe_relative_path(
            "skills/pdf/SKILL.md"
        ));
        assert!(!SkillRepoFetcher::is_safe_relative_path("../SKILL.md"));
        assert!(!SkillRepoFetcher::is_safe_relative_path("skills/../../etc"));
        assert!(!SkillRepoFetcher::is_safe_relative_path("/abs/SKILL.md"));
        assert!(!SkillRepoFetcher::is_safe_relative_path("a\\b"));
        assert!(!SkillRepoFetcher::is_safe_relative_path("C:/x"));
    }

    #[test]
    fn locates_skill_dir_by_hint_then_by_leaf_name_then_root() {
        let repo = listing(&[
            "README.md",
            "skills/pdf/SKILL.md",
            "skills/pdf/scripts/extract.py",
            "examples/deep/pdf/SKILL.md",
            "other/xlsx/SKILL.md",
        ]);
        assert_eq!(
            repo.locate_skill_dir(Some("skills/pdf"), "ignored"),
            Some("skills/pdf".to_string())
        );
        assert_eq!(
            repo.locate_skill_dir(Some("missing/dir"), "PDF"),
            Some("skills/pdf".to_string())
        );
        assert_eq!(
            repo.locate_skill_dir(None, "xlsx"),
            Some("other/xlsx".to_string())
        );
        assert_eq!(repo.locate_skill_dir(None, "nope"), None);

        let single = listing(&["SKILL.md", "scripts/run.sh"]);
        assert_eq!(
            single.locate_skill_dir(None, "anything"),
            Some(String::new())
        );
    }

    #[test]
    fn files_under_only_returns_descendants() {
        let repo = listing(&[
            "skills/pdf/SKILL.md",
            "skills/pdf/scripts/a.py",
            "skills/pdfx/SKILL.md",
        ]);
        let files: Vec<&str> = repo
            .files_under("skills/pdf")
            .into_iter()
            .map(|file| file.path.as_str())
            .collect();
        assert_eq!(
            files,
            vec!["skills/pdf/SKILL.md", "skills/pdf/scripts/a.py"]
        );
    }

    #[test]
    fn encodes_url_path_segments() {
        assert_eq!(encode_path("a b/c#d"), "a%20b/c%23d");
        assert_eq!(encode_path("skills/pdf/SKILL.md"), "skills/pdf/SKILL.md");
    }
}
