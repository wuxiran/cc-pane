//! 粘贴安装：probe 列出候选技能（结果缓存 15 分钟），install 按候选逐个落盘。

use super::fs_ops::{self, relative_to_native};
use super::source::{parse_probe_source, ProbeSource};
use super::{metadata_from_markdown, place_new, source_identity, unique_id, SkillLibraryService};
use crate::models::skill_library::{
    SkillInstallResult, SkillPathReason, SkillProbe, SkillProbeCandidate, SkillProvenance,
    SkillSourceKind,
};
use crate::services::parse_skill_metadata;
use crate::services::skill_repo_fetcher::{RepoListing, RepoRef, SkillRepoFetcher};
use crate::services::user_skill_service::{
    InstalledUserSkill, UserSkillService, USER_SKILL_MARKDOWN_FILE,
};
use crate::utils::{AppError, AppResult};
use futures_util::stream::{self, StreamExt};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tracing::info;

const PROBE_TTL: Duration = Duration::from_secs(15 * 60);
/// 单个技能的体积上限，超过列入 `tooBig`。
pub(crate) const MAX_SKILL_BYTES: u64 = 50 * 1024 * 1024;
pub(crate) const MAX_SKILL_FILES: usize = 2000;
const MAX_CANDIDATES: usize = 500;
const MAX_SCAN_DEPTH: usize = 8;
const DOWNLOAD_CONCURRENCY: usize = 6;

pub(crate) enum ProbeData {
    Github {
        repo: RepoRef,
        git_ref: Option<String>,
        listing: RepoListing,
    },
    Git {
        url: String,
        git_ref: Option<String>,
        checkout: PathBuf,
        head: String,
    },
    Folder {
        root: PathBuf,
    },
}

#[derive(Clone)]
pub(crate) struct Candidate {
    /// github / git: 仓库内目录；folder: 相对粘贴目录的路径（根为 `""`）。
    pub path: String,
    pub name: String,
    pub description: Option<String>,
    pub too_big: Option<String>,
}

pub(crate) struct ProbeEntry {
    created: Instant,
    source: String,
    data: ProbeData,
    candidates: Vec<Candidate>,
}

impl Drop for ProbeEntry {
    fn drop(&mut self) {
        if let ProbeData::Git { checkout, .. } = &self.data {
            let _ = std::fs::remove_dir_all(checkout);
        }
    }
}

/// 市场安装与粘贴安装共用的 GitHub 落盘请求。
pub struct GithubDirInstall<'a> {
    pub repo: &'a RepoRef,
    pub listing: &'a RepoListing,
    /// 仓库内技能目录（根为 `""`）。
    pub skill_dir: &'a str,
    /// 要下载的仓库路径（都在 `skill_dir` 下）。
    pub files: &'a [String],
    pub git_ref: Option<&'a str>,
    pub id: &'a str,
}

fn join_repo_path(dir: &str, leaf: &str) -> String {
    if dir.is_empty() {
        leaf.to_string()
    } else {
        format!("{}/{}", dir, leaf)
    }
}

