//! 资源库技能原生挂载后的提示词：挂载了的不再内联，没挂上的照旧内联；以及字节数测量。
//!
//! 测量：`cargo test -p cc-panes-core --lib library_mount_prompt_bytes -- --nocapture`

use super::*;
use crate::models::launch_profile::{LaunchProfileDraft, LaunchProfileSkillPolicy};
use crate::services::library_skill_sets::library_mount_dir;
use crate::services::InstalledUserSkill;

fn service(tmp: &Path) -> LaunchProfileService {
    let registry = Arc::new(ExternalSkillRegistry::with_roots_for_test(
        Vec::new(),
        tmp.join("plugins"),
    ));
    LaunchProfileService::new_with_external_skill_registry(
        tmp.join("launch-profiles.json"),
        registry,
    )
}

fn install(service: &LaunchProfileService, id: &str, description: &str, body: &str) {
    UserSkillService::new(service.user_skills_dir.clone())
        .write_skill(
            &InstalledUserSkill {
                id: id.into(),
                name: id.into(),
                description: Some(description.into()),
                category: None,
                tags: Vec::new(),
                version: "1.0.0".into(),
                license: None,
                homepage_url: None,
                source_url: None,
                content_sha256: "sha".into(),
                installed_at: "2026-11-27T00:00:00Z".into(),
                file_path: None,
                provenance: None,
                gone: false,
            },
            body,
        )
        .unwrap();
}

fn profile_with(
    service: &LaunchProfileService,
    mode: LaunchProfileSkillMode,
    ids: &[String],
) -> LaunchProfile {
    service
        .create_profile(LaunchProfileDraft {
            name: Some("Library".into()),
            alias: None,
            description: None,
            provider_id: None,
            provider_account_id: None,
            model_id: None,
            adapter_options: Default::default(),
            target_tools: vec!["claude".into()],
            target_runtime: None,
            yolo_mode: false,
            mcp_policy: Default::default(),
            skill_policy: LaunchProfileSkillPolicy {
                mode,
                enabled_skill_ids: ids.to_vec(),
                ..Default::default()
            },
            native_overrides: Default::default(),
            is_default: false,
        })
        .unwrap()
}

fn skill_md(id: &str, description: &str, body: &str) -> String {
    format!("---\nname: {id}\ndescription: {description}\n---\n\n{body}")
}

#[test]
fn mounted_library_skills_are_not_inlined_but_the_rest_are() {
    let tmp = tempfile::tempdir().unwrap();
    let service = service(tmp.path());
    install(
        &service,
        "alpha",
        "Alpha helper",
        &skill_md("alpha", "Alpha helper", "ALPHA BODY"),
    );
    install(
        &service,
        "plain",
        "Plain helper",
        "PLAIN BODY without frontmatter",
    );
    let ids = vec!["user:alpha".to_string(), "user:plain".to_string()];
    let profile = profile_with(&service, LaunchProfileSkillMode::Custom, &ids);

    let selected = service.session_library_skills(Some(&profile));
    assert_eq!(selected.len(), 2);
    let skills_root = service.user_skills_dir.parent().unwrap().to_path_buf();
    let mount = library_mount_dir(&skills_root, &selected).unwrap();
    assert!(mount.dir.join("skills/alpha/SKILL.md").is_file());

    let prompt = service
        .session_skill_prompt_for_profile_with_mounted(Some(&profile), &mount.mounted_ids)
        .unwrap();
    assert!(
        !prompt.contains("ALPHA BODY"),
        "mounted skill body is not inlined"
    );
    assert!(
        prompt.contains("PLAIN BODY"),
        "unmountable skill falls back to inline"
    );

    // 没挂载（不可挂载的 CLI / 物化失败）时与原来逐字节一致
    assert_eq!(
        service.session_skill_prompt_for_profile_with_mounted(Some(&profile), &BTreeSet::new()),
        service.session_skill_prompt_for_profile(Some(&profile))
    );
}

#[test]
fn disabled_or_non_session_profiles_select_no_library_skills() {
    let tmp = tempfile::tempdir().unwrap();
    let service = service(tmp.path());
    install(&service, "alpha", "A", &skill_md("alpha", "A", "B"));
    let ids = vec!["user:alpha".to_string()];
    let disabled = profile_with(&service, LaunchProfileSkillMode::Disabled, &ids);
    assert!(service.session_library_skills(Some(&disabled)).is_empty());
    assert!(service.session_library_skills(None).is_empty());
}

/// 20 个资源库技能：原来整份内联 vs 原生挂载后的提示词字节数（`--nocapture` 看输出）。
#[test]
fn library_mount_prompt_bytes() {
    let tmp = tempfile::tempdir().unwrap();
    let service = service(tmp.path());
    let mut ids = Vec::new();
    for index in 0..20 {
        let id = format!("skill-{index:02}");
        let description = format!(
            "Use this skill when the user asks for task family {index}: covers setup, \
             conventions, pitfalls and verification steps in detail."
        );
        let body = format!(
            "# Skill {index}\n\n{}",
            "Step: do the thing carefully.\n".repeat(60)
        );
        install(
            &service,
            &id,
            &description,
            &skill_md(&id, &description, &body),
        );
        ids.push(format!("user:{id}"));
    }
    let skills_root = service.user_skills_dir.parent().unwrap().to_path_buf();
    for mode in [LaunchProfileSkillMode::Core, LaunchProfileSkillMode::Custom] {
        let profile = profile_with(&service, mode, &ids);
        let before = service
            .session_skill_prompt_for_profile(Some(&profile))
            .map_or(0, |prompt| prompt.len());
        let selected = service.session_library_skills(Some(&profile));
        let mount = library_mount_dir(&skills_root, &selected).unwrap();
        assert_eq!(mount.mounted_ids.len(), 20);
        let after = service
            .session_skill_prompt_for_profile_with_mounted(Some(&profile), &mount.mounted_ids)
            .map_or(0, |prompt| prompt.len());
        // CLI 原生加载时上下文里只放 name + description
        let native_listing: usize = selected
            .iter()
            .map(|skill| {
                skill.skill.id.len() + skill.skill.description.as_deref().unwrap_or("").len()
            })
            .sum();
        println!(
            "library skills {mode:?}: 20 skills inline={before} bytes, mounted prompt={after} bytes (+~{native_listing} bytes name/description listed by the CLI)"
        );
        assert!(after * 5 < before);
    }
}
