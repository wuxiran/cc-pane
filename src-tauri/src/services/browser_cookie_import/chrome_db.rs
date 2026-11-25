//! 读取 Chromium `Cookies` SQLite（临时拷贝）并映射为 `cookie::Cookie`。

use super::crypto::{decrypt_cookie_value, KEY_LEN};
use rusqlite::Connection;
use tauri::webview::cookie::{self, time::OffsetDateTime, Cookie, SameSite};

/// 1601-01-01 到 1970-01-01 的秒数。
const CHROME_EPOCH_OFFSET_SECS: i64 = 11_644_473_600;

#[derive(Debug, Clone, Default)]
pub struct RawCookieRow {
    pub host_key: String,
    pub name: String,
    pub value: String,
    pub encrypted_value: Vec<u8>,
    pub path: String,
    pub expires_utc: i64,
    pub has_expires: bool,
    pub is_secure: bool,
    pub is_httponly: bool,
    pub samesite: i64,
    pub top_frame_site_key: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RowOutcome {
    Skipped,
    Failed,
}

pub fn schema_version(conn: &Connection) -> rusqlite::Result<i64> {
    let raw: String = conn.query_row("SELECT value FROM meta WHERE key = 'version'", [], |r| {
        r.get(0)
    })?;
    Ok(raw.trim().parse().unwrap_or(0))
}

fn has_column(conn: &Connection, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare("PRAGMA table_info(cookies)")?;
    let names = stmt.query_map([], |r| r.get::<_, String>(1))?;
    for name in names {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn read_rows(conn: &Connection) -> rusqlite::Result<Vec<RawCookieRow>> {
    // 老版本没有分区列 / has_expires，用常量占位保持同一个查询形状。
    let partition = if has_column(conn, "top_frame_site_key")? {
        "top_frame_site_key"
    } else {
        "''"
    };
    let has_expires = if has_column(conn, "has_expires")? {
        "has_expires"
    } else {
        "1"
    };
    let samesite = if has_column(conn, "samesite")? {
        "samesite"
    } else {
        "-1"
    };
    let sql = format!(
        "SELECT host_key, name, value, encrypted_value, path, expires_utc, {has_expires}, \
         is_secure, is_httponly, {samesite}, {partition} FROM cookies"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| {
        Ok(RawCookieRow {
            host_key: r.get(0)?,
            name: r.get(1)?,
            value: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            encrypted_value: r.get::<_, Option<Vec<u8>>>(3)?.unwrap_or_default(),
            path: r.get(4)?,
            expires_utc: r.get(5)?,
            has_expires: r.get::<_, i64>(6)? != 0,
            is_secure: r.get::<_, i64>(7)? != 0,
            is_httponly: r.get::<_, i64>(8)? != 0,
            samesite: r.get(9)?,
            top_frame_site_key: r.get::<_, Option<String>>(10)?.unwrap_or_default(),
        })
    })?;
    rows.collect()
}

/// Chrome 纪元（1601 起的微秒）→ Unix 秒；0 / 无过期 = 会话 cookie（None）。
pub fn chrome_time_to_unix(expires_utc: i64, has_expires: bool) -> Option<i64> {
    if !has_expires || expires_utc <= 0 {
        return None;
    }
    Some(expires_utc / 1_000_000 - CHROME_EPOCH_OFFSET_SECS)
}

pub fn map_samesite(raw: i64) -> Option<SameSite> {
    match raw {
        0 => Some(SameSite::None),
        1 => Some(SameSite::Lax),
        2 => Some(SameSite::Strict),
        _ => None,
    }
}

/// wry 在 macOS 上用 `NSHTTPCookie cookieWithProperties` 建 cookie，返回 nil 时会在主线程
/// `expect` 崩溃，所以这里先把它肯定不收的形状挡掉。
fn is_safe_token(s: &str, allow_eq: bool) -> bool {
    !s.chars()
        .any(|c| c == ';' || c.is_control() || (!allow_eq && c == '='))
}

/// 把一行 cookie 转成可写入 WKWebView 的 `Cookie`。
pub fn row_to_cookie(
    row: &RawCookieRow,
    key: Option<&[u8; KEY_LEN]>,
    schema_version: i64,
    now_unix: i64,
) -> Result<Cookie<'static>, RowOutcome> {
    if !row.top_frame_site_key.is_empty() {
        return Err(RowOutcome::Skipped); // 分区 cookie（CHIPS）
    }
    let expires = chrome_time_to_unix(row.expires_utc, row.has_expires);
    if matches!(expires, Some(ts) if ts <= now_unix) {
        return Err(RowOutcome::Skipped);
    }
    let host = row.host_key.trim();
    if host.trim_start_matches('.').is_empty() || row.name.is_empty() {
        return Err(RowOutcome::Skipped);
    }

    let value = if row.encrypted_value.is_empty() {
        row.value.clone()
    } else {
        let key = key.ok_or(RowOutcome::Failed)?;
        decrypt_cookie_value(key, &row.encrypted_value, schema_version)
            .map_err(|_| RowOutcome::Failed)?
    };
    if value.is_empty()
        || !is_safe_token(&row.name, false)
        || !is_safe_token(&value, true)
        || !is_safe_token(host, false)
    {
        return Err(RowOutcome::Skipped);
    }

    // `cookie::Cookie::domain()` 会去掉一个前导点，wry 再把结果交给 NSHTTPCookie；
    // 而 NSHTTPCookie 里「没有前导点 = 仅限该主机」。所以 domain cookie（`.example.com`）
    // 要多垫一个点，读出来才是 `.example.com`；host-only cookie 原样传。
    let domain = if host.starts_with('.') {
        format!(".{host}")
    } else {
        host.to_string()
    };
    let path = if row.path.starts_with('/') {
        row.path.clone()
    } else {
        "/".to_string()
    };

    let mut builder = Cookie::build((row.name.clone(), value))
        .domain(domain)
        .path(path)
        .secure(row.is_secure)
        .http_only(row.is_httponly);
    if let Some(same_site) = map_samesite(row.samesite) {
        builder = builder.same_site(same_site);
    }
    if let Some(ts) = expires {
        let dt = OffsetDateTime::from_unix_timestamp(ts).map_err(|_| RowOutcome::Skipped)?;
        builder = builder.expires(cookie::Expiration::DateTime(dt));
    }
    Ok(builder.build())
}

#[cfg(test)]
mod tests {
    use super::super::crypto::{derive_key, encrypt_for_test};
    use super::*;

    const NOW: i64 = 1_800_000_000;

    fn chrome_time(unix: i64) -> i64 {
        (unix + CHROME_EPOCH_OFFSET_SECS) * 1_000_000
    }

    fn row(host: &str) -> RawCookieRow {
        RawCookieRow {
            host_key: host.into(),
            name: "sid".into(),
            value: "plain".into(),
            path: "/".into(),
            expires_utc: chrome_time(NOW + 3600),
            has_expires: true,
            samesite: -1,
            ..Default::default()
        }
    }

    #[test]
    fn browser_epoch_conversion() {
        assert_eq!(chrome_time_to_unix(0, true), None);
        assert_eq!(chrome_time_to_unix(chrome_time(NOW), false), None);
        assert_eq!(chrome_time_to_unix(chrome_time(NOW), true), Some(NOW));
        // 1970-01-01 本身
        assert_eq!(chrome_time_to_unix(11_644_473_600_000_000, true), Some(0));
    }

    #[test]
    fn browser_samesite_mapping() {
        assert_eq!(map_samesite(-1), None);
        assert_eq!(map_samesite(0), Some(SameSite::None));
        assert_eq!(map_samesite(1), Some(SameSite::Lax));
        assert_eq!(map_samesite(2), Some(SameSite::Strict));
    }

    #[test]
    fn browser_skips_expired_and_partitioned() {
        let mut expired = row("example.com");
        expired.expires_utc = chrome_time(NOW - 1);
        assert_eq!(
            row_to_cookie(&expired, None, 24, NOW).unwrap_err(),
            RowOutcome::Skipped
        );
        let mut partitioned = row("example.com");
        partitioned.top_frame_site_key = "https://top.example".into();
        assert_eq!(
            row_to_cookie(&partitioned, None, 24, NOW).unwrap_err(),
            RowOutcome::Skipped
        );
    }

    #[test]
    fn browser_session_cookie_has_no_expiry() {
        let mut session = row("example.com");
        session.expires_utc = 0;
        let c = row_to_cookie(&session, None, 24, NOW).unwrap();
        assert!(c.expires().is_none());
    }

    #[test]
    fn browser_domain_cookie_keeps_leading_dot_through_cookie_crate() {
        let c = row_to_cookie(&row(".example.com"), None, 24, NOW).unwrap();
        assert_eq!(c.domain(), Some(".example.com"));
        let host_only = row_to_cookie(&row("www.example.com"), None, 24, NOW).unwrap();
        assert_eq!(host_only.domain(), Some("www.example.com"));
    }

    #[test]
    fn browser_maps_flags_and_expiry() {
        let mut r = row(".example.com");
        r.is_secure = true;
        r.is_httponly = true;
        r.samesite = 1;
        r.path = String::new();
        let c = row_to_cookie(&r, None, 24, NOW).unwrap();
        assert_eq!(c.secure(), Some(true));
        assert_eq!(c.http_only(), Some(true));
        assert_eq!(c.same_site(), Some(SameSite::Lax));
        assert_eq!(c.path(), Some("/"));
        assert_eq!(
            c.expires_datetime().map(|d| d.unix_timestamp()),
            Some(NOW + 3600)
        );
    }

    #[test]
    fn browser_decrypts_encrypted_rows() {
        let key = derive_key(b"pw");
        let mut r = row(".example.com");
        r.value.clear();
        r.encrypted_value = encrypt_for_test(&key, ".example.com", "secret", 24);
        let c = row_to_cookie(&r, Some(&key), 24, NOW).unwrap();
        assert_eq!(c.value(), "secret");
        // 没有 key / key 错 → Failed
        assert_eq!(
            row_to_cookie(&r, None, 24, NOW).unwrap_err(),
            RowOutcome::Failed
        );
        let wrong = derive_key(b"nope");
        assert_eq!(
            row_to_cookie(&r, Some(&wrong), 24, NOW).unwrap_err(),
            RowOutcome::Failed
        );
    }

    #[test]
    fn browser_rejects_shapes_nshttpcookie_would_refuse() {
        let mut r = row("example.com");
        r.value = "a;b".into();
        assert_eq!(
            row_to_cookie(&r, None, 24, NOW).unwrap_err(),
            RowOutcome::Skipped
        );
        let mut r = row("example.com");
        r.name.clear();
        assert_eq!(
            row_to_cookie(&r, None, 24, NOW).unwrap_err(),
            RowOutcome::Skipped
        );
        assert_eq!(
            row_to_cookie(&row("."), None, 24, NOW).unwrap_err(),
            RowOutcome::Skipped
        );
    }

    #[test]
    fn browser_reads_rows_from_sqlite() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO meta VALUES('version','24');
             CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB,
               path TEXT, expires_utc INTEGER, has_expires INTEGER, is_secure INTEGER,
               is_httponly INTEGER, samesite INTEGER, top_frame_site_key TEXT);
             INSERT INTO cookies VALUES('.a.com','n','v',X'','/',0,0,1,0,2,'');",
        )
        .unwrap();
        assert_eq!(schema_version(&conn).unwrap(), 24);
        let rows = read_rows(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].samesite, 2);
        assert!(rows[0].is_secure);
    }
}