fn leaf_of(path: &str, fallback: &str) -> String {
    path.rsplit('/')
        .next()
        .filter(|leaf| !leaf.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn has_ignored_segment(path: &str) -> bool {
    path.split('/').any(fs_ops::is_ignored_dir_name)
}

/// 仓库内 `skill_dir` 下应下载的文件。
pub(crate) fn github_files_under(listing: &RepoListing, skill_dir: &str) -> Vec<(String, u64)> {
    let prefix = if skill_dir.is_empty() {
        String::new()
    } else {
        format!("{}/", skill_dir)
    };
    listing
        .files
        .iter()
        .filter(|file| file.path.starts_with(&prefix))
        .filter(|file| !has_ignored_segment(&file.path[prefix.len()..]))
        .map(|file| (file.path.clone(), file.size.unwrap_or(0)))
        .collect()
}

fn size_reason(bytes: u64, files: usize) -> Option<String> {
    if bytes > MAX_SKILL_BYTES {
        Some(format!(
            "larger than {} MB",
            MAX_SKILL_BYTES / (1024 * 1024)
        ))
    } else if files > MAX_SKILL_FILES {
        Some(format!("more than {} files", MAX_SKILL_FILES))
    } else {
        None
    }
}

/// 递归找含 SKILL.md 的目录（跳过 node_modules、.git 等），返回相对 `root` 的路径。
fn scan_local_skill_dirs(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    scan_inner(root, "", 0, &mut found);
    found.sort();
    found
}

fn scan_inner(dir: &Path, relative: &str, depth: usize, out: &mut Vec<String>) {
    if depth > MAX_SCAN_DEPTH || out.len() >= MAX_CANDIDATES {
        return;
    }
    if dir.join(USER_SKILL_MARKDOWN_FILE).is_file() {
        out.push(relative.to_string());
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // 扫描不跟随符号链接，免得一个链接把整块磁盘扫进来。
        if !file_type.is_dir() || fs_ops::is_ignored_dir_name(&name) {
            continue;
        }
        scan_inner(
            &entry.path(),
            &join_repo_path(relative, &name),
            depth + 1,
            out,
        );
    }
}

fn local_candidate(base: &Path, path: &str, check_size: bool) -> Candidate {
    let dir = base.join(relative_to_native(path));
    let fallback = leaf_of(
        path,
        &base.file_name().unwrap_or_default().to_string_lossy(),
    );
    let markdown = std::fs::read_to_string(dir.join(USER_SKILL_MARKDOWN_FILE)).unwrap_or_default();
    let (name, description) = parse_skill_metadata(&markdown, &fallback);
    let too_big = if check_size {
        fs_ops::dir_size(&dir)
            .ok()
            .and_then(|(bytes, files)| size_reason(bytes, files))
    } else {
        None
    };
    Candidate {
        path: path.to_string(),
        name,
        description,
        too_big,
    }
}

impl SkillLibraryService {
    fn purge_expired_probes(&self) {
        let mut probes = self
            .probes
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        probes.retain(|_, entry| entry.created.elapsed() < PROBE_TTL);
    }

    pub async fn probe(&self, source: &str) -> AppResult<SkillProbe> {
        self.purge_expired_probes();
        let parsed = parse_probe_source(source, self.home_dir.as_deref())?;
        let probe_id = uuid::Uuid::new_v4().to_string();
        let kind = parsed.kind();
        let display = parsed.display();
        let (data, candidates) = match parsed {
            ProbeSource::Folder { path } => self.probe_folder(path)?,
            ProbeSource::Github {
                repo,
                git_ref,
                path,
            } => self.probe_github(repo, git_ref, path).await?,
            ProbeSource::Git { url, git_ref, path } => {
                self.probe_git(&probe_id, url, git_ref, path).await?
            }
        };
        let entry = ProbeEntry {
            created: Instant::now(),
            source: display.clone(),
            data,
            candidates,
        };
        let response = self.describe_probe(&probe_id, kind, &entry);
        self.probes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(probe_id, entry);
        Ok(response)
    }

    fn probe_folder(&self, path: PathBuf) -> AppResult<(ProbeData, Vec<Candidate>)> {
        if !path.is_dir() {
            return Err(AppError::from(format!(
                "{} is not a folder",
                path.display()
            )));
        }
        let root = dunce::canonicalize(&path).unwrap_or(path);
        let candidates = scan_local_skill_dirs(&root)
            .into_iter()
            .map(|relative| local_candidate(&root, &relative, false))
            .collect::<Vec<_>>();
        Ok((ProbeData::Folder { root }, candidates))
    }

    async fn probe_github(
        &self,
        repo: RepoRef,
        git_ref: Option<String>,
        base: Option<String>,
    ) -> AppResult<(ProbeData, Vec<Candidate>)> {
        let listing = self.remote.github_list(&repo, git_ref.as_deref()).await?;
        let base_prefix = base.as_deref().map(|value| format!("{}/", value));
        let mut dirs: Vec<String> = listing
            .files
            .iter()
            .filter_map(|file| {
                if file.path == USER_SKILL_MARKDOWN_FILE {
                    Some(String::new())
                } else {
                    file.path.strip_suffix("/SKILL.md").map(str::to_string)
                }
            })
            .filter(|dir| !has_ignored_segment(dir))
            .filter(|dir| match (&base, &base_prefix) {
                (Some(base), Some(prefix)) => dir == base || dir.starts_with(prefix.as_str()),
                _ => true,
            })
            .collect();
        dirs.sort();
        dirs.truncate(MAX_CANDIDATES);

        let candidates: Vec<Candidate> = stream::iter(dirs)
            .map(|dir| {
                let repo = &repo;
                let listing = &listing;
                async move {
                    let files = github_files_under(listing, &dir);
                    let bytes: u64 = files.iter().map(|(_, size)| *size).sum();
                    let markdown_path = join_repo_path(&dir, USER_SKILL_MARKDOWN_FILE);
                    let markdown = self
                        .remote
                        .github_fetch(repo, listing, &markdown_path)
                        .await
                        .ok()
                        .and_then(|bytes| String::from_utf8(bytes).ok())
                        .unwrap_or_default();
                    let (name, description) =
                        parse_skill_metadata(&markdown, &leaf_of(&dir, &repo.repo));
                    Candidate {
                        too_big: size_reason(bytes, files.len()),
                        path: dir,
                        name,
                        description,
                    }
                }
            })
            .buffered(DOWNLOAD_CONCURRENCY)
            .collect()
            .await;
        Ok((
            ProbeData::Github {
                repo,
                git_ref,
                listing,
            },
            candidates,
        ))
    }

    async fn probe_git(
        &self,
        probe_id: &str,
        url: String,
        git_ref: Option<String>,
        base: Option<String>,
    ) -> AppResult<(ProbeData, Vec<Candidate>)> {
        std::fs::create_dir_all(&self.probe_dir)?;
        let checkout = self.probe_dir.join(probe_id);
        let head = match self
            .remote
            .git_clone(&url, git_ref.as_deref(), &checkout)
            .await
        {
            Ok(head) => head,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&checkout);
                return Err(error.into());
            }
        };
        let scan_root = match &base {
            Some(base) => checkout.join(relative_to_native(base)),
            None => checkout.clone(),
        };
        let candidates = scan_local_skill_dirs(&scan_root)
            .into_iter()
            .map(|relative| {
                let repo_path = match &base {
                    Some(base) if relative.is_empty() => base.clone(),
                    Some(base) => format!("{}/{}", base, relative),
                    None => relative,
                };
                local_candidate(&checkout, &repo_path, true)
            })
            .collect();
        Ok((
            ProbeData::Git {
                url,
                git_ref,
                checkout,
                head,
            },
            candidates,
        ))
    }

    fn candidate_provenance(data: &ProbeData, candidate_path: &str) -> SkillProvenance {
        match data {
            ProbeData::Github { repo, git_ref, .. } => SkillProvenance {
                kind: SkillSourceKind::Github,
                repo: Some(repo.slug()),
                git_ref: git_ref.clone(),
                path: Some(candidate_path.to_string()),
                ..Default::default()
            },
            ProbeData::Git {
                url, git_ref, head, ..
            } => SkillProvenance {
                kind: SkillSourceKind::Git,
                repo: Some(url.clone()),
                git_ref: git_ref.clone(),
                path: Some(candidate_path.to_string()),
                commit: Some(head.clone()),
                ..Default::default()
            },
            ProbeData::Folder { root } => SkillProvenance {
                kind: SkillSourceKind::Folder,
                linked_path: Some(
                    root.join(relative_to_native(candidate_path))
                        .to_string_lossy()
                        .to_string(),
                ),
                ..Default::default()
            },
        }
    }

    fn probe_owner(data: &ProbeData) -> String {
        match data {
            ProbeData::Github { repo, .. } => repo.owner.clone(),
            ProbeData::Git { url, .. } => git_url_owner(url),
            ProbeData::Folder { root } => root
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "local".to_string()),
        }
    }

    fn describe_probe(
        &self,
        probe_id: &str,
        kind: SkillSourceKind,
        entry: &ProbeEntry,
    ) -> SkillProbe {
        let identities = self.identity_index();
        let mut taken = self.taken_ids();
        let owner = Self::probe_owner(&entry.data);
        let mut candidates = Vec::new();
        let mut too_big = Vec::new();
        for candidate in &entry.candidates {
            if let Some(reason) = &candidate.too_big {
                too_big.push(SkillPathReason {
                    path: candidate.path.clone(),
                    reason: reason.clone(),
                });
                continue;
            }
            let provenance = Self::candidate_provenance(&entry.data, &candidate.path);
            let have_as =
                source_identity(&provenance).and_then(|key| identities.get(&key).cloned());
            let install_as = match &have_as {
                Some(existing) => existing.clone(),
                None => {
                    let id = unique_id(&candidate.name, &owner, &taken);
                    taken.insert(id.clone());
                    id
                }
            };
            candidates.push(SkillProbeCandidate {
                path: candidate.path.clone(),
                name: candidate.name.clone(),
                description: candidate.description.clone(),
                have: have_as.is_some(),
                have_as,
                install_as,
            });
        }
        SkillProbe {
            probe_id: probe_id.to_string(),
            source: entry.source.clone(),
            kind,
            candidates,
            too_big,
        }
    }

    pub async fn install(&self, probe_id: &str, paths: &[String]) -> AppResult<SkillInstallResult> {
        self.purge_expired_probes();
        // 先把 probe 取出来，下载期间不持锁；结束后放回以便再次安装其他候选。
        let entry = self
            .probes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(probe_id)
            .ok_or_else(|| AppError::from("This paste has expired; paste the source again"))?;
        let result = self.install_from_entry(&entry, paths).await;
        self.probes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(probe_id.to_string(), entry);
        result
    }

    async fn install_from_entry(
        &self,
        entry: &ProbeEntry,
        paths: &[String],
    ) -> AppResult<SkillInstallResult> {
        let identities = self.identity_index();
        let mut taken = self.taken_ids();
        let owner = Self::probe_owner(&entry.data);
        let mut result = SkillInstallResult::default();
        let mut seen = HashSet::new();
        for path in paths {
            if !seen.insert(path.clone()) {
                continue;
            }
            let skip = |reason: &str| SkillPathReason {
                path: path.clone(),
                reason: reason.to_string(),
            };
            let Some(candidate) = entry
                .candidates
                .iter()
                .find(|candidate| &candidate.path == path)
            else {
                result.skipped.push(skip("not a skill in this source"));
                continue;
            };
            if let Some(reason) = &candidate.too_big {
                result.skipped.push(skip(reason));
                continue;
            }
            let provenance = Self::candidate_provenance(&entry.data, path);
            if let Some(existing) =
                source_identity(&provenance).and_then(|key| identities.get(&key))
            {
                result.had.push(existing.clone());
                continue;
            }
            let id = unique_id(&candidate.name, &owner, &taken);
            match self
                .install_candidate(entry, candidate, provenance, &id)
                .await
            {
                Ok(()) => {
                    taken.insert(id.clone());
                    result.installed.push(id);
                }
                Err(error) => result.skipped.push(skip(error.message())),
            }
        }
        info!(
            installed = result.installed.len(),
            had = result.had.len(),
            skipped = result.skipped.len(),
            "[skill_library] install from {}",
            entry.source
        );
        Ok(result)
    }

    async fn install_candidate(
        &self,
        entry: &ProbeEntry,
        candidate: &Candidate,
        provenance: SkillProvenance,
        id: &str,
    ) -> AppResult<()> {
        UserSkillService::validate_skill_id(id)?;
        match &entry.data {
            ProbeData::Github {
                repo,
                git_ref,
                listing,
            } => {
                let files: Vec<String> = github_files_under(listing, &candidate.path)
                    .into_iter()
                    .map(|(path, _)| path)
                    .collect();
                self.install_github_dir(
                    GithubDirInstall {
                        repo,
                        listing,
                        skill_dir: &candidate.path,
                        files: &files,
                        git_ref: git_ref.as_deref(),
                        id,
                    },
                    |markdown, provenance| {
                        let version = short_commit(provenance.commit.as_deref());
                        metadata_from_markdown(
                            markdown,
                            id,
                            &leaf_of(&candidate.path, &repo.repo),
                            provenance,
                            &version,
                        )
                    },
                )
                .await
                .map(|_| ())
            }
            ProbeData::Git { checkout, .. } => {
                let source = checkout.join(relative_to_native(&candidate.path));
                self.install_local_copy(&source, id, &candidate.name, provenance)
            }
            ProbeData::Folder { .. } => self.install_folder_link(id, &candidate.name, provenance),
        }
    }

    /// 复制本机目录（git 克隆结果）进资源库。
    pub(crate) fn install_local_copy(
        &self,
        source: &Path,
        id: &str,
        fallback_name: &str,
        mut provenance: SkillProvenance,
    ) -> AppResult<()> {
        let staging = self.staging_dir(id);
        let outcome = (|| -> AppResult<()> {
            fs_ops::copy_dir_filtered(source, &staging)?;
            provenance.tree_hash = Some(fs_ops::tree_hash(&staging)?);
            let version = short_commit(provenance.commit.as_deref());
            let metadata =
                super::metadata_from_dir(&staging, id, fallback_name, provenance, &version)?;
            UserSkillService::write_metadata(&staging, &metadata)?;
            place_new(&staging, &self.user_skills_dir.join(id))
        })();
        if outcome.is_err() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        outcome
    }

    /// folder 来源：库目录里只写 `skill.json`，内容留在原处。
    fn install_folder_link(
        &self,
        id: &str,
        fallback_name: &str,
        provenance: SkillProvenance,
    ) -> AppResult<()> {
        let linked = PathBuf::from(provenance.linked_path.clone().unwrap_or_default());
        let markdown = std::fs::read_to_string(linked.join(USER_SKILL_MARKDOWN_FILE))
            .map_err(|_| AppError::from("SKILL.md is missing or not UTF-8"))?;
        let metadata = metadata_from_markdown(&markdown, id, fallback_name, provenance, "local");
        let staging = self.staging_dir(id);
        let outcome = (|| -> AppResult<()> {
            std::fs::create_dir_all(&staging)?;
            UserSkillService::write_metadata(&staging, &metadata)?;
            place_new(&staging, &self.user_skills_dir.join(id))
        })();
        if outcome.is_err() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        outcome
    }

    /// 下载 GitHub 技能目录到暂存目录，写好 provenance（commit、treeHash）。
    /// 返回暂存目录和 SKILL.md 文本；调用方负责改名或清理。
    pub(crate) async fn stage_github_dir(
        &self,
        request: &GithubDirInstall<'_>,
    ) -> AppResult<(PathBuf, String, SkillProvenance)> {
        UserSkillService::validate_skill_id(request.id)?;
        std::fs::create_dir_all(&self.user_skills_dir)?;
        let staging = self.staging_dir(request.id);
        let outcome = self.download_github_files(request, &staging).await;
        let markdown = match outcome {
            Ok(markdown) => markdown,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(error);
            }
        };
        let tree_hash = match fs_ops::tree_hash(&staging) {
            Ok(hash) => hash,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(error.into());
            }
        };
        let commit = self
            .remote
            .github_latest_commit(request.repo, request.skill_dir, request.git_ref)
            .await
            .ok()
            .flatten();
        let provenance = SkillProvenance {
            kind: SkillSourceKind::Github,
            repo: Some(request.repo.slug()),
            git_ref: request.git_ref.map(str::to_string),
            path: Some(request.skill_dir.to_string()),
            commit,
            tree_hash: Some(tree_hash),
            ..Default::default()
        };
        Ok((staging, markdown, provenance))
    }

    async fn download_github_files(
        &self,
        request: &GithubDirInstall<'_>,
        staging: &Path,
    ) -> AppResult<String> {
        std::fs::create_dir_all(staging)?;
        let prefix = if request.skill_dir.is_empty() {
            String::new()
        } else {
            format!("{}/", request.skill_dir)
        };
        // 闭包参数用拥有所有权的 String：借用参数会让 axum handler 的 Send 推断撞上
        // 高阶生命周期限制（"FnOnce is not general enough"）。
        let remote = &self.remote;
        let (repo, listing) = (request.repo, request.listing);
        let results: Vec<AppResult<(String, Vec<u8>)>> = stream::iter(request.files.to_vec())
            .map(|path: String| async move {
                let bytes = remote.github_fetch(repo, listing, &path).await?;
                Ok((path, bytes))
            })
            .buffer_unordered(DOWNLOAD_CONCURRENCY)
            .collect()
            .await;
        let mut markdown = None;
        for result in results {
            let (path, bytes) = result?;
            let relative = path.strip_prefix(&prefix).unwrap_or(&path);
            if !SkillRepoFetcher::is_safe_relative_path(relative) {
                return Err(AppError::from(format!(
                    "Refusing unsafe skill path '{}'",
                    relative
                )));
            }
            let destination = staging.join(relative_to_native(relative));
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent)?;
            }
            if relative == USER_SKILL_MARKDOWN_FILE {
                let text = String::from_utf8(bytes.clone())
                    .map_err(|_| AppError::from("SKILL.md is not valid UTF-8"))?;
                if text.trim().is_empty() {
                    return Err(AppError::from("Downloaded SKILL.md is empty"));
                }
                markdown = Some(text);
            }
            std::fs::write(&destination, bytes)?;
        }
        markdown.ok_or_else(|| AppError::from("SKILL.md was not downloaded"))
    }

    /// 市场安装和粘贴安装共用：下载、写 provenance、原子改名。`build` 根据 SKILL.md 与
    /// provenance 生成 `skill.json`。目标已存在时整个替换（旧目录移到备份）。
    pub async fn install_github_dir(
        &self,
        request: GithubDirInstall<'_>,
        build: impl FnOnce(&str, SkillProvenance) -> InstalledUserSkill,
    ) -> AppResult<InstalledUserSkill> {
        let (staging, markdown, provenance) = self.stage_github_dir(&request).await?;
        let mut metadata = build(&markdown, provenance);
        metadata.id = request.id.to_string();
        metadata.file_path = None;
        let target = self.user_skills_dir.join(request.id);
        let placed = (|| -> AppResult<Option<String>> {
            UserSkillService::write_metadata(&staging, &metadata)?;
            let mut session = super::backup::BackupSession::new(&self.backups_dir);
            if target.exists() {
                session.stash(request.id, &target)?;
            }
            std::fs::rename(&staging, &target)?;
            Ok(session.finish())
        })();
        if let Err(error) = placed {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
        self.forget_checks(&[request.id.to_string()]);
        UserSkillService::read_from_dir(&self.user_skills_dir, request.id)?
            .map(|content| content.skill)
            .ok_or_else(|| AppError::from("Installed skill could not be read back"))
    }
}

pub(crate) fn short_commit(commit: Option<&str>) -> String {
    commit
        .map(|value| value.chars().take(12).collect())
        .unwrap_or_else(|| "latest".to_string())
}

/// `https://host/group/proj.git`、`git@host:group/proj.git` → `group`。
pub(crate) fn git_url_owner(url: &str) -> String {
    let without_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let path = without_scheme
        .split_once(':')
        .filter(|_| !url.contains("://"))
        .map(|(_, path)| path)
        .unwrap_or_else(|| {
            without_scheme
                .split_once('/')
                .map(|(_, path)| path)
                .unwrap_or("")
        });
    let segments: Vec<&str> = path
        .trim_end_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    match segments.len() {
        0 => "git".to_string(),
        1 => segments[0].trim_end_matches(".git").to_string(),
        len => segments[len - 2].to_string(),
    }
}
