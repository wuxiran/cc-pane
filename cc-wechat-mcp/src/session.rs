//! 整条链路的有状态封装：定位进程 → 缓存密钥 → 带 TTL/mtime 失效的明文库 → 元数据。
//! 对应 Python 的 WeChatSession。工具层把整个 session 包在一个 Mutex 里串行调用。

use anyhow::{bail, Result};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, UNIX_EPOCH};

use crate::db_reader::{self, Contact};
#[cfg(windows)]
use crate::paths;
use crate::{image, key_extractor, sqlcipher};

/// 低 32 位 == 3 表示图片消息。
const IMAGE_TYPE: i64 = 3;

type FileSig = ((u128, u64), (u128, u64)); // (enc 文件签名, -wal 文件签名)

struct Plain {
    path: PathBuf,
    decrypted_at: Instant,
    src_sig: FileSig,
}

struct Shard {
    enc: String,
    tables: HashSet<String>,
    name2id: HashMap<i64, String>,
}

/// fetch_rows 的单行原始数据，shard_idx 指向 session.shards。
pub struct RawRow {
    pub ts: i64,
    pub mtype: i64,
    pub sender_id: i64,
    pub raw: Vec<u8>,
    pub cflag: i64,
    pub shard_idx: usize,
    pub packed: Vec<u8>,
}

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// fetch_rows 查询出的一行原始列值。
type RowTuple = (i64, i64, i64, Vec<u8>, i64, i64, Vec<u8>);

pub struct WeChatSession {
    pub db_base: Option<String>,
    pub pid_override: Option<u32>,
    pub ttl: f64,

    pub pid: Option<u32>,
    pub msg_db: Option<String>,
    pub msg_dbs: Vec<String>,
    pub account_dir: Option<String>,
    pub contact_db: Option<String>,
    pub keys: HashMap<String, String>,
    pub meta_loaded: bool,

    img_keys: Option<([u8; 16], u8)>,
    plain: HashMap<String, Plain>,
    shards: Vec<Shard>,
    sender_names: HashSet<String>,
    conv_map: HashMap<String, String>,
    wxid_to_table: HashMap<String, String>,
    contacts: HashMap<String, Contact>,
    meta_at: Option<Instant>,
    temp_root: PathBuf,
}

fn file_sig(p: &Path) -> (u128, u64) {
    match std::fs::metadata(p) {
        Ok(m) => {
            let mt = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            (mt, m.len())
        }
        Err(_) => (0, 0),
    }
}

impl Default for WeChatSession {
    fn default() -> Self {
        Self::new()
    }
}

impl WeChatSession {
    pub fn new() -> Self {
        let db_base = std::env::var("WECHAT_DB_BASE")
            .ok()
            .filter(|s| !s.is_empty());
        let pid_override = std::env::var("WECHAT_PID")
            .ok()
            .and_then(|s| s.parse().ok());
        let ttl = std::env::var("WECHAT_PLAINTEXT_TTL")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(30.0);
        let temp_root = init_temp_root();
        WeChatSession {
            db_base,
            pid_override,
            ttl,
            pid: None,
            msg_db: None,
            msg_dbs: Vec::new(),
            account_dir: None,
            contact_db: None,
            keys: HashMap::new(),
            meta_loaded: false,
            img_keys: None,
            plain: HashMap::new(),
            shards: Vec::new(),
            sender_names: HashSet::new(),
            conv_map: HashMap::new(),
            wxid_to_table: HashMap::new(),
            contacts: HashMap::new(),
            meta_at: None,
            temp_root,
        }
    }

