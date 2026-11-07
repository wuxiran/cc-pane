//! 资源库服务的集成测试：假的上游（不联网），临时目录。

use super::remote::{RemoteFuture, SkillRemote};
use super::*;
use crate::models::launch_profile::{
    LaunchProfileDraft, LaunchProfileSkillMode, LaunchProfileSkillPolicy,
};
use crate::models::skill_library::{
    SkillCheckStatus, SkillEditedState, SkillInstallResult, SkillProbe,
};
use crate::services::skill_repo_fetcher::{RemoteError, RepoFile, RepoListing, RepoRef};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use tempfile::TempDir;

#[derive(Clone, Default)]
struct FakeRepo {
    files: BTreeMap<String, Vec<u8>>,
    commit: String,
    /// 列表里报告的大小（模拟超大技能，不必真的分配 50 MB）。
    sizes: HashMap<String, u64>,
}

impl FakeRepo {
    fn with(files: &[(&str, &str)], commit: &str) -> Self {
        Self {
            files: files
                .iter()
                .map(|(path, body)| (path.to_string(), body.as_bytes().to_vec()))
                .collect(),
            commit: commit.to_string(),
            sizes: HashMap::new(),
        }
    }
}

#[derive(Default)]
struct FakeRemote {
    github: Mutex<HashMap<String, FakeRepo>>,
    git: Mutex<HashMap<String, FakeRepo>>,
    commit_error: Mutex<Option<RemoteError>>,
    list_error: Mutex<Option<RemoteError>>,
    truncated: AtomicBool,
}

impl FakeRemote {
    fn set_github(&self, slug: &str, repo: FakeRepo) {
        self.github.lock().unwrap().insert(slug.to_string(), repo);
    }

    fn set_git(&self, url: &str, repo: FakeRepo) {
        self.git.lock().unwrap().insert(url.to_string(), repo);
    }

    fn github_repo(&self, repo: &RepoRef) -> Result<FakeRepo, RemoteError> {
        self.github
            .lock()
            .unwrap()
            .get(&repo.slug())
            .cloned()
            .ok_or_else(|| RemoteError::Failed("404".into()))
    }
}

impl SkillRemote for FakeRemote {
    fn github_list<'a>(
        &'a self,
        repo: &'a RepoRef,
        _git_ref: Option<&'a str>,
    ) -> RemoteFuture<'a, RepoListing> {
        Box::pin(async move {
            if let Some(error) = self.list_error.lock().unwrap().clone() {
                return Err(error);
            }
            let fake = self.github_repo(repo)?;
            Ok(RepoListing {
                git_ref: format!("tree-{}", fake.commit),
                via_mirror: false,
                files: fake
                    .files
                    .iter()
                    .map(|(path, bytes)| RepoFile {
                        path: path.clone(),
                        size: Some(fake.sizes.get(path).copied().unwrap_or(bytes.len() as u64)),
                    })
                    .collect(),
                truncated: self.truncated.load(Ordering::SeqCst),
            })
        })
    }

    fn github_fetch<'a>(
        &'a self,
        repo: &'a RepoRef,
        _listing: &'a RepoListing,
        path: &'a str,
    ) -> RemoteFuture<'a, Vec<u8>> {
        Box::pin(async move {
            self.github_repo(repo)?
                .files
                .get(path)
                .cloned()
                .ok_or_else(|| RemoteError::Failed(format!("missing {path}")))
        })
    }

    fn github_latest_commit<'a>(
        &'a self,
        repo: &'a RepoRef,
        _path: &'a str,
        _git_ref: Option<&'a str>,
    ) -> RemoteFuture<'a, Option<String>> {
        Box::pin(async move {
            if let Some(error) = self.commit_error.lock().unwrap().clone() {
                return Err(error);
            }
            Ok(Some(self.github_repo(repo)?.commit))
        })
    }

    fn git_ls_remote<'a>(
        &'a self,
        url: &'a str,
        _git_ref: Option<&'a str>,
    ) -> RemoteFuture<'a, String> {
        Box::pin(async move {
            self.git
                .lock()
                .unwrap()
                .get(url)
                .map(|repo| repo.commit.clone())
                .ok_or_else(|| RemoteError::Failed("unreachable".into()))
        })
    }

    fn git_clone<'a>(
        &'a self,
        url: &'a str,
        _git_ref: Option<&'a str>,
        dest: &'a Path,
    ) -> RemoteFuture<'a, String> {
        Box::pin(async move {
            let repo = self
                .git
                .lock()
                .unwrap()
                .get(url)
                .cloned()
                .ok_or_else(|| RemoteError::Failed("unreachable".into()))?;
            for (path, bytes) in &repo.files {
                let target = dest.join(fs_ops::relative_to_native(path));
                std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                std::fs::write(target, bytes).unwrap();
            }
            std::fs::create_dir_all(dest.join(".git")).unwrap();
            std::fs::write(dest.join(".git/HEAD"), "ref").unwrap();
            Ok(repo.commit)
        })
    }
}

