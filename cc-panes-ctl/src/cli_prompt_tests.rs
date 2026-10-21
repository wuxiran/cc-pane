use super::{Cli, Command};
use clap::Parser;

fn prompt_args(name: &str) -> Vec<String> {
    let examples: serde_json::Value =
        serde_json::from_str(include_str!("../../web/services/selfChatCtlCommands.json")).unwrap();
    let mut args = vec!["cc-panes-ctl".to_owned()];
    args.extend(examples[name].as_array().unwrap().iter().map(|value| {
        match value.as_str().unwrap() {
            "<tool>" => "scan_directory",
            "<args>" => r#"{"path":"/path with spaces/projects"}"#,
            value => value,
        }
        .to_owned()
    }));
    args
}

#[test]
fn self_chat_schema_example_parses_as_the_requested_schema() {
    let parsed = Cli::try_parse_from(prompt_args("schema")).unwrap();
    assert!(parsed.json, "the global output flag must precede tools");
    match parsed.command {
        Command::Tools { schema } => assert_eq!(schema.as_deref(), Some("scan_directory")),
        _ => panic!("SelfChat must request a schema, not run a business operation"),
    }
}

#[test]
fn self_chat_call_example_preserves_json_output_and_argument_payload() {
    let parsed = Cli::try_parse_from(prompt_args("call")).unwrap();
    assert!(parsed.json);
    match parsed.command {
        Command::Call {
            tool,
            arguments_json,
            arg,
        } => {
            assert_eq!(tool, "scan_directory");
            assert!(arg.is_empty());
            let value: serde_json::Value = serde_json::from_str(&arguments_json.unwrap()).unwrap();
            assert_eq!(value["path"], "/path with spaces/projects");
        }
        _ => panic!("expected call"),
    }
}
