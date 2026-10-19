use cc_panes_core::models::provider::{Provider, ProviderType};
use cc_panes_core::services::ProviderService;
use std::{fs, path::Path};

fn provider(index: usize) -> Provider {
    Provider {
        id: format!("fixture-{index}"),
        name: format!("Fixture {index}"),
        provider_type: ProviderType::Anthropic,
        api_key: Some(format!("fixture-key-{index}")),
        base_url: None,
        region: None,
        project_id: None,
        aws_profile: None,
        config_dir: None,
        models: vec![],
        default_model_id: None,
        codex_wire_api: None,
        is_default: false,
    }
}

fn write_config(path: &Path, count: usize) {
    fs::write(
        path,
        serde_json::to_vec(&serde_json::json!({
            "providers": (0..count).map(provider).collect::<Vec<_>>(),
            "defaultProviderIdsVersion": 2,
        }))
        .unwrap(),
    )
    .unwrap();
}

#[test]
fn both_creation_entry_points_reject_growth_without_changing_disk_or_memory() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("providers.json");
    write_config(&path, 256);
    let before = fs::read(&path).unwrap();
    let service = ProviderService::new(path.clone());
    assert!(service
        .add_provider(provider(256))
        .unwrap_err()
        .to_string()
        .contains("256"));
    assert!(service
        .add_provider_unique(provider(257))
        .unwrap_err()
        .to_string()
        .contains("256"));
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(service.list_providers().len(), 256);
    assert_eq!(ProviderService::new(path).list_providers().len(), 256);
}

#[test]
fn legacy_oversized_configuration_remains_readable_and_can_be_repaired() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("providers.json");
    write_config(&path, 257);
    let before = fs::read(&path).unwrap();
    let service = ProviderService::new(path.clone());
    assert_eq!(service.list_providers().len(), 257);
    assert!(service.add_provider(provider(300)).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    let mut edited = service.get_provider("fixture-1").unwrap();
    edited.name = "Recovered configuration".into();
    service.update_provider(edited).unwrap();
    service.remove_provider("fixture-0").unwrap();
    let restarted = ProviderService::new(path);
    assert_eq!(restarted.list_providers().len(), 256);
    assert_eq!(
        restarted.get_provider("fixture-1").unwrap().name,
        "Recovered configuration"
    );
    assert_eq!(
        restarted
            .get_provider("fixture-256")
            .unwrap()
            .api_key
            .as_deref(),
        Some("fixture-key-256")
    );
    assert!(restarted.add_provider_unique(provider(301)).is_err());
}

#[test]
fn creation_limit_uses_the_latest_saved_configuration() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("providers.json");
    write_config(&path, 255);
    let first = ProviderService::new(path.clone());
    let second = ProviderService::new(path.clone());
    first.add_provider(provider(255)).unwrap();
    assert!(second.add_provider(provider(256)).is_err());
    assert_eq!(ProviderService::new(path).list_providers().len(), 256);
}
