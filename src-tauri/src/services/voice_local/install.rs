// 本地转写组件的下载安装：一次只跑一个安装任务，进度存在进程内，前端轮询 status 读取。
// 下载写 `.part` 文件并支持断点续传（Range），完成后整包 SHA256 校验，
// 解压到临时目录再整体改名到位——目录存在即「已安装」，不会出现半截状态。
use super::catalog::{engine_archive, Archive, LocalModel};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub model_id: String,
    /// engine / model / extract / done / error / cancelled
    pub stage: &'static str,
    pub received: u64,
    pub total: u64,
    pub error: Option<String>,
}

impl InstallProgress {
    pub fn active(&self) -> bool {
        matches!(self.stage, "engine" | "model" | "extract")
    }
}

struct InstallJob {
    progress: InstallProgress,
    cancel: Arc<AtomicBool>,
}

static JOB: Mutex<Option<InstallJob>> = Mutex::new(None);

fn with_job<R>(f: impl FnOnce(&mut Option<InstallJob>) -> R) -> R {
    let mut guard = JOB.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut guard)
}

pub fn current_progress() -> Option<InstallProgress> {
    with_job(|job| job.as_ref().map(|job| job.progress.clone()))
}

fn update(f: impl FnOnce(&mut InstallProgress)) {
    with_job(|job| {
        if let Some(job) = job.as_mut() {
            f(&mut job.progress);
        }
    });
}

pub fn cancel() {
    with_job(|job| {
        if let Some(job) = job.as_ref() {
            job.cancel.store(true, Ordering::SeqCst);
        }
    });
}

pub fn engine_dir(root: &Path) -> Option<PathBuf> {
    engine_archive().map(|archive| root.join("engine").join(archive.name))
}

pub fn model_dir(root: &Path, model: &LocalModel) -> PathBuf {
    root.join("models").join(model.archive.name)
}

/// 开始安装（缺引擎先装引擎，再装模型）。已有任务在跑时报错。
pub fn start(
    root: PathBuf,
    model: &'static LocalModel,
    client: reqwest::Client,
) -> Result<(), String> {
    let engine = engine_archive().ok_or("Local transcription is not available on this platform")?;
    let cancel = Arc::new(AtomicBool::new(false));
    with_job(|job| {
        if job.as_ref().is_some_and(|job| job.progress.active()) {
            return Err("Another download is already running".to_string());
        }
        *job = Some(InstallJob {
            progress: InstallProgress {
                model_id: model.id.to_string(),
                stage: "engine",
                received: 0,
                total: 0,
                error: None,
            },
            cancel: cancel.clone(),
        });
        Ok(())
    })?;

    tauri::async_runtime::spawn(async move {
        let result = run(&root, engine, model, &client, &cancel).await;
        update(|progress| match result {
            Ok(()) => progress.stage = "done",
            Err(_) if cancel.load(Ordering::SeqCst) => progress.stage = "cancelled",
            Err(error) => {
                tracing::warn!(model = model.id, %error, "local voice install failed");
                progress.stage = "error";
                progress.error = Some(error);
            }
        });
    });
    Ok(())
}

async fn run(
    root: &Path,
    engine: Archive,
    model: &LocalModel,
    client: &reqwest::Client,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let engine_target = root.join("engine").join(engine.name);
    if !engine_target.exists() {
        install_archive(root, &engine, &engine_target, "engine", client, cancel).await?;
    }
    let model_target = model_dir(root, model);
    if !model_target.exists() {
        install_archive(root, &model.archive, &model_target, "model", client, cancel).await?;
    }
    Ok(())
}

async fn install_archive(
    root: &Path,
    archive: &Archive,
    target: &Path,
    stage: &'static str,
    client: &reqwest::Client,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let downloads = root.join("downloads");
    tokio::fs::create_dir_all(&downloads)
        .await
        .map_err(|e| e.to_string())?;
    let part = downloads.join(format!("{}.tar.bz2.part", archive.name));
    update(|progress| {
        progress.stage = stage;
        progress.received = 0;
        progress.total = archive.size;
    });
    download(archive, &part, client, cancel).await?;

    update(|progress| progress.stage = "extract");
    let staging = root.join(format!(".staging-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&staging)
        .await
        .map_err(|e| e.to_string())?;
    let extracted = extract(&part, &staging).await.and_then(|()| {
        let top = staging.join(archive.name);
        if top.is_dir() {
            Ok(top)
        } else {
            Err(format!("{} did not contain {}", archive.name, archive.name))
        }
    });
    let result = match extracted {
        Ok(top) => {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::rename(&top, target).map_err(|e| e.to_string())
        }
        Err(error) => Err(error),
    };
    let _ = std::fs::remove_dir_all(&staging);
    if result.is_ok() {
        let _ = std::fs::remove_file(&part);
    }
    result
}

async fn download(
    archive: &Archive,
    part: &Path,
    client: &reqwest::Client,
    cancel: &AtomicBool,
) -> Result<(), String> {
    // 续传：先把已下载部分喂进哈希，再从断点请求
    let mut hasher = Sha256::new();
    let mut offset = match std::fs::read(part) {
        Ok(bytes) if (bytes.len() as u64) < archive.size => {
            hasher.update(&bytes);
            bytes.len() as u64
        }
        _ => 0,
    };
    let mut request = client.get(archive.url());
    if offset > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
    }
    let mut response = request
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|e| format!("Download failed: {e}"))?;
    if offset > 0 && response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        // 服务端不认 Range：从头来
        offset = 0;
        hasher = Sha256::new();
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(offset > 0)
        .truncate(offset == 0)
        .open(part)
        .await
        .map_err(|e| e.to_string())?;
    let mut received = offset;
    update(|progress| progress.received = received);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Download failed: {e}"))?
    {
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".to_string());
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        update(|progress| progress.received = received);
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    let digest: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if received != archive.size || digest != archive.sha256 {
        let _ = std::fs::remove_file(part);
        return Err(format!(
            "Checksum mismatch for {} (got {received} bytes); the file was discarded, please retry",
            archive.name
        ));
    }
    Ok(())
}

/// 解压交给系统 tar（macOS / Windows 10+ 的 bsdtar、Linux 的 GNU tar 都认 bz2）。
async fn extract(archive: &Path, target: &Path) -> Result<(), String> {
    let mut command = tokio::process::Command::new("tar");
    command.arg("-xjf").arg(archive).arg("-C").arg(target);
    super::hide_console_window(&mut command);
    let output = tokio::time::timeout(Duration::from_secs(600), command.output())
        .await
        .map_err(|_| "Extracting timed out".to_string())?
        .map_err(|e| format!("Failed to run tar: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Failed to extract: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[cfg(test)]
pub(super) fn reset_for_test() {
    with_job(|job| *job = None);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_stages_report_activity() {
        let mut progress = InstallProgress {
            model_id: "sense-voice".into(),
            stage: "model",
            received: 1,
            total: 2,
            error: None,
        };
        assert!(progress.active());
        progress.stage = "done";
        assert!(!progress.active());
        progress.stage = "error";
        assert!(!progress.active());
    }

    #[test]
    fn cancel_without_job_is_noop() {
        reset_for_test();
        cancel();
        assert!(current_progress().is_none());
    }
}
