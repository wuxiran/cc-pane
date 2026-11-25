//! 微信 4.0 明文库读取：解密后的临时库用 rusqlite 只读打开。
//!
//! 表结构：消息表名 = `Msg_<md5(会话username)>`；Name2Id(rowid -> user_name) 给群成员反查；
//! 联系人表列名在不同版本间有差异，用候选名探测。正文多为 zstd 压缩，需解压后才能搜。

use anyhow::{anyhow, Result};
use md5::{Digest, Md5};
use rusqlite::{Connection, OpenFlags};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct Contact {
    pub username: String,
    pub nickname: String,
    pub remark: String,
}

/// 只允许 [A-Za-z_][A-Za-z0-9_]*，拼进 SQL 前必须过这关，杜绝注入。
pub fn validate_identifier(name: &str) -> Result<&str> {
    let mut chars = name.chars();
    let first_ok = matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_');
    let rest_ok = name
        .chars()
        .skip(1)
        .all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !name.is_empty() && first_ok && rest_ok {
        Ok(name)
    } else {
        Err(anyhow!("不安全的标识符: {name:?}"))
    }
}

/// 只读打开明文 SQLite 库。
pub fn connect(plain: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(
        plain,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    Ok(conn)
}

/// 发现消息表：名字形如 `Msg_<hash>`，恰好一个下划线。
pub fn discover_message_tables(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%' ORDER BY name",
    )?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for name in rows.flatten() {
        if name.matches('_').count() == 1 {
            out.push(name);
        }
    }
    Ok(out)
}

/// Name2Id：rowid -> user_name（群成员 real_sender_id 反查）。表缺失时返回空表。
pub fn get_name2id_mapping(conn: &Connection) -> HashMap<i64, String> {
    let mut map = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT rowid, user_name FROM Name2Id") {
        if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        {
            for (rowid, name) in rows.flatten() {
                map.insert(rowid, name);
            }
        }
    }
    map
}

/// 表名 = Msg_<md5(username)>，反查会话 username。返回 table -> wxid。
pub fn build_table_conversation_map(
    usernames: &[String],
    tables: &[String],
) -> HashMap<String, String> {
    let table_set: std::collections::HashSet<&String> = tables.iter().collect();
    let mut map = HashMap::new();
    for username in usernames {
        let table = format!("Msg_{}", md5_hex(username.as_bytes()));
        if table_set.contains(&table) {
            map.insert(table, username.clone());
        }
    }
    map
}

