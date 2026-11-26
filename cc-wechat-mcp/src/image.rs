//! 微信 4.x 图片 .dat 解密与密钥推导（解密逻辑跨平台，可单测）。
//!
//! 存储：`<account>\msg\attach\<md5(会话wxid)>\<YYYY-MM>\Img\<name>[_t|_h].dat`
//! 格式：V2 = 头 + AES-128-ECB 段 + 明文段 + 单字节 XOR 段；V1 同布局但 AES 密钥固定；
//!       旧版 = 整文件单字节 XOR。
//! 密钥：xor_key = uin & 0xFF（可由缩略图 JPEG 结尾 FF D9 反推）；
//!       aes_key = md5(f"{uin}{wxid}")[:16]，uin 未知时按 uin≡xor_key(mod256) 暴力枚举。

use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockDecrypt, KeyInit};
use anyhow::{anyhow, bail, Result};
use md5::{Digest, Md5};
use rayon::prelude::*;
use std::path::{Path, PathBuf};

const V1_SIG: &[u8] = b"\x07\x08V1\x08\x07";
const V2_SIG: &[u8] = b"\x07\x08V2\x08\x07";
const V1_AES_KEY: &[u8] = b"cfcd208495d565ef";
const HDR_SZ: usize = 15;

/// 识别图片真实格式。返回静态扩展名。
pub fn detect_ext(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\xff\xd8\xff") {
        return Some("jpg");
    }
    if data.starts_with(b"\x89PNG") {
        return Some("png");
    }
    if data.starts_with(b"GIF8") {
        return Some("gif");
    }
    if data.starts_with(b"wxgf") {
        return Some("wxgf");
    }
    if data.starts_with(b"BM") {
        return Some("bmp");
    }
    if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        return Some("webp");
    }
    None
}

/// 从 packed_info_data 取 32 位小写 hex 文件名。
pub fn image_name_from_packed(packed: &[u8]) -> Option<String> {
    let is_hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
    let mut run = 0usize;
    let mut start = 0usize;
    for (i, &b) in packed.iter().enumerate() {
        if is_hex(b) {
            if run == 0 {
                start = i;
            }
            run += 1;
            if run == 32 {
                return Some(String::from_utf8_lossy(&packed[start..start + 32]).into_owned());
            }
        } else {
            run = 0;
        }
    }
    None
}

fn aes128_ecb_decrypt(key: &[u8], data: &[u8]) -> Vec<u8> {
    let cipher = aes::Aes128::new_from_slice(key).expect("16-byte key");
    let mut out = data.to_vec();
    for chunk in out.as_chunks_mut::<16>().0 {
        let mut block = GenericArray::clone_from_slice(chunk);
        cipher.decrypt_block(&mut block);
        chunk.copy_from_slice(&block);
    }
    out
}

/// 解密 .dat。aes_key/xor_key 对 V2 必需；V1 用固定 AES 密钥；旧版纯 XOR 自动反推。
pub fn decrypt_dat(data: &[u8], aes_key: Option<&[u8]>, xor_key: Option<u8>) -> Result<Vec<u8>> {
    if data.starts_with(V1_SIG) || data.starts_with(V2_SIG) {
        let key: &[u8] = if data.starts_with(V1_SIG) {
            V1_AES_KEY
        } else {
            aes_key.ok_or_else(|| anyhow!("缺少图片 AES 密钥"))?
        };
        let xor_key = xor_key.ok_or_else(|| anyhow!("缺少图片 XOR 密钥"))?;
        if data.len() < HDR_SZ {
            bail!("图片头过短");
        }
        let aes_size = u32::from_le_bytes([data[6], data[7], data[8], data[9]]) as usize;
        let xor_size = u32::from_le_bytes([data[10], data[11], data[12], data[13]]) as usize;
        // PKCS7：整块时也会多补一块
        let aligned = aes_size + (16 - aes_size % 16);
        let body = &data[HDR_SZ..];
        if aligned > body.len() {
            bail!("AES 段越界");
        }
        let dec = aes128_ecb_decrypt(key, &body[..aligned]);
        let mut out = dec[..aes_size.min(dec.len())].to_vec();
        if xor_size != 0 {
            let tail_start = body.len().saturating_sub(xor_size);
            out.extend_from_slice(&body[aligned..tail_start]);
            out.extend(body[tail_start..].iter().map(|b| b ^ xor_key));
        } else {
            out.extend_from_slice(&body[aligned..]);
        }
        return Ok(out);
    }

    // 旧版纯 XOR：用文件头魔数反推单字节密钥。
    const MAGICS: [&[u8]; 4] = [b"\xff\xd8\xff", b"\x89PNG", b"GIF8", b"BM"];
    for magic in MAGICS {
        if data.len() < magic.len() {
            continue;
        }
        let k = data[0] ^ magic[0];
        if (0..magic.len()).all(|i| data[i] ^ k == magic[i]) {
            return Ok(data.iter().map(|b| b ^ k).collect());
        }
    }
    bail!("无法识别的图片格式")
}

