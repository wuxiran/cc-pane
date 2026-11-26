//! 7 个 MCP 工具的实现：参数名、默认值、返回 JSON 字段与 Python 版完全一致。
//! 返回 ToolOutcome：文本（JSON 字符串，中文不转义）或图片（base64 + mimeType）。

use crate::image;
use crate::session::WeChatSession;
use chrono::TimeZone;
use serde_json::{json, Value};
use std::io::Cursor;

/// 工具产物：要么一段 JSON 文本，要么一张图片。
pub enum ToolOutcome {
    Json(Value),
    Image { data: Vec<u8>, mime: String },
}

impl ToolOutcome {
    fn err(msg: impl std::fmt::Display) -> ToolOutcome {
        ToolOutcome::Json(json!({"ok": false, "error": msg.to_string()}))
    }
}

/// 本地时区格式化为 `%Y-%m-%d %H:%M:%S`；ts=0 返回 "?"。
pub fn fmt_ts(ts: i64) -> String {
    if ts == 0 {
        return "?".to_string();
    }
    match chrono::Local.timestamp_opt(ts, 0) {
        chrono::offset::LocalResult::Single(dt) => dt.format("%Y-%m-%d %H:%M:%S").to_string(),
        _ => ts.to_string(),
    }
}

fn basename(p: &str) -> String {
    std::path::Path::new(p)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.to_string())
}

pub fn wechat_status(s: &mut WeChatSession) -> ToolOutcome {
    match s.locate() {
        Err(e) => ToolOutcome::Json(json!({
            "ok": false, "running": false, "error": e.to_string()
        })),
        Ok((pid, msg_db, contact_db)) => {
            let keys_cached = s.msg_dbs.iter().filter(|p| s.keys.contains_key(*p)).count();
            ToolOutcome::Json(json!({
                "ok": true,
                "running": true,
                "pid": pid,
                "message_db": msg_db,
                "message_dbs": s.msg_dbs.iter().map(|p| basename(p)).collect::<Vec<_>>(),
                "contact_db": contact_db,
                "key_cached": s.keys.contains_key(&msg_db),
                "keys_cached": keys_cached,
                "plaintext_ttl_sec": s.ttl,
                "meta_loaded": s.meta_loaded,
            }))
        }
    }
}

pub fn list_contacts(s: &mut WeChatSession, query: &str, limit: i64) -> ToolOutcome {
    if let Err(e) = s.ensure_meta(false) {
        return ToolOutcome::err(e);
    }
    let ql = query.trim().to_lowercase();
    let mut rows = Vec::new();
    for (wxid, c) in s.contacts() {
        let disp = if !c.remark.is_empty() {
            c.remark.clone()
        } else if !c.nickname.is_empty() {
            c.nickname.clone()
        } else {
            wxid.clone()
        };
        if !ql.is_empty()
            && !wxid.to_lowercase().contains(&ql)
            && !disp.to_lowercase().contains(&ql)
        {
            continue;
        }
        rows.push(json!({
            "wxid": wxid,
            "display": disp,
            "nickname": c.nickname,
            "remark": c.remark,
            "is_group": wxid.ends_with("@chatroom"),
            "has_messages": s.wxid_to_table().contains_key(wxid),
        }));
        if rows.len() as i64 >= limit {
            break;
        }
    }
    ToolOutcome::Json(json!({
        "ok": true,
        "count": rows.len(),
        "total_contacts": s.contacts().len(),
        "contacts": rows,
    }))
}

pub fn list_conversations(s: &mut WeChatSession, limit: i64) -> ToolOutcome {
    if let Err(e) = s.ensure_meta(false) {
        return ToolOutcome::err(e);
    }
    let plains = s.plain_shards(false);

    // 每个会话表的最近一条消息时间（跨分库取最大）。
    let mut last: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    let conv_tables: Vec<String> = s.conv_map().keys().cloned().collect();
    for (idx, plain) in &plains {
        let conn = match crate::db_reader::connect(plain) {
            Ok(c) => c,
            Err(_) => continue,
        };
        for table in s.shard_tables(*idx).iter() {
            if !conv_tables.contains(table) {
                continue;
            }
            let safe = match crate::db_reader::validate_identifier(table) {
                Ok(_) => table,
                Err(_) => continue,
            };
            let ts: i64 = conn
                .query_row(&format!("SELECT MAX(create_time) FROM [{safe}]"), [], |r| {
                    r.get::<_, Option<i64>>(0)
                })
                .ok()
                .flatten()
                .unwrap_or(0);
            let e = last.entry(table.clone()).or_insert(0);
            if ts > *e {
                *e = ts;
            }
        }
    }

    let mut rows: Vec<(i64, Value)> = Vec::new();
    for (table, wxid) in s.conv_map() {
        let last_ts = *last.get(table).unwrap_or(&0);
        rows.push((
            last_ts,
            json!({
                "wxid": wxid,
                "display": s.display_name(wxid),
                "is_group": wxid.ends_with("@chatroom"),
                "last_time": fmt_ts(last_ts),
            }),
        ));
    }
    rows.sort_by_key(|a| std::cmp::Reverse(a.0));
    let total = rows.len();
    let out: Vec<Value> = rows
        .into_iter()
        .take(limit.max(0) as usize)
        .map(|(_, v)| v)
        .collect();
    ToolOutcome::Json(json!({
        "ok": true,
        "count": out.len(),
        "total_conversations": total,
        "conversations": out,
    }))
}

