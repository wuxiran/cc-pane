//! 微信 4.x 密钥提取：DLL 内部密钥 + 进程内存原始密钥，XOR 合并后按 SQLCipher-4 校验。
//!
//! 三步（clean-room 实现）：
//!   1. 从 Weixin.dll 提取 internal_db_key 候选（见 dll_scan）。
//!   2. 扫进程内存，按签名结构取原始密钥候选。
//!   3. 真正密钥 = 原始密钥 XOR internal_db_key（部分库不 XOR），验证第 1 页 HMAC。

use crate::sqlcipher;

pub const KEY_SZ: usize = sqlcipher::KEY_SZ;

/// 内存签名：指针高 2 字节=0，随后 0*8、0x20+0*7、0x2f+0*7。指针在签名起点前 6 字节。
#[cfg(windows)]
const NEEDLE: &[u8] = &[
    0, 0, // 指针高 2 字节
    0, 0, 0, 0, 0, 0, 0, 0, // 0 * 8
    0x20, 0, 0, 0, 0, 0, 0, 0, // size32
    0x2f, 0, 0, 0, 0, 0, 0, 0, // cap47
];
#[cfg(windows)]
const PTR_BACK: usize = 6;

/// 低熵 + 少可打印字符过滤（纯逻辑，可测）。
pub fn is_potential_key(k: &[u8]) -> bool {
    if k.len() != KEY_SZ {
        return false;
    }
    let distinct = k.iter().collect::<std::collections::HashSet<_>>().len();
    if distinct < 15 {
        return false;
    }
    let printable = k.iter().filter(|&&b| (32..=126).contains(&b)).count();
    printable <= 24
}

fn xor(a: &[u8], b: &[u8]) -> Vec<u8> {
    a.iter().zip(b.iter()).map(|(x, y)| x ^ y).collect()
}

/// 对一批原始候选并行验证，命中即停。先试不 XOR，再试每个 internal_db_key。
pub fn verify_candidates(
    first_page: &[u8],
    salt: &[u8],
    raw_candidates: &[[u8; KEY_SZ]],
    internal_keys: &[[u8; KEY_SZ]],
) -> Option<String> {
    use rayon::prelude::*;
    raw_candidates.par_iter().find_map_any(|raw| {
        if sqlcipher::verify_key(first_page, salt, raw) {
            return Some(sqlcipher::bytes_to_hex(raw));
        }
        for ik in internal_keys {
            let cand = xor(raw, ik);
            if sqlcipher::verify_key(first_page, salt, &cand) {
                return Some(sqlcipher::bytes_to_hex(&cand));
            }
        }
        None
    })
}

#[cfg(windows)]
pub use win::*;

#[cfg(windows)]
mod win {
    use super::*;
    use crate::{dll_scan, mem};
    use anyhow::Result;
    use std::collections::HashMap;

    /// 扫内存，返回去重后的原始密钥候选。
    pub fn scan_raw_key_candidates(handle: &mem::ProcHandle) -> Vec<[u8; KEY_SZ]> {
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for (base, size) in mem::enum_regions(handle) {
            let data = match mem::read_region(handle, base, size) {
                Some(d) => d,
                None => continue,
            };
            let mut i = 0usize;
            while let Some(rel) = find_from(&data, NEEDLE, i) {
                let po = rel as isize - PTR_BACK as isize;
                if po >= 0 {
                    let po = po as usize;
                    if po + 8 <= data.len() {
                        let ptr = u64::from_le_bytes(data[po..po + 8].try_into().unwrap());
                        if (0x10000..0x1000_0000_0000).contains(&ptr) {
                            if let Some(key) = mem::read_region(handle, ptr, KEY_SZ) {
                                if key.len() == KEY_SZ && is_potential_key(&key) {
                                    let mut arr = [0u8; KEY_SZ];
                                    arr.copy_from_slice(&key);
                                    if seen.insert(arr) {
                                        out.push(arr);
                                    }
                                }
                            }
                        }
                    }
                }
                i = rel + 1;
            }
        }
        log::info!("内存原始密钥候选: {} 个", out.len());
        out
    }

    fn find_from(hay: &[u8], needle: &[u8], start: usize) -> Option<usize> {
        if start >= hay.len() {
            return None;
        }
        hay[start..]
            .windows(needle.len())
            .position(|w| w == needle)
            .map(|p| p + start)
    }

    fn read_first_page_and_salt(db_path: &str) -> Result<([u8; sqlcipher::SALT_SZ], Vec<u8>)> {
        use std::io::Read;
        let mut f = std::fs::File::open(db_path)?;
        let mut fp = vec![0u8; sqlcipher::PAGE_SIZE];
        f.read_exact(&mut fp)?;
        let mut salt = [0u8; sqlcipher::SALT_SZ];
        salt.copy_from_slice(&fp[..sqlcipher::SALT_SZ]);
        Ok((salt, fp))
    }