/// 按 高清 > 普通 > 缩略图 返回本地已存在的 .dat 路径。
pub fn find_image_files(attach_root: &Path, conv_wxid: &str, name: &str) -> Vec<PathBuf> {
    let conv_dir = attach_root.join(crate::db_reader::md5_hex(conv_wxid.as_bytes()));
    let mut out = Vec::new();
    let month_dirs = match std::fs::read_dir(&conv_dir) {
        Ok(rd) => rd.flatten().map(|e| e.path()).collect::<Vec<_>>(),
        Err(_) => return out,
    };
    for suffix in ["_h", "", "_t"] {
        let fname = format!("{name}{suffix}.dat");
        for month in &month_dirs {
            let candidate = month.join("Img").join(&fname);
            if candidate.is_file() {
                out.push(candidate);
            }
        }
    }
    out
}

/// 枚举近期缩略图（按 mtime 倒序，上限 limit）。
fn thumbs(attach_root: &Path, limit: usize) -> Vec<PathBuf> {
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    // attach_root/<conv>/<month>/Img/*_t.dat
    let read = |p: &Path| {
        std::fs::read_dir(p)
            .ok()
            .map(|rd| rd.flatten().map(|e| e.path()).collect::<Vec<_>>())
    };
    if let Some(convs) = read(attach_root) {
        for conv in convs {
            if let Some(months) = read(&conv) {
                for month in months {
                    let img = month.join("Img");
                    if let Some(entries) = read(&img) {
                        for f in entries {
                            if f.file_name()
                                .and_then(|n| n.to_str())
                                .is_some_and(|n| n.ends_with("_t.dat"))
                            {
                                let mt = f
                                    .metadata()
                                    .and_then(|m| m.modified())
                                    .unwrap_or(std::time::UNIX_EPOCH);
                                files.push((mt, f));
                            }
                        }
                    }
                }
            }
        }
    }
    files.sort_by_key(|a| std::cmp::Reverse(a.0));
    files.into_iter().take(limit).map(|(_, p)| p).collect()
}

/// 缩略图是 JPEG，结尾 FF D9；两字节反推一致者计一票，取最高票。
pub fn guess_xor_key(thumb_paths: &[PathBuf]) -> Option<u8> {
    let mut votes = [0u32; 256];
    for f in thumb_paths {
        if let Ok(data) = std::fs::read(f) {
            if data.len() >= 2 {
                let a = data[data.len() - 2];
                let b = data[data.len() - 1];
                if a ^ 0xFF == b ^ 0xD9 {
                    votes[(b ^ 0xD9) as usize] += 1;
                }
            }
        }
    }
    let (idx, &cnt) = votes.iter().enumerate().max_by_key(|(_, &c)| c)?;
    if cnt > 0 {
        Some(idx as u8)
    } else {
        None
    }
}

/// 取一张 V2 缩略图的首个 16 字节 AES 块，用于暴力枚举校验。
fn first_aes_block(thumb_paths: &[PathBuf]) -> Option<[u8; 16]> {
    for f in thumb_paths {
        if let Ok(data) = std::fs::read(f) {
            if data.starts_with(V2_SIG) && data.len() >= HDR_SZ + 16 {
                let mut blk = [0u8; 16];
                blk.copy_from_slice(&data[HDR_SZ..HDR_SZ + 16]);
                return Some(blk);
            }
        }
    }
    None
}

fn aes_key_for_uin(uin: u64, wxid: &[u8]) -> [u8; 16] {
    let mut h = Md5::new();
    h.update(uin.to_string().as_bytes());
    h.update(wxid);
    let digest = h.finalize();
    // 取 hex 字符串前 16 个字符（ASCII），即前 8 字节的 hex。
    let mut key = [0u8; 16];
    for i in 0..8 {
        let hex = format!("{:02x}", digest[i]);
        key[i * 2] = hex.as_bytes()[0];
        key[i * 2 + 1] = hex.as_bytes()[1];
    }
    key
}

