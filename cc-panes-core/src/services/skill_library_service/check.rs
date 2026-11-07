//! 检查更新与更新。
//!
//! 只有**完整抓取成功**且目录或 SKILL.md 不存在才算 `gone`（并持久化）；网络、限流、
//! 解析失败一律 `unknown`。重新出现时清除 `gone`。

use super::backup::BackupSession;
use super::fs_ops::{self, relative_to_native};
use super::probe::{github_files_under, short_commit, GithubDirInstall};
use super::{edited_state, effective_provenance, metadata_from_markdown, SkillLibraryService};
use crate::models::skill_library::{
    SkillCheck, SkillCheckStatus, SkillEditedState, SkillIdError, SkillProvenance, SkillSourceKind,
    SkillUpdateResult,
};
use crate::services::skill_repo_fetcher::{RemoteError, RepoListing, RepoRef, SkillRepoFetcher};
use crate::services::user_skill_service::{
    InstalledUserSkill, UserSkillService, USER_SKILL_MARKDOWN_FILE,
};
use crate::utils::{AppError, AppResult};
use futures_util::stream::{self, StreamExt};
use std::path::{Path, PathBuf};
use tracing::{info, warn};

const CHECK_CONCURRENCY: usize = 4;

/// 上游当前状态（一次完整抓取的结论）。
enum Upstream {
    Present,
    Missing,
}

fn listing_has_skill(listing: &RepoListing, path: &str) -> bool {
    let markdown = if path.is_empty() {
        USER_SKILL_MARKDOWN_FILE.to_string()
    } else {
        format!("{}/{}", path, USER_SKILL_MARKDOWN_FILE)
    };
    listing.files.iter().any(|file| file.path == markdown)
}

fn unknown_from(id: &str, error: &RemoteError) -> SkillCheck {
    let mut check = SkillCheck::unknown(id, error.message());
    check.rate_limited_until = error.rate_limited_until().map(str::to_string);
    check
}

fn status(id: &str, status: SkillCheckStatus) -> SkillCheck {
    SkillCheck {
        id: id.to_string(),
        status,
        latest_commit: None,
        compare_url: None,
        error: None,
        rate_limited_until: None,
    }
}

fn github_repo(provenance: &SkillProvenance) -> Result<RepoRef, String> {
    SkillRepoFetcher::parse_repo(provenance.repo.as_deref().unwrap_or_default())
        .map_err(|error| error.message().to_string())
}

impl SkillLibraryService {
    pub async fn check(&self, ids: Option<&[String]>) -> AppResult<Vec<SkillCheck>> {
        let skills = UserSkillService::list_from_dir(&self.user_skills_dir)?;
        let selected: Vec<InstalledUserSkill> = match ids {
            None => skills,
            Some(ids) => ids
                .iter()
                .filter_map(|id| skills.iter().find(|skill| &skill.id == id).cloned())
                .collect(),
        };
        let results: Vec<SkillCheck> = stream::iter(selected)
            .map(|skill| async move { self.check_one(&skill).await })
            .buffered(CHECK_CONCURRENCY)
            .collect()
            .await;
        self.remember_checks(&results);
        Ok(results)
    }

    /// 上次检查结果（内存）。
    pub fn last_checks(&self) -> Vec<SkillCheck> {
        let checks = self
            .checks
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut results: Vec<SkillCheck> = checks.values().cloned().collect();
        results.sort_by(|left, right| left.id.cmp(&right.id));
        results
    }

    async fn check_one(&self, skill: &InstalledUserSkill) -> SkillCheck {
        let provenance = effective_provenance(skill);
        let result = match provenance.kind {
            SkillSourceKind::Github => self.check_github(skill, &provenance).await,
            SkillSourceKind::Git => self.check_git(skill, &provenance).await,
            _ => SkillCheck::unknown(&skill.id, "unsupported"),
        };
        match result.status {
            SkillCheckStatus::Gone if !skill.gone => self.persist_gone(&skill.id, true),
            SkillCheckStatus::Current | SkillCheckStatus::Update if skill.gone => {
                self.persist_gone(&skill.id, false)
            }
            _ => {}
        }
        result
    }

    fn persist_gone(&self, id: &str, gone: bool) {
        if let Err(error) = self.update_metadata(id, |skill| skill.gone = gone) {
            warn!(
                "[skill_library] failed to persist gone={} for {}: {}",
                gone, id, error
            );
        }
    }