pub fn get_messages(
    s: &mut WeChatSession,
    conversation: &str,
    limit: i64,
    refresh: bool,
) -> ToolOutcome {
    if refresh {
        if let Err(e) = s.ensure_meta(true) {
            return ToolOutcome::err(e);
        }
    }
    let matches = match s.resolve_conversation(conversation) {
        Ok(m) => m,
        Err(e) => return ToolOutcome::err(e),
    };
    if matches.is_empty() {
        return ToolOutcome::Json(json!({
            "ok": false,
            "error": format!("未找到会话: {conversation:?}（试试 list_conversations）"),
        }));
    }
    if matches.len() > 1 {
        let candidates: Vec<Value> = matches
            .iter()
            .take(20)
            .map(|(w, _, d)| json!({"wxid": w, "display": d}))
            .collect();
        return ToolOutcome::Json(json!({
            "ok": false,
            "error": "匹配到多个会话，请用具体 wxid 再查一次。",
            "candidates": candidates,
        }));
    }
    let (wxid, table, disp) = matches.into_iter().next().unwrap();
    let plains = s.plain_shards(refresh);
    let msgs = s.read_messages(&plains, &table, &wxid, limit);
    ToolOutcome::Json(json!({
        "ok": true,
        "conversation": wxid,
        "display": disp,
        "is_group": wxid.ends_with("@chatroom"),
        "count": msgs.len(),
        "messages": msgs,
    }))
}

pub fn search_messages(
    s: &mut WeChatSession,
    keyword: &str,
    limit: i64,
    days: i64,
    per_conv_scan: i64,
    refresh: bool,
) -> ToolOutcome {
    let kw = keyword.trim();
    if kw.is_empty() {
        return ToolOutcome::err("keyword 不能为空");
    }
    if let Err(e) = s.ensure_meta(refresh) {
        return ToolOutcome::err(e);
    }
    let plains = s.plain_shards(false);
    let kwl = kw.to_lowercase();
    let since = if days > 0 {
        (chrono::Utc::now().timestamp()) - days * 86400
    } else {
        0
    };

    let conv_map: Vec<(String, String)> = s
        .conv_map()
        .iter()
        .map(|(t, w)| (t.clone(), w.clone()))
        .collect();
    let mut hits: Vec<(i64, Value)> = Vec::new();
    for (table, wxid) in &conv_map {
        if hits.len() as i64 >= limit {
            break;
        }
        let rows = s.fetch_rows(&plains, table, per_conv_scan, since);
        for r in rows {
            let content = crate::db_reader::decode_content(&r.raw, r.cflag);
            let name2id = s.name2id(r.shard_idx);
            let (sender, body) = s.sender_of(wxid, r.sender_id, &content, name2id);
            if body.to_lowercase().contains(&kwl) {
                hits.push((
                    r.ts,
                    json!({
                        "conversation": wxid,
                        "display": s.display_name(wxid),
                        "time": fmt_ts(r.ts),
                        "type": if r.mtype == 0 { 1 } else { r.mtype },
                        "sender": sender,
                        "content": body,
                    }),
                ));
                if hits.len() as i64 >= limit {
                    break;
                }
            }
        }
    }
    hits.sort_by_key(|a| std::cmp::Reverse(a.0));
    let messages: Vec<Value> = hits.into_iter().map(|(_, v)| v).collect();
    ToolOutcome::Json(json!({
        "ok": true,
        "keyword": kw,
        "count": messages.len(),
        "messages": messages,
    }))
}