struct Fixture {
    tmp: TempDir,
    remote: Arc<FakeRemote>,
    service: SkillLibraryService,
    profiles: Arc<LaunchProfileService>,
}

impl Fixture {
    fn new() -> Self {
        let tmp = TempDir::new().unwrap();
        let data = tmp.path().join("data");
        let profiles = Arc::new(LaunchProfileService::new(data.join("launch-profiles.json")));
        let remote = Arc::new(FakeRemote::default());
        let service = SkillLibraryService::with_remote(
            data.join("skills").join("user"),
            data.join("backups").join("skills"),
            Some(tmp.path().join("home")),
            tmp.path().join("probes"),
            remote.clone(),
            Some(profiles.clone()),
        );
        Self {
            tmp,
            remote,
            service,
            profiles,
        }
    }

    fn home(&self) -> PathBuf {
        self.tmp.path().join("home")
    }

    fn library_dir(&self, id: &str) -> PathBuf {
        self.service.user_skills_dir().join(id)
    }

    fn skill(&self, id: &str) -> LibrarySkill {
        self.service
            .list()
            .unwrap()
            .into_iter()
            .find(|skill| skill.id == id)
            .unwrap_or_else(|| panic!("{id} not in library"))
    }

    fn backup_root(&self) -> PathBuf {
        self.tmp.path().join("data").join("backups").join("skills")
    }
}

fn skill_md(name: &str, description: &str) -> String {
    format!("---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n")
}

fn write_file(root: &Path, relative: &str, body: &str) {
    let path = root.join(fs_ops::relative_to_native(relative));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
}

fn anthropic_repo(commit: &str) -> FakeRepo {
    let pdf = skill_md("pdf", "Read PDFs");
    let xlsx = skill_md("xlsx", "Spreadsheets");
    let mut repo = FakeRepo::with(
        &[
            ("README.md", "readme"),
            ("skills/pdf/SKILL.md", &pdf),
            ("skills/pdf/scripts/extract.py", "print()"),
            ("skills/xlsx/SKILL.md", &xlsx),
            ("skills/huge/SKILL.md", "---\nname: huge\n---\n"),
            ("skills/huge/blob.bin", "x"),
            ("node_modules/dep/SKILL.md", "ignored"),
        ],
        commit,
    );
    repo.sizes
        .insert("skills/huge/blob.bin".to_string(), 60 * 1024 * 1024);
    repo
}

async fn install_all(fixture: &Fixture, source: &str) -> (SkillProbe, SkillInstallResult) {
    let probe = fixture.service.probe(source).await.unwrap();
    let paths: Vec<String> = probe.candidates.iter().map(|c| c.path.clone()).collect();
    let result = fixture
        .service
        .install(&probe.probe_id, &paths)
        .await
        .unwrap();
    (probe, result)
}

