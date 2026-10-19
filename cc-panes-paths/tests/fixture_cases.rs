//! 跑 `tests/fixtures/wsl_path_cases.json`：同一份用例表也被 web/utils/wslPath.test.ts 使用。

use cc_panes_paths::{comparison_path, identity_key, parse_wsl_unc, to_wsl_posix, wsl_compare_key};
use serde_json::Value;

fn cases() -> (String, Vec<Value>) {
    let raw = include_str!("fixtures/wsl_path_cases.json");
    let fixture: Value = serde_json::from_str(raw).expect("fixture must be valid JSON");
    let mount_root = fixture["mountRoot"].as_str().unwrap().to_string();
    let cases = fixture["cases"].as_array().unwrap().clone();
    assert!(!cases.is_empty());
    (mount_root, cases)
}

fn opt_str(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

#[test]
fn every_entry_matches_the_shared_fixture() {
    let (mount_root, cases) = cases();
    let mut failures = Vec::new();
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let input = case["input"].as_str().unwrap();

        let checks: [(&str, Option<String>, Option<String>); 5] = [
            (
                "identityKey",
                Some(identity_key(input)),
                opt_str(&case["identityKey"]),
            ),
            (
                "comparisonPath",
                Some(comparison_path(input)),
                opt_str(&case["comparisonPath"]),
            ),
            (
                "wslCompareKey",
                Some(wsl_compare_key(input)),
                opt_str(&case["wslCompareKey"]),
            ),
            (
                "toWslPosix",
                to_wsl_posix(input, &mount_root),
                opt_str(&case["toWslPosix"]),
            ),
            (
                "parseWslUnc",
                parse_wsl_unc(input).map(|(distro, posix)| format!("{distro}|{posix}")),
                case["parseWslUnc"].as_object().map(|object| {
                    format!(
                        "{}|{}",
                        object["distro"].as_str().unwrap(),
                        object["posix"].as_str().unwrap()
                    )
                }),
            ),
        ];
        for (entry, actual, expected) in checks {
            if actual != expected {
                failures.push(format!(
                    "[{name}] {entry}({input:?}): expected {expected:?}, got {actual:?}"
                ));
            }
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn keys_are_idempotent_on_fixture_inputs() {
    let (_, cases) = cases();
    for case in &cases {
        let input = case["input"].as_str().unwrap();
        let identity = identity_key(input);
        assert_eq!(identity_key(&identity), identity, "identity_key({input:?})");
        let wsl = wsl_compare_key(input);
        assert_eq!(wsl_compare_key(&wsl), wsl, "wsl_compare_key({input:?})");
    }
}
