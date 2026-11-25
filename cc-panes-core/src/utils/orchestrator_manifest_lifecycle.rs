//! Serialize manifest publication/retirement across application instances.
//! A retired manifest retains the token: existing CLI MCP clients keep that token.
use std::fs::{File, OpenOptions};
use std::path::Path;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde_json::Value;

use super::{atomic_file, orchestrator_manifest::ORCHESTRATOR_MANIFEST_FILE};

fn acquire_lock(data_dir: &Path) -> Result<File> {
    std::fs::create_dir_all(data_dir)?;
    let path = data_dir.join("mcp-orchestrator.lock");
    for _ in 0..20 {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0);
        }
        if let Ok(file) = options.open(&path) {
            #[cfg(unix)]
            {
                use std::os::fd::AsRawFd;
                // SAFETY: file owns this valid descriptor for the duration of the lock.
                if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                    return Ok(file);
                }
            }
            #[cfg(not(unix))]
            return Ok(file);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    bail!("orchestrator manifest lock unavailable")
}

pub fn publish(data_dir: &Path, mut manifest: Value) -> Result<()> {
    let _lock = acquire_lock(data_dir)?;
    manifest["lifecycle"] = Value::String("ready".into());
    atomic_file::write_atomic(
        &data_dir.join(ORCHESTRATOR_MANIFEST_FILE),
        serde_json::to_vec_pretty(&manifest)?,
    )
}

pub fn retire(data_dir: &Path, pid: u32, started_at: u64) -> Result<bool> {
    let _lock = acquire_lock(data_dir)?;
    let path = data_dir.join(ORCHESTRATOR_MANIFEST_FILE);
    let content = match std::fs::read(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let mut manifest: Value =
        serde_json::from_slice(&content).context("invalid orchestrator manifest")?;
    if manifest["pid"].as_u64() != Some(u64::from(pid))
        || manifest["startedAt"].as_u64() != Some(started_at)
    {
        return Ok(false);
    }
    manifest["lifecycle"] = Value::String("stopped".into());
    atomic_file::write_atomic(&path, serde_json::to_vec_pretty(&manifest)?)?;
    Ok(true)
}

/// 更换 manifest 里的 orchestrator 令牌（URL 的 `?token=` 与 `Authorization` 头），其余字段
/// 与 lifecycle 原样保留。manifest 不存在时不创建（下次启动 publish 会写入内存中的新令牌），
/// 返回是否改写了文件。
pub fn rotate_token(data_dir: &Path, new_token: &str) -> Result<bool> {
    let _lock = acquire_lock(data_dir)?;
    let path = data_dir.join(ORCHESTRATOR_MANIFEST_FILE);
    let content = match std::fs::read(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let mut manifest: Value =
        serde_json::from_slice(&content).context("invalid orchestrator manifest")?;
    let Some(server) = manifest.pointer_mut("/mcpServers/ccpanes") else {
        bail!("orchestrator manifest has no mcpServers.ccpanes entry");
    };
    if let Some(url) = server.get("url").and_then(Value::as_str) {
        let mut parsed = url::Url::parse(url).context("invalid orchestrator MCP url")?;
        let pairs: Vec<(String, String)> = parsed
            .query_pairs()
            .map(|(key, value)| {
                let value = if key == "token" {
                    new_token.to_string()
                } else {
                    value.into_owned()
                };
                (key.into_owned(), value)
            })
            .collect();
        parsed.query_pairs_mut().clear().extend_pairs(pairs);
        server["url"] = Value::String(parsed.to_string());
    }
    server["headers"]["Authorization"] = Value::String(format!("Bearer {new_token}"));
    atomic_file::write_atomic(&path, serde_json::to_vec_pretty(&manifest)?)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::orchestrator_manifest::{read_active_endpoint, read_endpoint};

    fn manifest(pid: u32, started_at: u64) -> Value {
        serde_json::json!({"pid":pid,"startedAt":started_at,"mcpServers":{"ccpanes":{
            "url":"http://127.0.0.1:47821/mcp", "headers":{"Authorization":"Bearer test-token"}}}})
    }

    #[test]
    fn retirement_keeps_credentials_but_disables_discovery_until_republished() {
        let dir = tempfile::tempdir().unwrap();
        publish(dir.path(), manifest(1, 10)).unwrap();
        assert!(read_active_endpoint(dir.path()).is_some());
        assert!(retire(dir.path(), 1, 10).unwrap());
        assert!(read_active_endpoint(dir.path()).is_none());
        assert_eq!(read_endpoint(dir.path()).unwrap().1, "test-token");
        publish(dir.path(), manifest(2, 20)).unwrap();
        assert!(read_active_endpoint(dir.path()).is_some());
    }

    #[test]
    fn an_old_process_cannot_retire_a_new_instance_or_reused_pid() {
        let dir = tempfile::tempdir().unwrap();
        publish(dir.path(), manifest(2, 20)).unwrap();
        assert!(!retire(dir.path(), 1, 10).unwrap());
        assert!(!retire(dir.path(), 2, 10).unwrap());
        assert!(read_active_endpoint(dir.path()).is_some());
    }

    #[test]
    fn rotate_token_rewrites_url_and_header_and_keeps_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let mut value = manifest(1, 10);
        value["mcpServers"]["ccpanes"]["url"] =
            Value::String("http://127.0.0.1:47821/mcp?token=test-token".into());
        publish(dir.path(), value).unwrap();
        assert!(retire(dir.path(), 1, 10).unwrap());
        assert!(rotate_token(dir.path(), "new-token").unwrap());
        assert_eq!(
            read_endpoint(dir.path()).unwrap(),
            (47821, "new-token".into())
        );
        // 已停止的 manifest 仍是停止态：改令牌不等于重新发布
        assert!(read_active_endpoint(dir.path()).is_none());
        let raw = std::fs::read_to_string(dir.path().join(ORCHESTRATOR_MANIFEST_FILE)).unwrap();
        assert!(raw.contains("token=new-token") && !raw.contains("test-token"));
        assert_eq!(
            serde_json::from_str::<Value>(&raw).unwrap()["pid"].as_u64(),
            Some(1)
        );
    }

    #[test]
    fn rotate_token_without_manifest_is_a_noop() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!rotate_token(dir.path(), "x").unwrap());
        assert!(!dir.path().join(ORCHESTRATOR_MANIFEST_FILE).exists());
    }

    #[test]
    fn missing_manifest_is_not_created_by_retirement() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!retire(dir.path(), 1, 10).unwrap());
        assert!(!dir.path().join(ORCHESTRATOR_MANIFEST_FILE).exists());
    }
}