    async fn check_github(
        &self,
        skill: &InstalledUserSkill,
        provenance: &SkillProvenance,
    ) -> SkillCheck {
        let id = skill.id.as_str();
        let repo = match github_repo(provenance) {
            Ok(repo) => repo,
            Err(error) => return SkillCheck::unknown(id, error),
        };
        let path = provenance.path.as_deref().unwrap_or_default();
        let git_ref = provenance.git_ref.as_deref();
        let latest = match self.remote.github_latest_commit(&repo, path, git_ref).await {
            Ok(latest) => latest,
            Err(error) => return unknown_from(id, &error),
        };
        if latest.is_some() && latest == provenance.commit && !skill.gone {
            return status(id, SkillCheckStatus::Current);
        }
        // 提交变了（删除目录本身也是一次提交）：要完整列一次才能区分「有更新」和「已删除」。
        let listing = match self.remote.github_list(&repo, git_ref).await {
            Ok(listing) => listing,
            Err(error) => return unknown_from(id, &error),
        };
        if !listing_has_skill(&listing, path) {
            if listing.truncated {
                return SkillCheck::unknown(id, "repository listing was truncated");
            }
            return status(id, SkillCheckStatus::Gone);
        }
        let Some(latest) = latest else {
            return SkillCheck::unknown(id, "GitHub returned no commit for this folder");
        };
        if Some(&latest) == provenance.commit.as_ref() {
            return status(id, SkillCheckStatus::Current);
        }
        let compare_url = provenance
            .commit
            .as_ref()
            .map(|previous| format!("{}/compare/{}...{}", repo.homepage(), previous, latest));
        SkillCheck {
            latest_commit: Some(latest),
            compare_url,
            ..status(id, SkillCheckStatus::Update)
        }
    }

    async fn check_git(
        &self,
        skill: &InstalledUserSkill,
        provenance: &SkillProvenance,
    ) -> SkillCheck {
        let id = skill.id.as_str();
        let url = provenance.repo.as_deref().unwrap_or_default();
        let git_ref = provenance.git_ref.as_deref();
        let head = match self.remote.git_ls_remote(url, git_ref).await {
            Ok(head) => head,
            Err(error) => return unknown_from(id, &error),
        };
        if Some(&head) == provenance.commit.as_ref() && !skill.gone {
            return status(id, SkillCheckStatus::Current);
        }
        let checkout = self.temp_checkout_dir(id);
        let outcome = self.remote.git_clone(url, git_ref, &checkout).await;
        let result = match outcome {
            Err(error) => unknown_from(id, &error),
            Ok(_) => {
                let dir = checkout.join(relative_to_native(
                    provenance.path.as_deref().unwrap_or_default(),
                ));
                if !dir.join(USER_SKILL_MARKDOWN_FILE).is_file() {
                    status(id, SkillCheckStatus::Gone)
                } else {
                    match fs_ops::tree_hash(&dir) {
                        Ok(hash) if Some(&hash) == provenance.tree_hash.as_ref() => {
                            status(id, SkillCheckStatus::Current)
                        }
                        Ok(_) => SkillCheck {
                            latest_commit: Some(head),
                            ..status(id, SkillCheckStatus::Update)
                        },
                        Err(error) => SkillCheck::unknown(id, error.to_string()),
                    }
                }
            }
        };
        let _ = std::fs::remove_dir_all(&checkout);
        result
    }

    fn temp_checkout_dir(&self, id: &str) -> PathBuf {
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        self.probe_dir.join(format!("check-{}-{}", id, &nonce[..8]))
    }

    // ---------------------------------------------------------------------
    // update
    // ---------------------------------------------------------------------

    pub async fn update(
        &self,
        ids: &[String],
        replace_edited: bool,
    ) -> AppResult<SkillUpdateResult> {
        let mut result = SkillUpdateResult::default();
        let mut session = BackupSession::new(&self.backups_dir);
        for id in ids {
            let skill = match self.load_metadata(id) {
                Ok(skill) => skill,
                Err(error) => {
                    result.failed.push(SkillIdError {
                        id: id.clone(),
                        error: error.message().to_string(),
                    });
                    continue;
                }
            };
            let provenance = effective_provenance(&skill);
            if !matches!(
                provenance.kind,
                SkillSourceKind::Github | SkillSourceKind::Git
            ) {
                result.failed.push(SkillIdError {
                    id: id.clone(),
                    error: "unsupported".to_string(),
                });
                continue;
            }
            let library_dir = self.user_skills_dir.join(id);
            if !replace_edited && edited_state(&provenance, &library_dir) != SkillEditedState::No {
                result.kept_edited.push(id.clone());
                continue;
            }
            match self.update_one(&skill, &provenance, &mut session).await {
                Ok(Upstream::Present) => result.updated.push(id.clone()),
                Ok(Upstream::Missing) => {
                    if !skill.gone {
                        self.persist_gone(id, true);
                    }
                    result.gone.push(id.clone());
                }
                Err(error) => result.failed.push(SkillIdError {
                    id: id.clone(),
                    error: error.message().to_string(),
                }),
            }
        }
        result.backup_dir = session.finish();
        let current: Vec<SkillCheck> = result
            .updated
            .iter()
            .map(|id| status(id, SkillCheckStatus::Current))
            .chain(
                result
                    .gone
                    .iter()
                    .map(|id| status(id, SkillCheckStatus::Gone)),
            )
            .collect();
        self.remember_checks(&current);
        info!(
            updated = result.updated.len(),
            kept = result.kept_edited.len(),
            gone = result.gone.len(),
            failed = result.failed.len(),
            "[skill_library] update finished"
        );
        Ok(result)
    }