// ---------------------------------------------------------------------------
// probe / install (github)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn github_probe_lists_candidates_too_big_and_name_clash() {
    let fixture = Fixture::new();
    fixture
        .remote
        .set_github("anthropics/skills", anthropic_repo("c1"));
    // 资源库里已有另一个来源的 "pdf"
    let other = fixture.home().join("elsewhere/pdf");
    write_file(&other, "SKILL.md", &skill_md("pdf", "mine"));
    let folder_probe = fixture
        .service
        .probe(&other.to_string_lossy())
        .await
        .unwrap();
    fixture
        .service
        .install(&folder_probe.probe_id, &[String::new()])
        .await
        .unwrap();

    let probe = fixture
        .service
        .probe("npx skills add anthropics/skills")
        .await
        .unwrap();
    assert_eq!(probe.kind, SkillSourceKind::Github);
    assert_eq!(probe.source, "anthropics/skills");
    let paths: Vec<&str> = probe.candidates.iter().map(|c| c.path.as_str()).collect();
    assert_eq!(paths, vec!["skills/pdf", "skills/xlsx"]);
    assert_eq!(probe.too_big.len(), 1);
    assert_eq!(probe.too_big[0].path, "skills/huge");
    let pdf = &probe.candidates[0];
    assert_eq!(pdf.name, "pdf");
    assert_eq!(pdf.description.as_deref(), Some("Read PDFs"));
    assert!(!pdf.have);
    assert_eq!(pdf.install_as, "pdf-anthropics");
    assert_eq!(probe.candidates[1].install_as, "xlsx");

    let result = fixture
        .service
        .install(
            &probe.probe_id,
            &["skills/pdf".into(), "skills/huge".into(), "nope".into()],
        )
        .await
        .unwrap();
    assert_eq!(result.installed, vec!["pdf-anthropics"]);
    assert_eq!(result.skipped.len(), 2);

    let dir = fixture.library_dir("pdf-anthropics");
    assert!(dir.join("scripts/extract.py").is_file());
    let installed = fixture.skill("pdf-anthropics");
    assert_eq!(installed.provenance.kind, SkillSourceKind::Github);
    assert_eq!(
        installed.provenance.repo.as_deref(),
        Some("anthropics/skills")
    );
    assert_eq!(installed.provenance.path.as_deref(), Some("skills/pdf"));
    assert_eq!(installed.provenance.commit.as_deref(), Some("c1"));
    assert_eq!(
        installed.provenance.tree_hash,
        Some(fs_ops::tree_hash(&dir).unwrap())
    );
    assert_eq!(installed.edited, SkillEditedState::No);
    // 没有半成品暂存目录
    assert!(std::fs::read_dir(fixture.service.user_skills_dir())
        .unwrap()
        .flatten()
        .all(|entry| !entry.file_name().to_string_lossy().starts_with(".staging")));

    // 同来源再探测：have
    let again = fixture.service.probe("anthropics/skills").await.unwrap();
    assert!(again.candidates[0].have);
    assert_eq!(
        again.candidates[0].have_as.as_deref(),
        Some("pdf-anthropics")
    );
    let result = fixture
        .service
        .install(&again.probe_id, &["skills/pdf".into()])
        .await
        .unwrap();
    assert_eq!(result.had, vec!["pdf-anthropics"]);
    assert!(result.installed.is_empty());
}

#[tokio::test]
async fn github_tree_link_limits_candidates_to_the_path() {
    let fixture = Fixture::new();
    fixture
        .remote
        .set_github("anthropics/skills", anthropic_repo("c1"));
    let probe = fixture
        .service
        .probe("https://github.com/anthropics/skills/tree/main/skills/xlsx")
        .await
        .unwrap();
    let paths: Vec<&str> = probe.candidates.iter().map(|c| c.path.as_str()).collect();
    assert_eq!(paths, vec!["skills/xlsx"]);
    fixture
        .service
        .install(&probe.probe_id, &["skills/xlsx".into()])
        .await
        .unwrap();
    assert_eq!(
        fixture.skill("xlsx").provenance.git_ref.as_deref(),
        Some("main")
    );
}

#[tokio::test]
async fn unknown_probe_id_is_rejected() {
    let fixture = Fixture::new();
    assert!(fixture.service.install("missing", &[]).await.is_err());
}