    // ---------- 定位 ----------
    pub fn locate(&mut self) -> Result<(u32, String, Option<String>)> {
        if let (Some(pid), Some(msg)) = (self.pid, self.msg_db.clone()) {
            return Ok((pid, msg, self.contact_db.clone()));
        }
        #[cfg(not(windows))]
        {
            bail!(crate::NOT_WINDOWS_MSG);
        }
        #[cfg(windows)]
        {
            let pid = self
                .pid_override
                .or_else(crate::mem::find_weixin_pid)
                .ok_or_else(|| {
                    anyhow::anyhow!("未找到 Weixin.exe 进程，请确认微信 4.x 已登录运行。")
                })?;
            let db_storage = paths::find_db_storage(self.db_base.as_deref()).ok_or_else(|| {
                anyhow::anyhow!(
                    "未找到 db_storage。请设置环境变量 WECHAT_DB_BASE，如 E:/xwechat_files"
                )
            })?;
            let msg_dbs = paths::find_message_dbs(&db_storage);
            if msg_dbs.is_empty() {
                bail!("db_storage 下缺少 message/message_N.db");
            }
            let contact_db = paths::find_contact_db(&db_storage);

            self.pid = Some(pid);
            self.msg_db = Some(msg_dbs[0].to_string_lossy().into_owned());
            self.msg_dbs = msg_dbs
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            self.contact_db = contact_db.map(|p| p.to_string_lossy().into_owned());
            self.account_dir = db_storage
                .parent()
                .map(|p| p.to_string_lossy().into_owned());
            log::info!(
                "定位完成 pid={} msg={} 个分库 contact={}",
                pid,
                self.msg_dbs.len(),
                self.contact_db.is_some()
            );
            Ok((pid, self.msg_db.clone().unwrap(), self.contact_db.clone()))
        }
    }

    // ---------- 密钥 ----------
    pub fn ensure_keys(&mut self) -> Result<()> {
        let (pid, msg_db, contact_db) = self.locate()?;
        let mut need: Vec<String> = self
            .msg_dbs
            .iter()
            .filter(|p| !self.keys.contains_key(*p))
            .cloned()
            .collect();
        if let Some(c) = &contact_db {
            if !self.keys.contains_key(c) {
                need.push(c.clone());
            }
        }
        if need.is_empty() {
            return Ok(());
        }
        log::info!("提取密钥（{} 个库）…", need.len());
        let keys = key_extractor::extract_all_keys(pid, &need, None)?;
        if keys.is_empty() {
            bail!(
                "密钥提取失败。请确认：以管理员 PowerShell 启动 / 微信已登录 / Weixin.dll 版本匹配。"
            );
        }
        self.keys.extend(keys);
        if !self.keys.contains_key(&msg_db) {
            bail!("消息库密钥提取失败。");
        }
        Ok(())
    }

    // ---------- 明文库（TTL + mtime 失效） ----------
    fn plain_db(&mut self, enc_path: &str, force: bool) -> Result<PathBuf> {
        self.ensure_keys()?;
        let key = self
            .keys
            .get(enc_path)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("该库无可用密钥"))?;

        let enc = PathBuf::from(enc_path);
        let wal = {
            let mut s = enc.clone().into_os_string();
            s.push("-wal");
            PathBuf::from(s)
        };
        let src_sig: FileSig = (file_sig(&enc), file_sig(&wal));

        if !force {
            if let Some(cur) = self.plain.get(enc_path) {
                let fresh =
                    cur.src_sig == src_sig || cur.decrypted_at.elapsed().as_secs_f64() < self.ttl;
                if cur.path.exists() && fresh {
                    return Ok(cur.path.clone());
                }
            }
        }

