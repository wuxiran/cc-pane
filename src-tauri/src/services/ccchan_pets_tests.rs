use super::*;

fn pet_meta(id: &str, name: &str) -> PetMeta {
    PetMeta {
        id: id.to_string(),
        display_name: name.to_string(),
        description: String::new(),
        spritesheet_url: String::new(),
        atlas: codex_standard_atlas(),
        animations: HashMap::new(),
        pixel_art: false,
        source: "builtin",
    }
}

fn write_pet(dir: &Path, sprite_name: &str, pet_json: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("pet.json"), pet_json).unwrap();
    if !sprite_name.is_empty() {
        std::fs::write(dir.join(sprite_name), b"fake-png").unwrap();
    }
}

fn valid_pet_json(sprite_path: &str) -> String {
    format!(
        r#"{{"id":"my-pet","displayName":"Mine","description":"d","spritesheetPath":"{sprite_path}","atlas":{{"cellW":192,"cellH":208,"cols":8,"rows":9}},"animations":{{"idle":{{"row":0,"frames":4,"fps":8}}}}}}"#
    )
}

#[test]
fn merge_pets_overrides_by_id_and_appends_new() {
    let built_in = vec![pet_meta("homie", "Homie"), pet_meta("doro", "Doro")];
    let user = vec![
        pet_meta("homie", "Custom Homie"),
        pet_meta("my-pet", "Mine"),
    ];
    let merged = merge_pets(built_in, user);
    assert_eq!(merged.len(), 3);
    assert_eq!(merged[0].display_name, "Custom Homie");
    assert_eq!(merged[1].id, "doro");
    assert_eq!(merged[2].id, "my-pet");
}

#[test]
fn codex_four_field_pet_json_gets_standard_layout() {
    let definition = parse_pet_definition(
        r#"{"id":"codex-cat","displayName":"Cat","description":"meow","spritesheetPath":"spritesheet.webp"}"#,
    )
    .expect("codex 4-field format must parse");
    assert_eq!(definition.atlas.cols, 8);
    assert_eq!(definition.atlas.rows, 9);
    assert_eq!(definition.atlas.cell_w, 192);
    assert_eq!(definition.atlas.cell_h, 208);
    assert_eq!(definition.animations["idle"].row, 0);
    assert_eq!(definition.animations["running"].row, 7);
    assert_eq!(definition.animations["needsInput"].row, 6);
    assert_eq!(definition.animations["ready"].row, 3);
    assert_eq!(definition.animations["blocked"].row, 5);
    assert_eq!(definition.animations["blocked"].frames, 8);
}

#[test]
fn codex_pet_dir_loads_with_missing_display_name() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().join("cat");
    write_pet(
        &dir,
        "spritesheet.webp",
        r#"{"id":"cat","spritesheetPath":"spritesheet.webp"}"#,
    );
    let pet = load_pet_dir(&dir, "codex").unwrap();
    assert_eq!(pet.display_name, "cat");
    assert_eq!(pet.source, "codex");
    assert!(pet.animations.contains_key("running"));
}

#[test]
fn scan_pet_root_skips_invalid_and_missing() {
    let temp = tempfile::tempdir().unwrap();
    write_pet(
        &temp.path().join("a"),
        "spritesheet.png",
        &valid_pet_json("spritesheet.png"),
    );
    write_pet(&temp.path().join("b"), "", "{not json");
    std::fs::create_dir_all(temp.path().join("empty")).unwrap();
    let pets = scan_pet_root(temp.path(), "user");
    assert_eq!(pets.len(), 1);
    assert!(scan_pet_root(&temp.path().join("nope"), "user").is_empty());
}

#[test]
fn rejects_path_escape_absolute_paths_and_bad_extension() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().join("evil");
    write_pet(&dir, "", &valid_pet_json("../escape.png"));
    assert!(load_pet_dir(&dir, "user").is_err());
    let abs = if cfg!(windows) {
        "C:/Windows/x.png"
    } else {
        "/etc/x.png"
    };
    std::fs::write(dir.join("pet.json"), valid_pet_json(abs)).unwrap();
    assert!(load_pet_dir(&dir, "user").is_err());
    let dir2 = temp.path().join("exe");
    write_pet(&dir2, "payload.exe", &valid_pet_json("payload.exe"));
    assert!(load_pet_dir(&dir2, "user").is_err());
}

#[test]
fn rejects_invalid_atlas_and_animations() {
    let bad_atlas = valid_pet_json("s.png").replace(r#""rows":9"#, r#""rows":0"#);
    assert!(parse_pet_definition(&bad_atlas).is_err());
    let bad_fps = valid_pet_json("s.png").replace(r#""fps":8"#, r#""fps":600"#);
    assert!(parse_pet_definition(&bad_fps).is_err());
    for (offset, frames) in [(0, 9), (7, 2), (u32::MAX, 1)] {
        let mut definition = parse_pet_definition(&valid_pet_json("s.png")).unwrap();
        let animation = definition.animations.get_mut("idle").unwrap();
        animation.col_offset = offset;
        animation.frames = frames;
        assert!(validate_pet_definition(&definition).is_err());
    }
}

#[test]
fn bundled_pets_load_and_follow_codex_standard_rows() {
    const ROW_FRAMES: [u32; 9] = [6, 8, 8, 4, 5, 8, 6, 6, 6];
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/ccchan");
    let pets = load_bundled_pets(&root).unwrap();
    let manifest: PetsManifest =
        serde_json::from_str(&std::fs::read_to_string(root.join("pets-manifest.json")).unwrap())
            .unwrap();
    assert_eq!(pets.len(), manifest.pets.len());
    for pet in pets {
        assert!(!pet.pixel_art, "{}: bundled pets are illustrations", pet.id);
        for (state, animation) in &pet.animations {
            let max = ROW_FRAMES[animation.row as usize];
            assert!(animation.frames <= max, "{}.{state}", pet.id);
        }
    }
}