const IMAGE_HEX_LEN: usize = 32;

pub fn get_image(
    s: &mut WeChatSession,
    conversation: &str,
    image_name: &str,
    max_side: u32,
    save_dir: &str,
) -> ToolOutcome {
    if image_name.len() != IMAGE_HEX_LEN
        || !image_name
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return ToolOutcome::err("image 应为 32 位 hex 文件名");
    }
    let matches = match s.resolve_conversation(conversation) {
        Ok(m) => m,
        Err(e) => return ToolOutcome::err(e),
    };
    if matches.len() != 1 {
        return ToolOutcome::err(format!("会话不唯一或不存在: {conversation:?}"));
    }
    let conv_wxid = matches[0].0.clone();
    let attach = match s.attach_root() {
        Some(a) => a,
        None => return ToolOutcome::err("attach 目录未知"),
    };
    let files = image::find_image_files(&attach, &conv_wxid, image_name);
    if files.is_empty() {
        return ToolOutcome::err("本地没有这张图（微信里还没下载过），先在微信里点开它");
    }
    let (aes_key, xor_key) = match s.image_keys() {
        Ok(k) => k,
        Err(e) => return ToolOutcome::err(e),
    };

    let mut last_err = String::from("解密失败");
    for path in files {
        let raw = match std::fs::read(&path) {
            Ok(d) => d,
            Err(e) => {
                last_err = e.to_string();
                continue;
            }
        };
        let mut data = match image::decrypt_dat(&raw, Some(&aes_key), Some(xor_key)) {
            Ok(d) => d,
            Err(e) => {
                last_err = e.to_string();
                continue;
            }
        };
        let mut ext = image::detect_ext(&data);
        if ext == Some("wxgf") {
            if let Some(jpg) = image::wxgf_to_jpg(&data) {
                data = jpg;
                ext = Some("jpg");
            }
        }
        let ext = match ext {
            Some("wxgf") | None => {
                last_err = format!(
                    "{} 是 {} 格式，无法直接显示",
                    path.file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    ext.unwrap_or("未知")
                );
                continue;
            }
            Some(e) => e,
        };

        if !save_dir.is_empty() {
            let _ = std::fs::create_dir_all(save_dir);
            let out = std::path::Path::new(save_dir).join(format!("{image_name}.{ext}"));
            if let Err(e) = std::fs::write(&out, &data) {
                return ToolOutcome::err(e);
            }
            return ToolOutcome::Json(json!({
                "ok": true,
                "path": out.to_string_lossy(),
                "source": path.to_string_lossy(),
                "bytes": data.len(),
            }));
        }

        let (data, ext) = shrink(data, ext, max_side);
        let mime = match ext {
            "jpg" => "image/jpeg",
            "png" => "image/png",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            _ => "image/jpeg",
        };
        return ToolOutcome::Image {
            data,
            mime: mime.to_string(),
        };
    }
    ToolOutcome::err(last_err)
}

/// 过大的图缩到 max_side 并转 JPEG，避免撑爆客户端上下文。失败则原样返回。
fn shrink(data: Vec<u8>, ext: &'static str, max_side: u32) -> (Vec<u8>, &'static str) {
    let img = match ::image::load_from_memory(&data) {
        Ok(i) => i,
        Err(_) => return (data, ext),
    };
    let (w, h) = (img.width(), img.height());
    if w.max(h) <= max_side && data.len() <= 1_500_000 {
        return (data, ext);
    }
    let resized = img.thumbnail(max_side, max_side).to_rgb8();
    let mut buf = Cursor::new(Vec::new());
    let encoder = ::image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 85);
    match resized.write_with_encoder(encoder) {
        Ok(_) => (buf.into_inner(), "jpg"),
        Err(_) => (data, ext),
    }
}

pub fn reload(s: &mut WeChatSession) -> ToolOutcome {
    s.reload();
    match s.locate() {
        Ok((pid, msg_db, _)) => {
            if let Err(e) = s.ensure_keys() {
                return ToolOutcome::err(e);
            }
            let keys_cached = s.msg_dbs.iter().filter(|p| s.keys.contains_key(*p)).count();
            ToolOutcome::Json(json!({
                "ok": true,
                "pid": pid,
                "message_db": msg_db,
                "key_cached": s.keys.contains_key(&msg_db),
                "keys_cached": keys_cached,
                "message_dbs": s.msg_dbs.len(),
            }))
        }
        Err(e) => ToolOutcome::err(e),
    }
}