/// 枚举 uin ≡ xor_key (mod 256)，返回 (uin, aes_key)。rayon 并行，命中即停。
pub fn brute_aes_key(block: &[u8; 16], wxid: &str, xor_key: u8) -> Option<(u64, [u8; 16])> {
    let wxid_bytes = wxid.as_bytes();
    let total: u64 = 1 << 32;
    let count = total / 256; // 16_777_216 个候选
    (0u64..count).into_par_iter().find_map_any(|i| {
        let uin = xor_key as u64 + i * 256;
        let key = aes_key_for_uin(uin, wxid_bytes);
        let dec = aes128_ecb_decrypt(&key, block);
        match detect_ext(&dec) {
            Some("jpg" | "png" | "gif" | "wxgf") => Some((uin, key)),
            _ => None,
        }
    })
}

fn cache_path() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(dirs_home);
    base.join("wechat_mcp").join("image_keys.json")
}

fn dirs_home() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// 返回 (aes_key, xor_key)。优先级：环境变量 > 本地缓存 > 现场推导（首次约十几秒）。
/// 缓存文件格式与 Python 版完全一致，可直接复用已推导的 image_keys.json。
pub fn load_image_keys(attach_root: &Path, wxid: &str) -> Result<([u8; 16], u8)> {
    if let (Ok(aes), Ok(xor)) = (
        std::env::var("WECHAT_IMG_AES_KEY"),
        std::env::var("WECHAT_IMG_XOR_KEY"),
    ) {
        if !aes.is_empty() && !xor.is_empty() {
            let xor_val = parse_int_auto(&xor)?;
            let mut key = [0u8; 16];
            let ab = aes.as_bytes();
            if ab.len() != 16 {
                bail!("WECHAT_IMG_AES_KEY 必须 16 字节");
            }
            key.copy_from_slice(ab);
            return Ok((key, xor_val as u8));
        }
    }

    let path = cache_path();
    let mut cache: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    if let Some(hit) = cache.get(wxid) {
        if let (Some(aes), Some(xor)) = (
            hit.get("aes_key").and_then(|v| v.as_str()),
            hit.get("xor_key"),
        ) {
            let xor_val = xor
                .as_u64()
                .or_else(|| xor.as_str().and_then(|s| s.parse().ok()));
            if aes.len() == 16 {
                if let Some(xv) = xor_val {
                    let mut key = [0u8; 16];
                    key.copy_from_slice(aes.as_bytes());
                    return Ok((key, xv as u8));
                }
            }
        }
    }

    let thumb_paths = thumbs(attach_root, 200);
    let xor_key =
        guess_xor_key(&thumb_paths).ok_or_else(|| anyhow!("本地没有可用于推导密钥的 V2 缩略图"))?;
    let block = first_aes_block(&thumb_paths)
        .ok_or_else(|| anyhow!("本地没有可用于推导密钥的 V2 缩略图"))?;
    log::info!("推导图片密钥: xor=0x{:02x}, 枚举 uin…", xor_key);
    let (uin, aes_key) = brute_aes_key(&block, wxid, xor_key)
        .ok_or_else(|| anyhow!("图片 AES 密钥推导失败（uin 规则可能已变）"))?;
    log::info!("图片密钥推导成功");

    // 写回缓存（格式与 Python 一致：aes_key 为 ASCII 字符串、xor_key 为整数）。
    if let Some(obj) = cache.as_object_mut() {
        obj.insert(
            wxid.to_string(),
            serde_json::json!({
                "uin": uin,
                "aes_key": String::from_utf8_lossy(&aes_key),
                "xor_key": xor_key,
            }),
        );
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, serde_json::to_string(&cache).unwrap_or_default());
    Ok((aes_key, xor_key))
}

fn parse_int_auto(s: &str) -> Result<u64> {
    let s = s.trim();
    if let Some(h) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        Ok(u64::from_str_radix(h, 16)?)
    } else {
        Ok(s.parse()?)
    }
}