    /// 为多个库提取密钥。先扫 DLL + 内存各一次，再逐库匹配（已知密钥优先复用）。
    pub fn extract_all_keys(
        pid: u32,
        db_paths: &[String],
        internal_keys_override: Option<Vec<[u8; KEY_SZ]>>,
    ) -> Result<HashMap<String, String>> {
        if db_paths.is_empty() {
            return Ok(HashMap::new());
        }

        // 1) DLL 内部密钥候选
        let internal_keys: Vec<[u8; KEY_SZ]> = match internal_keys_override {
            Some(k) => {
                log::info!("使用手动指定的 {} 个 internal_db_key", k.len());
                k
            }
            None => match dll_scan::resolve_weixin_dll(None) {
                Some(dll) => dll_scan::extract_internal_db_keys(&dll).unwrap_or_default(),
                None => {
                    log::warn!("未找到 Weixin.dll，跳过 internal_db_key");
                    Vec::new()
                }
            },
        };

        // 2) 内存原始候选（扫一次）
        let handle = mem::open_process(pid)?;
        let raw_candidates = scan_raw_key_candidates(&handle);
        drop(handle);
        if raw_candidates.is_empty() {
            log::error!("内存中未找到原始密钥候选");
            return Ok(HashMap::new());
        }
        log::info!(
            "验证 {} 个原始候选 × {} 个 internal_db_key（+不XOR）…",
            raw_candidates.len(),
            internal_keys.len()
        );

        // 3) 逐库匹配
        let mut result = HashMap::new();
        let mut known: Vec<String> = Vec::new();
        for db_path in db_paths {
            let (salt, first_page) = match read_first_page_and_salt(db_path) {
                Ok(v) => v,
                Err(e) => {
                    log::warn!("读取库头失败 {}: {}", crate::logx::mask_key(db_path), e);
                    continue;
                }
            };
            // 先试已找到的密钥
            let mut hit = known
                .iter()
                .find(|hk| sqlcipher::verify_key_hex(&first_page, &salt, hk))
                .cloned();
            if hit.is_none() {
                hit = verify_candidates(&first_page, &salt, &raw_candidates, &internal_keys);
            }
            if let Some(h) = hit {
                if !known.contains(&h) {
                    known.push(h.clone());
                }
                log::info!("匹配库成功 key={}", crate::logx::mask_key(&h));
                result.insert(db_path.clone(), h);
            } else {
                log::warn!("未找到密钥（某库）");
            }
        }
        Ok(result)
    }
}

#[cfg(not(windows))]
pub fn extract_all_keys(
    _pid: u32,
    _db_paths: &[String],
    _internal_keys_override: Option<Vec<[u8; KEY_SZ]>>,
) -> anyhow::Result<std::collections::HashMap<String, String>> {
    anyhow::bail!(crate::NOT_WINDOWS_MSG)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn potential_key_filters() {
        // 全 0：distinct 太少
        assert!(!is_potential_key(&[0u8; 32]));
        // 全可打印 ASCII：printable 太多
        assert!(!is_potential_key(b"abcdefghijklmnopqrstuvwxyzABCDEF"));
        // 高熵二进制密钥：通过
        let mut k = [0u8; 32];
        for (i, b) in k.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(7).wrapping_add(200);
        }
        assert!(is_potential_key(&k));
        // 长度不对
        assert!(!is_potential_key(&[1, 2, 3]));
    }

    #[test]
    fn verify_candidates_finds_xor_key() {
        // 造一个库头，真正密钥 = raw XOR internal
        let salt = vec![0x11u8; sqlcipher::SALT_SZ];
        let raw = [0x55u8; 32];
        let internal = [0xAAu8; 32];
        let real: Vec<u8> = raw
            .iter()
            .zip(internal.iter())
            .map(|(a, b)| a ^ b)
            .collect();
        // 用 real 造一页密文（借用 sqlcipher 测试里的 encrypt 思路：这里只需 first page 的 HMAC 对）
        let first_page = make_valid_first_page(&real, &salt);
        let hit = verify_candidates(&first_page, &salt, &[raw], &[internal]).unwrap();
        assert_eq!(hit, sqlcipher::bytes_to_hex(&real));
    }

    /// 用给定 raw_key/salt 造一张能通过 verify_key 的第 1 页（仅 HMAC 正确即可）。
    fn make_valid_first_page(raw_key: &[u8], salt: &[u8]) -> Vec<u8> {
        use hmac::{Hmac, Mac};
        use sha2::Sha512;
        let (enc_key, _) = sqlcipher::derive_keys(raw_key, salt);
        // 复算 mac_key：salt XOR 0x3a，PBKDF2 2 次
        let mac_salt: Vec<u8> = salt.iter().map(|b| b ^ 0x3a).collect();
        let mut mac_key = [0u8; 32];
        pbkdf2::pbkdf2_hmac::<Sha512>(&enc_key, &mac_salt, sqlcipher::HMAC_KDF_ITER, &mut mac_key);

        let mut page = vec![0u8; sqlcipher::PAGE_SIZE];
        page[..salt.len()].copy_from_slice(salt);
        let end = sqlcipher::PAGE_SIZE - sqlcipher::RESERVE + sqlcipher::IV_SZ;
        let mut mac = <Hmac<Sha512> as Mac>::new_from_slice(&mac_key).unwrap();
        mac.update(&page[sqlcipher::SALT_SZ..end]);
        mac.update(&1u32.to_le_bytes());
        let digest = mac.finalize().into_bytes();
        page[end..end + sqlcipher::HMAC_SZ].copy_from_slice(&digest);
        page
    }
}