pub fn md5_hex(data: &[u8]) -> String {
    let mut h = Md5::new();
    h.update(data);
    let out = h.finalize();
    let mut s = String::with_capacity(32);
    for b in out {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// 解析消息正文：compress_flag 非零则 zstd 解压，否则按 UTF-8（lossy）。
/// 与 Python 的差异：解压失败时返回原始字节的 lossy UTF-8（Python 返回 repr），
/// 极少触发（flag 有效时基本能解），不影响关键词搜索命中逻辑。
pub fn decode_content(raw: &[u8], compress_flag: i64) -> String {
    if compress_flag != 0 && !raw.is_empty() {
        match zstd_decompress(raw) {
            Ok(bytes) => return String::from_utf8_lossy(&bytes).into_owned(),
            Err(_) => {
                log::debug!("zstd 解压失败，回退 lossy");
                return String::from_utf8_lossy(raw).into_owned();
            }
        }
    }
    String::from_utf8_lossy(raw).into_owned()
}

/// 纯 Rust zstd 解压（ruzstd），避免 C 编译。
pub fn zstd_decompress(data: &[u8]) -> Result<Vec<u8>> {
    let mut dec = ruzstd::StreamingDecoder::new(data).map_err(|e| anyhow!("zstd init: {e}"))?;
    let mut out = Vec::new();
    dec.read_to_end(&mut out)
        .map_err(|e| anyhow!("zstd read: {e}"))?;
    Ok(out)
}

/// 读取联系人表：探测表名与列名，返回 wxid -> Contact。
pub fn read_contacts(conn: &Connection) -> HashMap<String, Contact> {
    let mut contacts = HashMap::new();
    let tables: Vec<String> = match conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .and_then(|mut s| {
            s.query_map([], |r| r.get::<_, String>(0))
                .map(|rows| rows.flatten().collect())
        }) {
        Ok(t) => t,
        Err(_) => return contacts,
    };

    let contact_table = ["Contact", "contact", "rcontact", "Friend"]
        .into_iter()
        .find(|n| tables.iter().any(|t| t == n));
    let contact_table = match contact_table {
        Some(t) => t,
        None => {
            log::warn!("未找到联系人表");
            return contacts;
        }
    };

    let safe_table = match validate_identifier(contact_table) {
        Ok(t) => t,
        Err(_) => return contacts,
    };

    // 列名探测（大小写不敏感映射到真实列名）。
    let cols: Vec<String> = match conn
        .prepare(&format!("PRAGMA table_info([{safe_table}])"))
        .and_then(|mut s| {
            s.query_map([], |r| r.get::<_, String>(1))
                .map(|rows| rows.flatten().collect())
        }) {
        Ok(c) => c,
        Err(_) => return contacts,
    };
    let find_col = |cands: &[&str]| -> Option<String> {
        for cand in cands {
            if let Some(real) = cols.iter().find(|c| c.eq_ignore_ascii_case(cand)) {
                return Some(real.clone());
            }
        }
        None
    };
    let username_col = match find_col(&["username", "userName", "wxid"]) {
        Some(c) => c,
        None => {
            log::warn!("联系人表缺少 username 列");
            return contacts;
        }
    };
    let nickname_col = find_col(&["nickname", "nickName", "nick_name"]);
    let remark_col = find_col(&["remark", "remarkName", "conRemark"]);

    // 列名都来自表自身且过了 validate_identifier，拼接安全。
    let safe_u = match validate_identifier(&username_col) {
        Ok(_) => username_col.clone(),
        Err(_) => return contacts,
    };
    let sel_n = nickname_col
        .as_deref()
        .filter(|c| validate_identifier(c).is_ok())
        .map(|c| format!("[{c}]"))
        .unwrap_or_else(|| "''".to_string());
    let sel_r = remark_col
        .as_deref()
        .filter(|c| validate_identifier(c).is_ok())
        .map(|c| format!("[{c}]"))
        .unwrap_or_else(|| "''".to_string());

    let query = format!("SELECT [{safe_u}], {sel_n}, {sel_r} FROM [{safe_table}]");
    if let Ok(mut stmt) = conn.prepare(&query) {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            ))
        }) {
            for (username, nickname, remark) in rows.flatten() {
                contacts.insert(
                    username.clone(),
                    Contact {
                        username,
                        nickname,
                        remark,
                    },
                );
            }
        }
    }
    contacts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_identifier_rejects_injection() {
        assert!(validate_identifier("Msg_abc123").is_ok());
        assert!(validate_identifier("_x").is_ok());
        assert!(validate_identifier("1abc").is_err());
        assert!(validate_identifier("a b").is_err());
        assert!(validate_identifier("a;drop").is_err());
        assert!(validate_identifier("").is_err());
    }

    #[test]
    fn md5_table_name_matches_known_vector() {
        // md5("hello") = 5d41402abc4b2a76b9719d911017c592
        assert_eq!(md5_hex(b"hello"), "5d41402abc4b2a76b9719d911017c592");
    }

    #[test]
    fn conversation_map_links_table_to_wxid() {
        let wxid = "wxid_test123".to_string();
        let table = format!("Msg_{}", md5_hex(wxid.as_bytes()));
        let map =
            build_table_conversation_map(&[wxid.clone()], &[table.clone(), "Msg_other".into()]);
        assert_eq!(map.get(&table), Some(&wxid));
        assert_eq!(map.len(), 1);
    }

    /// 构造一个 raw-block zstd 帧（单段 + 原始块），验证解压。
    fn raw_zstd(payload: &[u8]) -> Vec<u8> {
        assert!(payload.len() < 256);
        let mut v = vec![0x28, 0xB5, 0x2F, 0xFD];
        v.push(0x20); // 单段，FCS 1 字节
        v.push(payload.len() as u8);
        let bh = ((payload.len() as u32) << 3) | 1; // raw block, last block
        v.push((bh & 0xFF) as u8);
        v.push(((bh >> 8) & 0xFF) as u8);
        v.push(((bh >> 16) & 0xFF) as u8);
        v.extend_from_slice(payload);
        v
    }

    #[test]
    fn decode_content_handles_zstd_and_plain() {
        let text = "你好abc".as_bytes();
        let frame = raw_zstd(text);
        assert_eq!(decode_content(&frame, 1), "你好abc");
        // flag=0 走 UTF-8 直读
        assert_eq!(decode_content(b"plain", 0), "plain");
        // 坏 zstd 不 panic，回退 lossy
        let _ = decode_content(b"\x28\xB5\x2F\xFDbroken", 1);
    }
}