    async fn update_one(
        &self,
        skill: &InstalledUserSkill,
        provenance: &SkillProvenance,
        session: &mut BackupSession,
    ) -> AppResult<Upstream> {
        let staged = match provenance.kind {
            SkillSourceKind::Github => self.stage_github_update(skill, provenance).await?,
            _ => self.stage_git_update(skill, provenance).await?,
        };
        let Some((staging, mut metadata)) = staged else {
            return Ok(Upstream::Missing);
        };
        // 保留用户可见的身份信息：id、安装时间、市场带来的分类和标签。
        metadata.installed_at = skill.installed_at.clone();
        metadata.category = skill.category.clone();
        metadata.tags = skill.tags.clone();
        metadata.homepage_url = skill.homepage_url.clone().or(metadata.homepage_url);
        let target = self.user_skills_dir.join(&skill.id);
        let placed = (|| -> AppResult<()> {
            UserSkillService::write_metadata(&staging, &metadata)?;
            let stashed = if target.exists() {
                Some(session.stash(&skill.id, &target)?)
            } else {
                None
            };
            if let Err(error) = std::fs::rename(&staging, &target) {
                if let Some(stashed) = stashed {
                    let _ = fs_ops::move_dir(&stashed, &target);
                }
                return Err(error.into());
            }
            Ok(())
        })();
        if let Err(error) = placed {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
        Ok(Upstream::Present)
    }

    /// `Ok(None)` = 完整列表里确认没有这个技能。
    async fn stage_github_update(
        &self,
        skill: &InstalledUserSkill,
        provenance: &SkillProvenance,
    ) -> AppResult<Option<(PathBuf, InstalledUserSkill)>> {
        let repo = github_repo(provenance).map_err(AppError::from)?;
        let path = provenance.path.clone().unwrap_or_default();
        let listing = self
            .remote
            .github_list(&repo, provenance.git_ref.as_deref())
            .await?;
        if !listing_has_skill(&listing, &path) {
            if listing.truncated {
                return Err(AppError::from("repository listing was truncated"));
            }
            return Ok(None);
        }
        let files: Vec<String> = github_files_under(&listing, &path)
            .into_iter()
            .map(|(file, _)| file)
            .collect();
        let request = GithubDirInstall {
            repo: &repo,
            listing: &listing,
            skill_dir: &path,
            files: &files,
            git_ref: provenance.git_ref.as_deref(),
            id: &skill.id,
        };
        let (staging, markdown, new_provenance) = self.stage_github_dir(&request).await?;
        let version = short_commit(new_provenance.commit.as_deref());
        let mut metadata =
            metadata_from_markdown(&markdown, &skill.id, &skill.name, new_provenance, &version);
        metadata.license = metadata.license.or_else(|| skill.license.clone());
        Ok(Some((staging, metadata)))
    }

    async fn stage_git_update(
        &self,
        skill: &InstalledUserSkill,
        provenance: &SkillProvenance,
    ) -> AppResult<Option<(PathBuf, InstalledUserSkill)>> {
        let url = provenance.repo.clone().unwrap_or_default();
        let checkout = self.temp_checkout_dir(&skill.id);
        let outcome = self
            .stage_git_from_checkout(skill, provenance, &url, &checkout)
            .await;
        let _ = std::fs::remove_dir_all(&checkout);
        outcome
    }

    async fn stage_git_from_checkout(
        &self,
        skill: &InstalledUserSkill,
        provenance: &SkillProvenance,
        url: &str,
        checkout: &Path,
    ) -> AppResult<Option<(PathBuf, InstalledUserSkill)>> {
        let head = self
            .remote
            .git_clone(url, provenance.git_ref.as_deref(), checkout)
            .await?;
        let path = provenance.path.clone().unwrap_or_default();
        let source = checkout.join(relative_to_native(&path));
        if !source.join(USER_SKILL_MARKDOWN_FILE).is_file() {
            return Ok(None);
        }
        let staging = self.staging_dir(&skill.id);
        let outcome = (|| -> AppResult<InstalledUserSkill> {
            fs_ops::copy_dir_filtered(&source, &staging)?;
            let new_provenance = SkillProvenance {
                kind: SkillSourceKind::Git,
                repo: Some(url.to_string()),
                git_ref: provenance.git_ref.clone(),
                path: Some(path.clone()),
                commit: Some(head.clone()),
                tree_hash: Some(fs_ops::tree_hash(&staging)?),
                ..Default::default()
            };
            super::metadata_from_dir(
                &staging,
                &skill.id,
                &skill.name,
                new_provenance,
                &short_commit(Some(&head)),
            )
        })();
        match outcome {
            Ok(metadata) => Ok(Some((staging, metadata))),
            Err(error) => {
                let _ = std::fs::remove_dir_all(&staging);
                Err(error)
            }
        }
    }
}
