//! 微信 4.0 (Windows) 数据库路径发现。
//! 结构: `<root>\<wxid>_<suffix>\db_storage\{message\message_N.db, contact\contact.db}`

use std::path::{Path, PathBuf};

/// 解析分库序号：message_N.db -> Some(N)。
pub fn shard_number(filename: &str) -> Option<u64> {
    let stem = filename.strip_prefix("message_")?.strip_suffix(".db")?;
    if stem.is_empty() || !stem.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    stem.parse().ok()
}

/// 候选数据根目录（xwechat_files 层级），按优先级去重。
pub fn candidate_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = vec![PathBuf::from(r"E:\xwechat_files")];
    #[cfg(windows)]
    for r in registry_roots() {
        roots.push(r.join("xwechat_files"));
        roots.push(r);
    }
    if let Ok(up) = std::env::var("USERPROFILE") {
        if !up.is_empty() {
            roots.push(PathBuf::from(up).join("Documents").join("xwechat_files"));
        }
    }
    // 去重保序
    let mut seen = std::collections::HashSet::new();
    roots
        .into_iter()
        .filter(|r| seen.insert(r.to_string_lossy().to_lowercase()))
        .collect()
}

#[cfg(windows)]
fn registry_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for sub in [r"SOFTWARE\Tencent\Weixin", r"SOFTWARE\Tencent\WeChat"] {
        if let Ok(key) = windows_registry::CURRENT_USER.open(sub) {
            for val in ["FileSavePath", "OldFileSavePath"] {
                if let Ok(v) = key.get_string(val) {
                    if !v.is_empty() && v != "MyDocument:" {
                        roots.push(PathBuf::from(v));
                    }
                }
            }
        }
    }
    roots
}

/// 在候选根下查找含 message\message_0.db 的 db_storage。
pub fn find_db_storage(base_override: Option<&str>) -> Option<PathBuf> {
    let roots: Vec<PathBuf> = match base_override {
        Some(b) => vec![PathBuf::from(b)],
        None => candidate_roots(),
    };
    for root in roots {
        let read = match std::fs::read_dir(&root) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for account in read.flatten() {
            let p = account.path();
            if !p.is_dir() {
                continue;
            }
            let db_storage = p.join("db_storage");
            if db_storage.join("message").join("message_0.db").exists() {
                log::info!("找到 db_storage: {}", db_storage.display());
                return Some(db_storage);
            }
        }
    }
    log::warn!("未找到 db_storage");
    None
}

/// 所有消息分库 message_N.db，按 N 升序。
pub fn find_message_dbs(db_storage: &Path) -> Vec<PathBuf> {
    let msg_dir = db_storage.join("message");
    let mut shards: Vec<(u64, PathBuf)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&msg_dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_file() {
                if let Some(n) = p
                    .file_name()
                    .and_then(|x| x.to_str())
                    .and_then(shard_number)
                {
                    shards.push((n, p));
                }
            }
        }
    }
    shards.sort_by_key(|(n, _)| *n);
    shards.into_iter().map(|(_, p)| p).collect()
}

pub fn find_contact_db(db_storage: &Path) -> Option<PathBuf> {
    let p = db_storage.join("contact").join("contact.db");
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shard_number_parsing() {
        assert_eq!(shard_number("message_0.db"), Some(0));
        assert_eq!(shard_number("message_12.db"), Some(12));
        assert_eq!(shard_number("message.db"), None);
        assert_eq!(shard_number("message_x.db"), None);
        assert_eq!(shard_number("contact.db"), None);
        assert_eq!(shard_number("message_.db"), None);
    }
}