// ---------------------------------------------------------------------------
// check / update (github)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn github_check_reports_current_update_and_gone_only_after_full_fetch() {
    let fixture = Fixture::new();
    fixture
        .remote
        .set_github("anthropics/skills", anthropic_repo("c1"));
    install_all(&fixture, "anthropics/skills").await;

    let checks = fixture.service.check(None).await.unwrap();
    assert!(checks
        .iter()
        .all(|check| check.status == SkillCheckStatus::Current));

    // 上游有新提交
    fixture
        .remote
        .set_github("anthropics/skills", anthropic_repo("c2"));
    let ids = vec!["pdf".to_string()];
    let check = &fixture.service.check(Some(&ids)).await.unwrap()[0];
    assert_eq!(check.status, SkillCheckStatus::Update);
    assert_eq!(check.latest_commit.as_deref(), Some("c2"));
    assert_eq!(
        check.compare_url.as_deref(),
        Some("https://github.com/anthropics/skills/compare/c1...c2")
    );

    // 限流：unknown + rateLimitedUntil，不标 gone
    *fixture.remote.commit_error.lock().unwrap() = Some(RemoteError::RateLimited {
        until: Some("2026-11-04T12:00:00+00:00".into()),
        message: "rate limited".into(),
    });
    let check = &fixture.service.check(Some(&ids)).await.unwrap()[0];
    assert_eq!(check.status, SkillCheckStatus::Unknown);
    assert_eq!(
        check.rate_limited_until.as_deref(),
        Some("2026-11-04T12:00:00+00:00")
    );
    assert!(!fixture.skill("pdf").gone);
    *fixture.remote.commit_error.lock().unwrap() = None;

    // 目录被删：列表失败 → unknown；列表被截断 → unknown；完整列表 → gone 并持久化
    let mut deleted = anthropic_repo("c3");
    deleted
        .files
        .retain(|path, _| !path.starts_with("skills/pdf/"));
    fixture.remote.set_github("anthropics/skills", deleted);
    *fixture.remote.list_error.lock().unwrap() = Some(RemoteError::Failed("offline".into()));
    let check = &fixture.service.check(Some(&ids)).await.unwrap()[0];
    assert_eq!(check.status, SkillCheckStatus::Unknown);
    *fixture.remote.list_error.lock().unwrap() = None;
    fixture.remote.truncated.store(true, Ordering::SeqCst);
    assert_eq!(
        fixture.service.check(Some(&ids)).await.unwrap()[0].status,
        SkillCheckStatus::Unknown
    );
    assert!(!fixture.skill("pdf").gone);
    fixture.remote.truncated.store(false, Ordering::SeqCst);
    assert_eq!(
        fixture.service.check(Some(&ids)).await.unwrap()[0].status,
        SkillCheckStatus::Gone
    );
    assert!(fixture.skill("pdf").gone, "gone must be persisted");
    let raw = std::fs::read_to_string(fixture.library_dir("pdf").join("skill.json")).unwrap();
    assert!(raw.contains("\"gone\": true"));

    // 重新出现：清除 gone
    fixture
        .remote
        .set_github("anthropics/skills", anthropic_repo("c4"));
    assert_eq!(
        fixture.service.check(Some(&ids)).await.unwrap()[0].status,
        SkillCheckStatus::Update
    );
    assert!(!fixture.skill("pdf").gone);
    assert_eq!(fixture.service.last_checks().len(), 2);
}

