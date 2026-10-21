use super::*;
use crate::services::ExternalSkillRegistry;
use std::fs;
use std::path::Path;
use std::sync::Arc;

fn draft(name: &str, cli: &str) -> LaunchProfileDraft {
    serde_json::from_value(serde_json::json!({ "name": name, "targetTools": [cli] })).unwrap()
}

fn fail_atomic_write(path: &Path, content: &[u8]) -> Result<()> {
    // Exercise a real OS rename failure on every platform, not a synthetic Err.
    // The directory is a fixture destination; the saved configuration stays readable.
    crate::utils::atomic_file::write_atomic(&path.with_file_name("blocked-target"), content)
}

struct Fixture {
    _root: tempfile::TempDir,
    service: LaunchProfileService,
    initial: Vec<LaunchProfile>,
    bytes: Vec<u8>,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let registry = Arc::new(ExternalSkillRegistry::with_roots_for_test(
            Vec::new(),
            root.path().join("plugins"),
        ));
        let mut service = LaunchProfileService::new_with_external_skill_registry(
            root.path().join("launch-profiles.json"),
            registry,
        );
        service.create_profile(draft("Original", "claude")).unwrap();
        service
            .create_profile(draft("Alternative", "claude"))
            .unwrap();
        let mut codex = draft("Codex", "codex");
        codex.is_default = true;
        service.create_profile(codex).unwrap();
        let initial = service.list_profiles();
        let bytes = fs::read(&service.config_path).unwrap();
        fs::create_dir(root.path().join("blocked-target")).unwrap();
        service.persistence_writer = Some(fail_atomic_write);
        Self {
            _root: root,
            service,
            initial,
            bytes,
        }
    }

    fn assert_failure_isolated(&mut self, error: anyhow::Error) {
        assert!(error
            .chain()
            .any(|cause| cause.downcast_ref::<std::io::Error>().is_some()));
        assert_eq!(self.service.list_profiles(), self.initial);
        assert_eq!(fs::read(&self.service.config_path).unwrap(), self.bytes);
        for (cli, index) in [("claude", 0), ("codex", 2)] {
            let resolved =
                self.service
                    .resolve_launch_profile(None, None, None, Some(cli), Some("local"));
            assert_eq!(resolved.unwrap().id, self.initial[index].id);
        }
        assert_eq!(self.restarted().list_profiles(), self.initial);
        assert!(
            !fs::read_dir(self._root.path()).unwrap().any(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".tmp-")
            }),
            "failed atomic writes must clean their temporary file"
        );

        // A later unrelated success must not smuggle in a rejected YOLO/default edit.
        self.service.persistence_writer = None;
        let unrelated = self
            .service
            .create_profile(draft("Unrelated", "gemini"))
            .unwrap();
        let mut expected = self.initial.clone();
        expected.push(unrelated);
        assert_eq!(self.service.list_profiles(), expected);
        assert_eq!(self.restarted().list_profiles(), expected);
        assert!(self
            .service
            .list_profiles()
            .iter()
            .all(|profile| !profile.yolo_mode));
    }

    fn restarted(&self) -> LaunchProfileService {
        LaunchProfileService::new_with_external_skill_registry(
            self.service.config_path.clone(),
            self.service.external_skill_registry.clone(),
        )
    }
}

#[test]
fn failed_create_keeps_profiles_and_overlapping_defaults_unchanged() {
    let mut fixture = Fixture::new();
    let mut created = draft("Rejected", "claude");
    created.is_default = true;
    created.yolo_mode = true;
    let error = fixture.service.create_profile(created).unwrap_err();
    fixture.assert_failure_isolated(error);
}

#[test]
fn failed_update_never_publishes_yolo_or_default_selection() {
    let mut fixture = Fixture::new();
    let mut changed = draft("Rejected update", "claude");
    changed.is_default = true;
    changed.yolo_mode = true;
    changed.provider_id = Some("rejected-provider".into());
    let error = fixture
        .service
        .update_profile(&fixture.initial[1].id, changed)
        .unwrap_err();
    fixture.assert_failure_isolated(error);
}

#[test]
fn failed_delete_does_not_remove_or_promote_a_default() {
    let mut fixture = Fixture::new();
    let error = fixture
        .service
        .delete_profile(&fixture.initial[0].id)
        .unwrap_err();
    fixture.assert_failure_isolated(error);
}

#[test]
fn failed_set_default_keeps_both_target_and_previous_defaults() {
    let mut fixture = Fixture::new();
    let error = fixture
        .service
        .set_default_profile(&fixture.initial[1].id)
        .unwrap_err();
    fixture.assert_failure_isolated(error);
}

#[test]
fn successful_mutations_and_default_promotion_survive_restart() {
    let mut fixture = Fixture::new();
    fixture.service.persistence_writer = None;
    assert!(
        fixture.initial[0].is_default,
        "the first profile remains the default"
    );
    let mut edited = draft("Updated alternative", "claude");
    edited.is_default = true;
    edited.yolo_mode = true;
    edited.provider_id = Some("provider".into());
    edited.model_id = Some("model".into());
    fixture
        .service
        .update_profile(&fixture.initial[1].id, edited)
        .unwrap();
    assert_eq!(
        fixture.restarted().list_profiles(),
        fixture.service.list_profiles()
    );
    fixture
        .service
        .set_default_profile(&fixture.initial[0].id)
        .unwrap();
    assert_eq!(
        fixture.restarted().list_profiles(),
        fixture.service.list_profiles()
    );
    fixture
        .service
        .delete_profile(&fixture.initial[0].id)
        .unwrap();
    let restarted = fixture.restarted();
    assert_eq!(restarted.list_profiles(), fixture.service.list_profiles());
    let promoted = restarted.get_profile(&fixture.initial[1].id).unwrap();
    assert!(promoted.is_default && promoted.yolo_mode);
    assert_eq!(promoted.provider_id.as_deref(), Some("provider"));
    assert_eq!(promoted.model_id.as_deref(), Some("model"));
    assert!(
        restarted
            .get_profile(&fixture.initial[2].id)
            .unwrap()
            .is_default
    );
}