        // 解密到新临时文件，再替换旧的。
        let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let tmp = self.temp_root.join(format!("wxmcp_{n}.db"));
        sqlcipher::decrypt_db_file(&enc, &key, &tmp)?;
        if let Some(old) = self.plain.insert(
            enc_path.to_string(),
            Plain {
                path: tmp.clone(),
                decrypted_at: Instant::now(),
                src_sig,
            },
        ) {
            let _ = std::fs::remove_file(&old.path);
        }
        log::info!(
            "已解密分库（{} 个 WAL 合并视情况）",
            self.shards.len().max(1)
        );
        Ok(tmp)
    }

    /// [(shard 索引, 明文库路径)]，按分库号升序。需先 ensure_meta。
    pub fn plain_shards(&mut self, force: bool) -> Vec<(usize, PathBuf)> {
        let encs: Vec<String> = self.shards.iter().map(|s| s.enc.clone()).collect();
        let mut out = Vec::new();
        for (idx, enc) in encs.iter().enumerate() {
            match self.plain_db(enc, force) {
                Ok(p) => out.push((idx, p)),
                Err(e) => log::warn!("跳过分库: {}", e),
            }
        }
        out
    }

    fn plain_contact(&mut self, force: bool) -> Option<PathBuf> {
        let contact_db = self.contact_db.clone()?;
        self.plain_db(&contact_db, force).ok()
    }

    // ---------- 元数据 ----------
    pub fn ensure_meta(&mut self, force: bool) -> Result<()> {
        if !force {
            if let Some(at) = self.meta_at {
                if at.elapsed().as_secs_f64() < self.ttl {
                    return Ok(());
                }
            }
        }
        self.ensure_keys()?;
        let encs: Vec<String> = self.msg_dbs.clone();
        let mut shards: Vec<Shard> = Vec::new();
        for enc in &encs {
            if !self.keys.contains_key(enc) {
                log::warn!("分库无密钥，跳过");
                continue;
            }
            let plain = self.plain_db(enc, force)?;
            let conn = db_reader::connect(&plain)?;
            let tables = db_reader::discover_message_tables(&conn)?
                .into_iter()
                .collect::<HashSet<_>>();
            let name2id = db_reader::get_name2id_mapping(&conn);
            shards.push(Shard {
                enc: enc.clone(),
                tables,
                name2id,
            });
        }
        if shards.is_empty() {
            bail!("没有可解密的消息分库。");
        }

        self.sender_names = shards
            .iter()
            .flat_map(|s| s.name2id.values().cloned())
            .collect();
        let mut all_tables: Vec<String> = shards
            .iter()
            .flat_map(|s| s.tables.iter().cloned())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        all_tables.sort();
        let mut sender_names: Vec<String> = self.sender_names.iter().cloned().collect();
        sender_names.sort();
        self.conv_map = db_reader::build_table_conversation_map(&sender_names, &all_tables);
        self.wxid_to_table = self
            .conv_map
            .iter()
            .map(|(t, w)| (w.clone(), t.clone()))
            .collect();
        self.shards = shards;

        self.contacts = match self.plain_contact(force) {
            Some(p) => db_reader::connect(&p)
                .map(|c| db_reader::read_contacts(&c))
                .unwrap_or_default(),
            None => HashMap::new(),
        };
        self.meta_at = Some(Instant::now());
        self.meta_loaded = true;
        log::info!(
            "元数据: 分库 {}, 会话映射 {}, 联系人 {}",
            self.shards.len(),
            self.conv_map.len(),
            self.contacts.len()
        );
        Ok(())
    }

    pub fn display_name(&self, wxid: &str) -> String {
        if let Some(c) = self.contacts.get(wxid) {
            if !c.remark.is_empty() {
                return c.remark.clone();
            }
            if !c.nickname.is_empty() {
                return c.nickname.clone();
            }
        }
        wxid.to_string()
    }

    /// 解析某条消息真实发送者显示名与正文。
    /// 优先级：正文内嵌 "wxid:\n" > real_sender_id 经 Name2Id > 会话对端。
    pub fn sender_of(
        &self,
        conv_wxid: &str,
        sender_id: i64,
        content: &str,
        name2id: &HashMap<i64, String>,
    ) -> (String, String) {
        if let Some(idx) = content.find(":\n") {
            let head = &content[..idx];
            let tail = &content[idx + 2..];
            if head.starts_with("wxid_") || self.sender_names.contains(head) {
                return (self.display_name(head), tail.to_string());
            }
        }
        if let Some(uname) = name2id.get(&sender_id) {
            if uname != conv_wxid {
                return (self.display_name(uname), content.to_string());
            }
        }
        (self.display_name(conv_wxid), content.to_string())
    }

    /// 跨分库取某会话表最近 limit 条，按 (时间, 分库, local_id) 倒序。
    pub fn fetch_rows(
        &self,
        plains: &[(usize, PathBuf)],
        table: &str,
        limit: i64,
        since: i64,
    ) -> Vec<RawRow> {
        let safe = match db_reader::validate_identifier(table) {
            Ok(_) => table,
            Err(_) => return Vec::new(),
        };
        let where_clause = if since != 0 {
            "WHERE create_time >= ?"
        } else {
            ""
        };
        let sql = format!(
            "SELECT create_time, local_type, real_sender_id, message_content, \
             WCDB_CT_message_content, local_id, packed_info_data \
             FROM [{safe}] {where_clause} ORDER BY local_id DESC LIMIT ?"
        );
        // 排序键 (ts, shard_idx, local_id)
        let mut rows: Vec<((i64, usize, i64), RawRow)> = Vec::new();
        for (idx, plain) in plains {
            if !self.shards[*idx].tables.contains(table) {
                continue;
            }
            let conn = match db_reader::connect(plain) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let mut stmt = match conn.prepare(&sql) {
                Ok(s) => s,
                Err(e) => {
                    log::error!("读取消息失败: {}", e);
                    continue;
                }
            };
            let mapped = |r: &rusqlite::Row| -> rusqlite::Result<RowTuple> {
                Ok((
                    r.get::<_, Option<i64>>(0)?.unwrap_or(0),
                    r.get::<_, Option<i64>>(1)?.unwrap_or(1),
                    r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                    r.get::<_, Option<Vec<u8>>>(3)?.unwrap_or_default(),
                    r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                    r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                    r.get::<_, Option<Vec<u8>>>(6)?.unwrap_or_default(),
                ))
            };
            let iter = if since != 0 {
                stmt.query_map(rusqlite::params![since, limit], mapped)
            } else {
                stmt.query_map(rusqlite::params![limit], mapped)
            };
            if let Ok(iter) = iter {
                for row in iter.flatten() {
                    let (ts, mtype, sid, raw, cflag, lid, packed) = row;
                    rows.push((
                        (ts, *idx, lid),
                        RawRow {
                            ts,
                            mtype,
                            sender_id: sid,
                            raw,
                            cflag,
                            shard_idx: *idx,
                            packed,
                        },
                    ));
                }
            }
        }
        rows.sort_by(|a, b| b.0.cmp(&a.0));
        rows.into_iter()
            .take(limit.max(0) as usize)
            .map(|(_, r)| r)
            .collect()
    }

    /// 跨分库查会话表并解析发送者，按时间升序返回 JSON 消息。
    pub fn read_messages(
        &self,
        plains: &[(usize, PathBuf)],
        table: &str,
        conv_wxid: &str,
        limit: i64,
    ) -> Vec<serde_json::Value> {
        let rows = self.fetch_rows(plains, table, limit, 0);
        let mut out = Vec::new();
        for r in rows {
            let content = db_reader::decode_content(&r.raw, r.cflag);
            let name2id = &self.shards[r.shard_idx].name2id;
            let (sender, body) = self.sender_of(conv_wxid, r.sender_id, &content, name2id);
            let mut msg = serde_json::json!({
                "time": crate::tools::fmt_ts(r.ts),
                "type": if r.mtype == 0 { 1 } else { r.mtype },
                "sender": sender,
                "content": body,
            });
            if (r.mtype & 0xFFFF_FFFF) == IMAGE_TYPE {
                msg["content"] = serde_json::json!("[图片]");
                if let Some(name) = image::image_name_from_packed(&r.packed) {
                    msg["image"] = serde_json::json!(name);
                }
            }
            out.push(msg);
        }
        out.reverse();
        out
    }

    pub fn attach_root(&self) -> Option<PathBuf> {
        self.account_dir
            .as_ref()
            .map(|d| PathBuf::from(d).join("msg").join("attach"))
    }

    pub fn image_keys(&mut self) -> Result<([u8; 16], u8)> {
        if let Some(k) = self.img_keys {
            return Ok(k);
        }
        self.locate()?;
        let account_dir = self
            .account_dir
            .clone()
            .ok_or_else(|| anyhow::anyhow!("account_dir 未知"))?;
        let base = Path::new(&account_dir)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        // 去掉末尾 _<suffix>
        let wxid = match base.rfind('_') {
            Some(i) => &base[..i],
            None => base,
        };
        let attach = self
            .attach_root()
            .ok_or_else(|| anyhow::anyhow!("attach 目录未知"))?;
        let k = image::load_image_keys(&attach, wxid)?;
        self.img_keys = Some(k);
        Ok(k)
    }

    /// query -> [(wxid, table, display)]。精确 wxid 命中优先返回单条。
    pub fn resolve_conversation(&mut self, query: &str) -> Result<Vec<(String, String, String)>> {
        self.ensure_meta(false)?;
        let q = query.trim();
        if let Some(table) = self.wxid_to_table.get(q) {
            return Ok(vec![(q.to_string(), table.clone(), self.display_name(q))]);
        }
        let ql = q.to_lowercase();
        let mut out = Vec::new();
        for (wxid, table) in &self.wxid_to_table {
            let disp = self.display_name(wxid);
            if wxid.to_lowercase().contains(&ql) || disp.to_lowercase().contains(&ql) {
                out.push((wxid.clone(), table.clone(), disp));
            }
        }
        Ok(out)
    }

    // 只读访问器，供 tools 层构造 JSON。
    pub fn conv_map(&self) -> &HashMap<String, String> {
        &self.conv_map
    }
    pub fn wxid_to_table(&self) -> &HashMap<String, String> {
        &self.wxid_to_table
    }
    pub fn contacts(&self) -> &HashMap<String, Contact> {
        &self.contacts
    }
    pub fn shard_tables(&self, idx: usize) -> &HashSet<String> {
        &self.shards[idx].tables
    }
    pub fn name2id(&self, idx: usize) -> &HashMap<i64, String> {
        &self.shards[idx].name2id
    }

    // ---------- 清理 ----------
    pub fn cleanup(&mut self) {
        for p in self.plain.values() {
            let _ = std::fs::remove_file(&p.path);
        }
        self.plain.clear();
    }

    pub fn reload(&mut self) {
        self.cleanup();
        self.pid = None;
        self.msg_db = None;
        self.contact_db = None;
        self.msg_dbs.clear();
        self.account_dir = None;
        self.img_keys = None;
        self.keys.clear();
        self.shards.clear();
        self.sender_names.clear();
        self.conv_map.clear();
        self.wxid_to_table.clear();
        self.contacts.clear();
        self.meta_at = None;
        self.meta_loaded = false;
    }
}