#[tokio::test]
async fn update_skips_edited_unless_replace_and_backs_up() {
    let fixture = Fixture::new();
    fixture
        .remote
        .set_github("anthropics/skills", anthropic_repo("c1"));
    install_all(&fixture, "anthropics/skills").await;

    // 本地改动 pdf
    write_file(
        &fixture.library_dir("pdf"),
        "scripts/extract.py",
        "print('mine')",
    );
    assert_eq!(fixture.skill("pdf").edited, SkillEditedState::Yes);

    let mut upstream = anthropic_repo("c2");
    upstream
        .files
        .insert("skills/xlsx/new.md".into(), b"new".to_vec());
    upstream.files.insert(
        "skills/pdf/scripts/extract.py".into(),
        b"print('v2')".to_vec(),
    );
    fixture.remote.set_github("anthropics/skills", upstream);

    let ids = vec!["pdf".to_string(), "xlsx".to_string(), "missing".to_string()];
    let result = fixture.service.update(&ids, false).await.unwrap();
    assert_eq!(result.updated, vec!["xlsx"]);
    assert_eq!(result.kept_edited, vec!["pdf"]);
    assert_eq!(result.failed.len(), 1);
    let backup = PathBuf::from(result.backup_dir.clone().expect("backup dir"));
    assert!(backup.starts_with(fixture.backup_root()));
    assert!(backup.join("xlsx/SKILL.md").is_file());
    assert!(
        !backup.join("xlsx/new.md").exists(),
        "backup holds the old version"
    );
    assert!(fixture.library_dir("xlsx").join("new.md").is_file());
    let xlsx = fixture.skill("xlsx");
    assert_eq!(xlsx.provenance.commit.as_deref(), Some("c2"));
    assert_eq!(xlsx.edited, SkillEditedState::No);
    assert_eq!(
        std::fs::read_to_string(fixture.library_dir("pdf").join("scripts/extract.py")).unwrap(),
        "print('mine')"
    );

    // replaceEdited：覆盖并把用户版本放进备份
    let result = fixture
        .service
        .update(&["pdf".to_string()], true)
        .await
        .unwrap();
    assert_eq!(result.updated, vec!["pdf"]);
    let backup = PathBuf::from(result.backup_dir.unwrap());
    assert_eq!(
        std::fs::read_to_string(backup.join("pdf/scripts/extract.py")).unwrap(),
        "print('mine')"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.library_dir("pdf").join("scripts/extract.py")).unwrap(),
        "print('v2')"
    );

    // 上游删除：列入 gone，不算失败，本地不动
    let mut deleted = anthropic_repo("c3");
    deleted
        .files
        .retain(|path, _| !path.starts_with("skills/xlsx/"));
    fixture.remote.set_github("anthropics/skills", deleted);
    let result = fixture
        .service
        .update(&["xlsx".to_string()], true)
        .await
        .unwrap();
    assert_eq!(result.gone, vec!["xlsx"]);
    assert!(result.failed.is_empty());
    assert!(result.backup_dir.is_none());
    assert!(fixture.library_dir("xlsx").join("SKILL.md").is_file());
    assert!(fixture.skill("xlsx").gone);
}

#[tokio::test]
async fn legacy_install_without_tree_hash_counts_as_unknown_edit() {
    let fixture = Fixture::new();
    let dir = fixture.library_dir("legacy");
    write_file(&dir, "SKILL.md", "# legacy");
    write_file(
        &dir,
        "skill.json",
        r#"{"id":"legacy","name":"legacy","version":"abc","contentSha256":"x","installedAt":"2026-01-01T00:00:00Z","sourceUrl":"https://github.com/anthropics/skills/tree/deadbeef/skills/pdf"}"#,
    );
    let skill = fixture.skill("legacy");
    assert_eq!(skill.edited, SkillEditedState::Unknown);
    assert_eq!(skill.provenance.kind, SkillSourceKind::Github);
    assert_eq!(skill.provenance.path.as_deref(), Some("skills/pdf"));

    fixture
        .remote
        .set_github("anthropics/skills", anthropic_repo("c1"));
    let result = fixture
        .service
        .update(&["legacy".to_string()], false)
        .await
        .unwrap();
    assert_eq!(result.kept_edited, vec!["legacy"]);
    let result = fixture
        .service
        .update(&["legacy".to_string()], true)
        .await
        .unwrap();
    assert_eq!(result.updated, vec!["legacy"]);
    let skill = fixture.skill("legacy");
    assert_eq!(skill.edited, SkillEditedState::No);
    assert_eq!(skill.installed_at, "2026-01-01T00:00:00Z");
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

#[tokio::test]
async fn git_probe_install_and_check_compare_tree_hash() {
    let fixture = Fixture::new();
    let url = "https://git.example.com/team/skills.git";
    let review = skill_md("review", "Code review");
    fixture.remote.set_git(
        url,
        FakeRepo::with(&[("review/SKILL.md", &review), ("README.md", "x")], "h1"),
    );

    let (probe, result) = install_all(&fixture, url).await;
    assert_eq!(probe.kind, SkillSourceKind::Git);
    assert_eq!(result.installed, vec!["review"]);
    let skill = fixture.skill("review");
    assert_eq!(skill.provenance.commit.as_deref(), Some("h1"));
    assert_eq!(skill.provenance.repo.as_deref(), Some(url));
    assert!(!fixture.library_dir("review").join(".git").exists());

    let ids = vec!["review".to_string()];
    assert_eq!(
        fixture.service.check(Some(&ids)).await.unwrap()[0].status,
        SkillCheckStatus::Current
    );
    // HEAD 变了但技能目录没变 → current
    fixture.remote.set_git(
        url,
        FakeRepo::with(
            &[("review/SKILL.md", &review), ("README.md", "changed")],
            "h2",
        ),
    );
    assert_eq!(
        fixture.service.check(Some(&ids)).await.unwrap()[0].status,
        SkillCheckStatus::Current
    );
    fixture.remote.set_git(
        url,
        FakeRepo::with(&[("review/SKILL.md", "# changed")], "h3"),
    );
    let check = &fixture.service.check(Some(&ids)).await.unwrap()[0];
    assert_eq!(check.status, SkillCheckStatus::Update);
    assert_eq!(check.latest_commit.as_deref(), Some("h3"));
    let result = fixture.service.update(&ids, false).await.unwrap();
    assert_eq!(result.updated, ids);
    assert_eq!(fixture.service.read("review").unwrap().content, "# changed");

    fixture
        .remote
        .set_git(url, FakeRepo::with(&[("README.md", "x")], "h4"));
    assert_eq!(
        fixture.service.check(Some(&ids)).await.unwrap()[0].status,
        SkillCheckStatus::Gone
    );
    // 克隆用的临时目录都清掉了
    let leftovers = std::fs::read_dir(fixture.tmp.path().join("probes"))
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.file_name().to_string_lossy().starts_with("check-"))
                .count()
        })
        .unwrap_or(0);
    assert_eq!(leftovers, 0);
}

