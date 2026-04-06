use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use tracing::info;

pub(super) fn codex_prompt_stem(session_id: &str) -> String {
    format!("codex-{}", session_id)
}

pub(super) fn codex_prompt_relative_path(stem: &str) -> String {
    format!(".ccpanes/prompts/{}.md", stem)
}

pub(super) fn codex_prompt_reference(stem: &str) -> String {
    format!(
        "Read task from '{}' and execute it.",
        codex_prompt_relative_path(stem)
    )
}

pub(super) fn write_codex_prompt_file(
    launch_root: &Path,
    stem: &str,
    prompt: &str,
) -> Result<PathBuf> {
    let prompt_dir = launch_root.join(".ccpanes").join("prompts");
    std::fs::create_dir_all(&prompt_dir).with_context(|| {
        format!(
            "Failed to create Codex prompt directory: {}",
            prompt_dir.display()
        )
    })?;

    let prompt_path = prompt_dir.join(format!("{}.md", stem));
    std::fs::write(&prompt_path, prompt).with_context(|| {
        format!(
            "Failed to write Codex prompt markdown file: {}",
            prompt_path.display()
        )
    })?;

    Ok(prompt_path)
}

pub(super) fn prepare_local_codex_prompt(
    launch_root: &Path,
    session_id: &str,
    prompt: Option<&str>,
) -> Result<Option<String>> {
    let Some(prompt) = prompt else {
        return Ok(None);
    };

    let stem = codex_prompt_stem(session_id);
    let prompt_path = write_codex_prompt_file(launch_root, &stem, prompt)?;
    info!(
        session_id = %session_id,
        path = %prompt_path.display(),
        "Codex prompt written to markdown file"
    );
    Ok(Some(codex_prompt_reference(&stem)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_prompt_reference_uses_relative_workspace_path() {
        let reference = codex_prompt_reference("codex-session-1");
        assert_eq!(
            reference,
            "Read task from '.ccpanes/prompts/codex-session-1.md' and execute it."
        );
    }

    #[test]
    fn prepare_local_codex_prompt_writes_markdown_file() {
        let temp_dir = tempfile::tempdir().unwrap();
        let runtime_prompt = prepare_local_codex_prompt(
            temp_dir.path(),
            "session-123",
            Some("fix the failing tests"),
        )
        .unwrap();

        assert_eq!(
            runtime_prompt.as_deref(),
            Some("Read task from '.ccpanes/prompts/codex-session-123.md' and execute it.")
        );

        let prompt_path = temp_dir
            .path()
            .join(".ccpanes")
            .join("prompts")
            .join("codex-session-123.md");
        assert_eq!(
            std::fs::read_to_string(prompt_path).unwrap(),
            "fix the failing tests"
        );
    }
}