impl Drop for WeChatSession {
    fn drop(&mut self) {
        self.cleanup();
        // 顺带清掉本进程的临时目录。
        let _ = std::fs::remove_dir_all(&self.temp_root);
    }
}

/// 建立本进程专属临时目录，并清理不再存活 pid 的残留子目录。
fn init_temp_root() -> PathBuf {
    let parent = std::env::temp_dir().join("cc-wechat-mcp");
    let _ = std::fs::create_dir_all(&parent);
    cleanup_stale(&parent);
    let mine = parent.join(std::process::id().to_string());
    let _ = std::fs::create_dir_all(&mine);
    mine
}

/// 删除 parent 下那些子目录名是「已不存在的 pid」的残留。
fn cleanup_stale(parent: &Path) {
    let rd = match std::fs::read_dir(parent) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    for e in rd.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if let Ok(pid) = name.parse::<u32>() {
            if pid != std::process::id() && !pid_alive(pid) {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(h, &mut code);
        CloseHandle(h);
        ok != 0 && code as i32 == STILL_ACTIVE
    }
}

#[cfg(not(windows))]
fn pid_alive(pid: u32) -> bool {
    // 非 Windows 仅用于清理自身残留：有 /proc 时据此判断，否则保守返回 true（宁可不误删）。
    let proc = std::path::Path::new("/proc");
    if proc.exists() {
        return proc.join(pid.to_string()).exists();
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_new_reads_defaults() {
        // 不依赖真机，仅验证默认 TTL 与构造不 panic。
        std::env::remove_var("WECHAT_PLAINTEXT_TTL");
        let s = WeChatSession::new();
        assert_eq!(s.ttl, 30.0);
        assert!(s.pid.is_none());
    }
}