#[tokio::test]
async fn unsupported_sources_check_as_unknown() {
    let fixture = Fixture::new();
    let folder = fixture.home().join("mine");
    write_file(&folder, "SKILL.md", &skill_md("mine", "x"));
    install_all(&fixture, &folder.to_string_lossy()).await;
    let check = &fixture.service.check(None).await.unwrap()[0];
    assert_eq!(check.status, SkillCheckStatus::Unknown);
    assert_eq!(check.error.as_deref(), Some("unsupported"));
}

// ---------------------------------------------------------------------------
// folder
// ---------------------------------------------------------------------------

#[tokio::test]
async fn folder_install_links_without_copying() {
    let fixture = Fixture::new();
    let root = fixture.home().join("my-skills");
    write_file(&root, "alpha/SKILL.md", &skill_md("alpha", "A"));
    write_file(&root, "alpha/ref.md", "ref");
    write_file(&root, "nested/beta/SKILL.md", &skill_md("beta", "B"));
    write_file(&root, "node_modules/x/SKILL.md", "ignored");

    let probe = fixture.service.probe("~/my-skills").await.unwrap();
    assert_eq!(probe.kind, SkillSourceKind::Folder);
    let paths: Vec<&str> = probe.candidates.iter().map(|c| c.path.as_str()).collect();
    assert_eq!(paths, vec!["alpha", "nested/beta"]);
    fixture
        .service
        .install(&probe.probe_id, &["alpha".into()])
        .await
        .unwrap();

    let library_dir = fixture.library_dir("alpha");
    let entries: Vec<String> = std::fs::read_dir(&library_dir)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(entries, vec!["skill.json"]);
    let skill = fixture.skill("alpha");
    assert_eq!(skill.edited, SkillEditedState::No);
    assert!(!skill.folder_missing);
    let linked = dunce::canonicalize(root.join("alpha")).unwrap();
    assert_eq!(PathBuf::from(&skill.dir_path), linked);
    let read = fixture.service.read("alpha").unwrap();
    assert!(read.content.contains("# alpha"));
    assert_eq!(read.files, vec!["SKILL.md", "ref.md"]);

    // 会话提示词里的内容和 Skill directory 都指向链接目录
    let profile = fixture
        .profiles
        .create_profile(LaunchProfileDraft {
            name: Some("p".into()),
            alias: None,
            description: None,
            provider_id: None,
            model_id: None,
            adapter_options: Default::default(),
            target_tools: vec!["codex".into()],
            target_runtime: None,
            yolo_mode: false,
            mcp_policy: Default::default(),
            skill_policy: LaunchProfileSkillPolicy {
                mode: LaunchProfileSkillMode::Custom,
                enabled_skill_ids: vec!["user:alpha".into()],
                ..Default::default()
            },
            is_default: false,
        })
        .unwrap();
    let prompt = fixture
        .profiles
        .session_skill_prompt_for_profile(Some(&profile))
        .unwrap();
    assert!(prompt.contains("# alpha"));
    assert!(prompt.contains(&format!("Skill directory: {}", linked.display())));

    // 删除只动库目录；原目录还在
    fixture.service.remove(&["alpha".to_string()]).unwrap();
    assert!(root.join("alpha/SKILL.md").is_file());

    // 链接目录消失 → folderMissing
    let probe = fixture.service.probe("~/my-skills").await.unwrap();
    fixture
        .service
        .install(&probe.probe_id, &["nested/beta".into()])
        .await
        .unwrap();
    std::fs::remove_dir_all(root.join("nested")).unwrap();
    assert!(fixture.skill("beta").folder_missing);
    assert!(fixture.service.read("beta").is_err());
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

#[tokio::test]
async fn remove_moves_to_backup_and_strips_profile_ids() {
    let fixture = Fixture::new();
    fixture
        .remote
        .set_github("anthropics/skills", anthropic_repo("c1"));
    install_all(&fixture, "anthropics/skills").await;
    let draft = |enabled: Vec<&str>, disabled: Vec<&str>| LaunchProfileDraft {
        name: Some("p".into()),
        alias: None,
        description: None,
        provider_id: None,
        model_id: None,
        adapter_options: Default::default(),
        target_tools: vec!["claude".into()],
        target_runtime: None,
        yolo_mode: false,
        mcp_policy: Default::default(),
        skill_policy: LaunchProfileSkillPolicy {
            mode: LaunchProfileSkillMode::Custom,
            enabled_skill_ids: enabled.into_iter().map(str::to_string).collect(),
            disabled_skill_ids: disabled.into_iter().map(str::to_string).collect(),
            ..Default::default()
        },
        is_default: false,
    };
    let first = fixture
        .profiles
        .create_profile(draft(
            vec!["user:pdf", "builtin:ccpanes-admin"],
            vec!["user:pdf"],
        ))
        .unwrap();
    let second = fixture
        .profiles
        .create_profile(draft(vec!["user:xlsx", "user:pdf-2"], vec![]))
        .unwrap();

    let result = fixture.service.remove(&["pdf".to_string()]).unwrap();
    assert_eq!(result.removed, vec!["pdf"]);
    let backup = PathBuf::from(result.backup_dir.unwrap());
    assert!(backup.join("pdf/SKILL.md").is_file());
    assert!(!fixture.library_dir("pdf").exists());

    let first = fixture.profiles.get_profile(&first.id).unwrap();
    assert_eq!(
        first.skill_policy.enabled_skill_ids,
        vec!["builtin:ccpanes-admin"]
    );
    assert!(first.skill_policy.disabled_skill_ids.is_empty());
    let second = fixture.profiles.get_profile(&second.id).unwrap();
    assert_eq!(
        second.skill_policy.enabled_skill_ids,
        vec!["user:xlsx", "user:pdf-2"]
    );
    // 持久化到磁盘
    let reloaded = LaunchProfileService::new(fixture.tmp.path().join("data/launch-profiles.json"));
    assert!(!reloaded
        .get_profile(&first.id)
        .unwrap()
        .skill_policy
        .enabled_skill_ids
        .contains(&"user:pdf".to_string()));

    // 不存在的 id 不报错也不建备份
    let result = fixture.service.remove(&["ghost".to_string()]).unwrap();
    assert!(result.removed.is_empty());
    assert!(result.backup_dir.is_none());
    assert!(fixture.service.remove(&["../x".to_string()]).is_err());
}

// ---------------------------------------------------------------------------
// found / import
// ---------------------------------------------------------------------------

#[tokio::test]
async fn found_scans_agent_folders_and_import_copies() {
    let fixture = Fixture::new();
    let home = fixture.home();
    write_file(
        &home.join(".claude/skills/writer"),
        "SKILL.md",
        &skill_md("writer", "Write"),
    );
    write_file(
        &home.join(".claude/skills/writer"),
        "node_modules/x.js",
        "x",
    );
    write_file(&home.join(".claude/skills/no-skill"), "README.md", "x");
    write_file(&home.join(".codex/skills/.system/builtin"), "SKILL.md", "x");
    write_file(
        &home.join(".codex/skills/review"),
        "SKILL.md",
        &skill_md("review", "R"),
    );
    let shared = home.join("shared/agent-one");
    write_file(&shared, "SKILL.md", &skill_md("agent-one", "One"));
    std::fs::create_dir_all(home.join(".agents/skills")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&shared, home.join(".agents/skills/agent-one")).unwrap();
    #[cfg(not(unix))]
    write_file(
        &home.join(".agents/skills/agent-one"),
        "SKILL.md",
        &skill_md("agent-one", "One"),
    );

    // 资源库已有同名 review
    let mine = home.join("mine/review");
    write_file(&mine, "SKILL.md", &skill_md("review", "mine"));
    install_all(&fixture, &mine.to_string_lossy()).await;

    let found = fixture.service.found().unwrap();
    let names: Vec<(&str, FoundSkillOrigin)> = found
        .iter()
        .map(|skill| (skill.name.as_str(), skill.origin))
        .collect();
    assert_eq!(
        names,
        vec![
            ("writer", FoundSkillOrigin::Claude),
            ("review", FoundSkillOrigin::Codex),
            ("agent-one", FoundSkillOrigin::Agents),
        ]
    );
    assert_eq!(found[1].in_library_as.as_deref(), Some("review"));
    assert!(found[0].in_library_as.is_none());
    #[cfg(unix)]
    {
        assert!(found[2].is_link);
        assert_eq!(
            found[2].link_target.as_deref(),
            Some(&*shared.to_string_lossy())
        );
    }

    let keys: Vec<String> = found.iter().map(|skill| skill.key.clone()).collect();
    let mut request = keys.clone();
    request.push("/etc".to_string());
    let result = fixture.service.import(&request).unwrap();
    assert_eq!(result.imported, vec!["writer", "review-codex", "agent-one"]);
    assert_eq!(result.failed.len(), 1);
    assert_eq!(result.failed[0].key, "/etc");

    let writer = fixture.skill("writer");
    assert_eq!(writer.provenance.kind, SkillSourceKind::Imported);
    assert_eq!(
        writer.provenance.imported_from.as_deref(),
        Some(keys[0].as_str())
    );
    assert_eq!(writer.edited, SkillEditedState::No);
    assert!(!fixture.library_dir("writer").join("node_modules").exists());
    assert!(fixture.library_dir("agent-one").join("SKILL.md").is_file());
    #[cfg(unix)]
    assert!(!std::fs::symlink_metadata(fixture.library_dir("agent-one"))
        .unwrap()
        .file_type()
        .is_symlink());
    // 原目录不动
    assert!(home
        .join(".claude/skills/writer/node_modules/x.js")
        .is_file());
    assert!(shared.join("SKILL.md").is_file());

    // 再导入同一路径：拒绝
    let again = fixture.service.import(&keys[..1]).unwrap();
    assert!(again.imported.is_empty());
    assert!(again.failed[0].error.contains("writer"));
}

#[test]
fn slug_and_unique_id_rules() {
    assert_eq!(slugify("Brand Guidelines"), "brand-guidelines");
    assert_eq!(slugify("  ../weird//name "), "weird-name");
    assert_eq!(slugify("中文"), "skill");
    let taken: HashSet<String> = ["pdf", "pdf-anthropics"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert_eq!(unique_id("xlsx", "anthropics", &taken), "xlsx");
    assert_eq!(unique_id("pdf", "anthropics", &taken), "pdf-anthropics-2");
    assert_eq!(unique_id("pdf", "acme", &taken), "pdf-acme");
}

#[test]
fn source_identity_ignores_ref_and_normalizes_git_urls() {
    let github = |git_ref: Option<&str>| SkillProvenance {
        kind: SkillSourceKind::Github,
        repo: Some("Anthropics/Skills".into()),
        git_ref: git_ref.map(str::to_string),
        path: Some("skills/pdf/".into()),
        ..Default::default()
    };
    assert_eq!(
        source_identity(&github(None)),
        source_identity(&github(Some("main")))
    );
    let git = |url: &str| SkillProvenance {
        kind: SkillSourceKind::Git,
        repo: Some(url.into()),
        path: Some(String::new()),
        ..Default::default()
    };
    assert_eq!(
        source_identity(&git("https://host/o/r.git")),
        source_identity(&git("https://host/o/r/"))
    );
    assert_eq!(source_identity(&SkillProvenance::default()), None);
}