/// wxgf = "wxgf" 头 + HEVC Annex-B 码流；用 ffmpeg 解第一帧为 JPEG。没 ffmpeg 返回 None。
pub fn wxgf_to_jpg(data: &[u8]) -> Option<Vec<u8>> {
    let ffmpeg = ffmpeg_path()?;
    // 找 Annex-B 起始码
    let start = find_subslice(data, b"\x00\x00\x00\x01")?;
    let mut child = std::process::Command::new(&ffmpeg);
    child
        .args([
            "-v",
            "error",
            "-f",
            "hevc",
            "-i",
            "pipe:0",
            "-frames:v",
            "1",
            "-f",
            "image2",
            "-c:v",
            "mjpeg",
            "-q:v",
            "3",
            "pipe:1",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        child.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut proc = child.spawn().ok()?;
    {
        use std::io::Write;
        let mut stdin = proc.stdin.take()?;
        let payload = data[start..].to_vec();
        // 另起线程写，避免管道死锁。Builder::spawn 显式处理建线程失败（项目规约禁用裸 spawn）。
        std::thread::Builder::new()
            .name("wxgf-feed".into())
            .spawn(move || {
                let _ = stdin.write_all(&payload);
            })
            .ok()?;
    }
    let out = proc.wait_with_output().ok()?;
    if out.status.success() && out.stdout.starts_with(b"\xff\xd8") {
        Some(out.stdout)
    } else {
        log::warn!("ffmpeg 转 wxgf 失败");
        None
    }
}

fn ffmpeg_path() -> Option<String> {
    if let Ok(p) = std::env::var("WECHAT_FFMPEG") {
        if !p.is_empty() {
            return Some(p);
        }
    }
    // PATH 查找
    let exe = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    if let Ok(paths) = std::env::var("PATH") {
        for dir in std::env::split_paths(&paths) {
            let cand = dir.join(exe);
            if cand.is_file() {
                return Some(cand.to_string_lossy().into_owned());
            }
        }
    }
    None
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_ext_basics() {
        assert_eq!(detect_ext(b"\xff\xd8\xff\xe0jfif"), Some("jpg"));
        assert_eq!(detect_ext(b"\x89PNG\r\n"), Some("png"));
        assert_eq!(detect_ext(b"RIFF\x00\x00\x00\x00WEBPVP8"), Some("webp"));
        assert_eq!(detect_ext(b"nope"), None);
    }

    #[test]
    fn packed_name_extracts_hex32() {
        let mut packed = vec![0u8, 1, 2];
        packed.extend_from_slice(b"0123456789abcdef0123456789abcdef");
        packed.extend_from_slice(b"tail");
        assert_eq!(
            image_name_from_packed(&packed).as_deref(),
            Some("0123456789abcdef0123456789abcdef")
        );
        assert_eq!(image_name_from_packed(b"short"), None);
    }

    #[test]
    fn old_xor_roundtrip() {
        // 构造一张被单字节 XOR 的 JPEG，验证自动反推。
        let mut jpg = vec![0xFFu8, 0xD8, 0xFF, 0xE0, 0x11, 0x22, 0x33];
        let k = 0x5A;
        let enc: Vec<u8> = jpg.iter().map(|b| b ^ k).collect();
        let dec = decrypt_dat(&enc, None, None).unwrap();
        assert_eq!(dec, jpg);
        jpg.clear();
    }

    /// 构造一个 V2 .dat（纯 AES 段，无 xor 尾），验证解密还原明文。
    #[test]
    fn v2_dat_roundtrip() {
        use aes::cipher::{BlockEncrypt, KeyInit};
        let key = b"0123456789abcdef"; // 16 字节 ASCII
        let plain = b"\xff\xd8\xff\xe0hello-jpeg-body!"; // 16 字节，正好一块
        let aes_size = plain.len();
        let aligned = aes_size + (16 - aes_size % 16); // 32：多补一块

        // 加密：对 aligned 长度的明文（PKCS7 补一整块 0x10）做 ECB
        let mut buf = plain.to_vec();
        buf.extend(std::iter::repeat(16u8).take(aligned - aes_size));
        let cipher = aes::Aes128::new_from_slice(key).unwrap();
        for chunk in buf.chunks_exact_mut(16) {
            let mut blk = GenericArray::clone_from_slice(chunk);
            cipher.encrypt_block(&mut blk);
            chunk.copy_from_slice(&blk);
        }

        let mut dat = Vec::new();
        dat.extend_from_slice(V2_SIG); // 6
        dat.extend_from_slice(&(aes_size as u32).to_le_bytes()); // 4
        dat.extend_from_slice(&0u32.to_le_bytes()); // xor_size=0
        dat.push(0); // 第 15 字节
        assert_eq!(dat.len(), HDR_SZ);
        dat.extend_from_slice(&buf);

        let dec = decrypt_dat(&dat, Some(key), Some(0x12)).unwrap();
        assert_eq!(&dec, plain);
        assert_eq!(detect_ext(&dec), Some("jpg"));
    }

    #[test]
    fn aes_key_for_uin_is_hex_prefix() {
        // md5("10000wxid_x") 的前 16 个 hex 字符
        let key = aes_key_for_uin(10000, b"wxid_x");
        assert_eq!(key.len(), 16);
        assert!(key.iter().all(|&b| b.is_ascii_hexdigit()));
    }
}
