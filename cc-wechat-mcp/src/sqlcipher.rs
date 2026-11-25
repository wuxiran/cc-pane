//! 微信 4.0 的 SQLCipher 4 手动实现（无需编译 SQLCipher 原生库），跨平台纯逻辑。
//!
//! 加密参数（社区项目 wechat-dump-rs / chatlog / pywxdump 已验证）：
//! - AES-256-CBC，页大小 4096，reserve = IV(16)+HMAC(64) = 80
//! - KDF: PBKDF2-HMAC-SHA512 256000 次；HMAC 密钥: 再 PBKDF2 2 次
//! - salt = 文件前 16 字节；第 1 页前 16 字节是明文 salt，密文从偏移 16 起
//!
//! 页布局：`[ 密文区 pagesize-reserve ][ IV 16 ][ HMAC-SHA512 64 ]`

use anyhow::{anyhow, bail, Result};
use cbc::cipher::{block_padding::NoPadding, BlockDecryptMut, KeyIvInit};
use hmac::{Hmac, Mac};
use sha2::Sha512;
use std::collections::BTreeMap;
use std::io::Read;

pub const PAGE_SIZE: usize = 4096;
pub const KEY_SZ: usize = 32;
pub const SALT_SZ: usize = 16;
pub const IV_SZ: usize = 16;
pub const HMAC_SZ: usize = 64;
pub const KDF_ITER: u32 = 256_000;
pub const HMAC_KDF_ITER: u32 = 2;
/// IV + HMAC = 80，已是 16 的倍数。
pub const RESERVE: usize = IV_SZ + HMAC_SZ;

/// 解密后第 1 页开头补回的 SQLite 文件头（16 字节）。
pub const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\x00";

type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;
type HmacSha512 = Hmac<Sha512>;

/// 由 32 字节裸密钥 + salt 派生 (enc_key, mac_key)。
pub fn derive_keys(raw_key: &[u8], salt: &[u8]) -> ([u8; KEY_SZ], [u8; KEY_SZ]) {
    let mut enc_key = [0u8; KEY_SZ];
    pbkdf2::pbkdf2_hmac::<Sha512>(raw_key, salt, KDF_ITER, &mut enc_key);
    let mac_key = derive_mac_key(&enc_key, salt);
    (enc_key, mac_key)
}

/// 由已派生的 enc_key 快速算 mac_key（只 2 次迭代）；mac_salt = salt XOR 0x3a。
fn derive_mac_key(enc_key: &[u8], salt: &[u8]) -> [u8; KEY_SZ] {
    let mac_salt: Vec<u8> = salt.iter().map(|b| b ^ 0x3a).collect();
    let mut mac_key = [0u8; KEY_SZ];
    pbkdf2::pbkdf2_hmac::<Sha512>(enc_key, &mac_salt, HMAC_KDF_ITER, &mut mac_key);
    mac_key
}

/// 某页 HMAC-SHA512：输入 = page[data_start .. PAGE_SIZE-RESERVE+IV_SZ] + 页号(小端4字节)。
fn page_hmac(mac_key: &[u8], page: &[u8], page_no: u32, data_start: usize) -> [u8; HMAC_SZ] {
    let end = PAGE_SIZE - RESERVE + IV_SZ; // 4032，含 IV 一起参与
    let mut mac = <HmacSha512 as Mac>::new_from_slice(mac_key).expect("hmac key any len");
    mac.update(&page[data_start..end]);
    mac.update(&page_no.to_le_bytes());
    let out = mac.finalize().into_bytes();
    let mut buf = [0u8; HMAC_SZ];
    buf.copy_from_slice(&out);
    buf
}

/// 用「裸密钥」校验第 1 页 HMAC（内部走完整 256000 次 KDF，较慢）。
pub fn verify_key(first_page: &[u8], salt: &[u8], raw_key: &[u8]) -> bool {
    if raw_key.len() != KEY_SZ || first_page.len() < PAGE_SIZE {
        return false;
    }
    let (_, mac_key) = derive_keys(raw_key, salt);
    check_first_page_hmac(first_page, &mac_key)
}

/// 用「已派生的 enc_key」校验（只需 2 次 KDF，适合海量候选快筛）。
pub fn verify_enc_key(first_page: &[u8], salt: &[u8], enc_key: &[u8]) -> bool {
    if enc_key.len() != KEY_SZ || first_page.len() < PAGE_SIZE {
        return false;
    }
    let mac_key = derive_mac_key(enc_key, salt);
    check_first_page_hmac(first_page, &mac_key)
}

fn check_first_page_hmac(first_page: &[u8], mac_key: &[u8]) -> bool {
    let hmac_off = PAGE_SIZE - RESERVE + IV_SZ; // 4032
    let stored = &first_page[hmac_off..hmac_off + HMAC_SZ];
    let calc = page_hmac(mac_key, first_page, 1, SALT_SZ); // 第 1 页跳过前 16 salt
    constant_time_eq(stored, &calc)
}

pub fn verify_key_hex(first_page: &[u8], salt: &[u8], hex_key: &str) -> bool {
    match hex_to_bytes(hex_key) {
        Some(k) => verify_key(first_page, salt, &k),
        None => false,
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// 十六进制字符串转字节；非法返回 None。
pub fn hex_to_bytes(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let hi = (b[i] as char).to_digit(16)?;
        let lo = (b[i + 1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
        i += 2;
    }
    Some(out)
}

pub fn bytes_to_hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for byte in b {
        s.push_str(&format!("{:02x}", byte));
    }
    s
}

/// 解密单页（pgno 为 1-based），第 1 页补回 SQLite 文件头。返回 4096 字节。
fn decrypt_page(enc_key: &[u8], page: &[u8], pgno: u32) -> Vec<u8> {
    let data_start = if pgno == 1 { SALT_SZ } else { 0 };
    let iv = &page[PAGE_SIZE - RESERVE..PAGE_SIZE - RESERVE + IV_SZ];
    let mut buf = page[data_start..PAGE_SIZE - RESERVE].to_vec();
    Aes256CbcDec::new(enc_key.into(), iv.into())
        .decrypt_padded_mut::<NoPadding>(&mut buf)
        .expect("block aligned, no padding");
    let reserve_area = &page[PAGE_SIZE - RESERVE..];
    let mut out = Vec::with_capacity(PAGE_SIZE);
    if pgno == 1 {
        out.extend_from_slice(SQLITE_HEADER);
    }
    out.extend_from_slice(&buf);
    out.extend_from_slice(reserve_area);
    out
}

// --- WAL（SQLite 标准；SQLCipher 只加密帧内页，帧头明文） ---
const WAL_HDR_SZ: usize = 32;
const WAL_FRAME_HDR_SZ: usize = 24;
const WAL_MAGICS: [u32; 2] = [0x377F_0682, 0x377F_0683];

/// 扫描 WAL，返回 (页号 -> 该页最新已提交帧的页数据偏移, 提交后的库页数)。
/// 只认与 WAL 头 salt 一致的连续帧，且只保留到最后一个 commit 帧。
pub fn wal_committed_frames(wal: &[u8]) -> (BTreeMap<u32, usize>, u32) {
    let mut committed: BTreeMap<u32, usize> = BTreeMap::new();
    if wal.len() < WAL_HDR_SZ {
        return (committed, 0);
    }
    let magic = u32::from_be_bytes([wal[0], wal[1], wal[2], wal[3]]);
    if !WAL_MAGICS.contains(&magic) {
        return (committed, 0);
    }
    if u32::from_be_bytes([wal[8], wal[9], wal[10], wal[11]]) as usize != PAGE_SIZE {
        return (committed, 0);
    }
    let wal_salt = &wal[16..24];

    let mut pending: BTreeMap<u32, usize> = BTreeMap::new();
    let mut db_pages: u32 = 0;
    let mut off = WAL_HDR_SZ;
    loop {
        if off + WAL_FRAME_HDR_SZ > wal.len() {
            break;
        }
        let fh = &wal[off..off + WAL_FRAME_HDR_SZ];
        if &fh[8..16] != wal_salt {
            break;
        }
        let pgno = u32::from_be_bytes([fh[0], fh[1], fh[2], fh[3]]);
        let commit_size = u32::from_be_bytes([fh[4], fh[5], fh[6], fh[7]]);
        pending.insert(pgno, off + WAL_FRAME_HDR_SZ);
        if commit_size != 0 {
            committed.append(&mut pending);
            pending.clear();
            db_pages = commit_size;
        }
        off += WAL_FRAME_HDR_SZ + PAGE_SIZE;
    }
    (committed, db_pages)
}

/// 把加密库逐页解密为明文 SQLite 字节，叠加 WAL 已提交页，返回完整文件内容。
/// WAL 合并是必须的：新建分库后新消息可能只在 -wal 里，不合并就读不到。
pub fn decrypt_db(blob: &[u8], hex_key: &str, wal: Option<&[u8]>) -> Result<Vec<u8>> {
    let raw_key = hex_to_bytes(hex_key).ok_or_else(|| anyhow!("非法 hex 密钥"))?;
    if blob.len() < PAGE_SIZE {
        bail!("数据库文件过小");
    }
    let salt = &blob[..SALT_SZ];
    let (enc_key, _) = derive_keys(&raw_key, salt);

    let total_pages = blob.len() / PAGE_SIZE;
    let (frames, wal_db_pages) = match wal {
        Some(w) => wal_committed_frames(w),
        None => (BTreeMap::new(), 0),
    };

    // 输出页数要能容纳 WAL 里新增的高页号（主文件可能只有 1 页）。
    let out_pages = total_pages.max(wal_db_pages as usize);
    let mut out = vec![0u8; out_pages * PAGE_SIZE];

    for i in 0..total_pages {
        let pgno = (i + 1) as u32;
        if frames.contains_key(&pgno) {
            continue; // WAL 里有更新版本，稍后统一写
        }
        let page = &blob[i * PAGE_SIZE..(i + 1) * PAGE_SIZE];
        let dec = decrypt_page(&enc_key, page, pgno);
        out[i * PAGE_SIZE..(i + 1) * PAGE_SIZE].copy_from_slice(&dec);
    }

    if let Some(w) = wal {
        for (&pgno, &data_off) in &frames {
            if wal_db_pages != 0 && pgno > wal_db_pages {
                continue;
            }
            if data_off + PAGE_SIZE > w.len() {
                continue;
            }
            let page = &w[data_off..data_off + PAGE_SIZE];
            let dec = decrypt_page(&enc_key, page, pgno);
            let idx = (pgno - 1) as usize * PAGE_SIZE;
            out[idx..idx + PAGE_SIZE].copy_from_slice(&dec);
        }
    }

    if wal_db_pages != 0 {
        out.truncate(wal_db_pages as usize * PAGE_SIZE);
    }

    // 文件头 offset 18/19 = 读/写版本，2=WAL；改成 1（rollback），只读打开时不找 -wal。
    if out.len() > 19 {
        out[18] = 1;
        out[19] = 1;
    }
    Ok(out)
}

/// 便捷封装：从路径读源库（和同名 -wal）解密并写入 dst 路径。
pub fn decrypt_db_file(src: &std::path::Path, hex_key: &str, dst: &std::path::Path) -> Result<()> {
    let blob = read_file(src)?;
    let wal_path = append_suffix(src, "-wal");
    let wal = std::fs::read(&wal_path).ok();
    let out = decrypt_db(&blob, hex_key, wal.as_deref())?;
    std::fs::write(dst, out)?;
    Ok(())
}

fn read_file(p: &std::path::Path) -> Result<Vec<u8>> {
    let mut f = std::fs::File::open(p)?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    Ok(buf)
}

fn append_suffix(p: &std::path::Path, suffix: &str) -> std::path::PathBuf {
    let mut s = p.as_os_str().to_os_string();
    s.push(suffix);
    std::path::PathBuf::from(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cbc::cipher::{block_padding::NoPadding, BlockEncryptMut, KeyIvInit};

    type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;

    /// 按 SQLCipher-4 规格把明文造成密文页，供往返测试。
    fn encrypt(plaintext: &[u8], raw_key: &[u8], salt: &[u8]) -> Vec<u8> {
        let (enc_key, mac_key) = derive_keys(raw_key, salt);
        let n = plaintext.len() / PAGE_SIZE;
        let mut out = Vec::new();
        for i in 0..n {
            let l = &plaintext[i * PAGE_SIZE..(i + 1) * PAGE_SIZE];
            let start = if i == 0 { SALT_SZ } else { 0 };
            let content = &l[start..PAGE_SIZE - RESERVE];
            let iv = [((i as u8).wrapping_mul(7)).wrapping_add(1); IV_SZ];
            let mut buf = content.to_vec();
            Aes256CbcEnc::new(enc_key[..].into(), iv[..].into())
                .encrypt_padded_mut::<NoPadding>(&mut buf, content.len())
                .unwrap();
            let mut page = vec![0u8; PAGE_SIZE];
            if i == 0 {
                page[0..SALT_SZ].copy_from_slice(salt);
            }
            page[start..start + buf.len()].copy_from_slice(&buf);
            page[PAGE_SIZE - RESERVE..PAGE_SIZE - RESERVE + IV_SZ].copy_from_slice(&iv);
            let h = page_hmac(&mac_key, &page, (i + 1) as u32, start);
            let ho = PAGE_SIZE - RESERVE + IV_SZ;
            page[ho..ho + HMAC_SZ].copy_from_slice(&h);
            out.extend_from_slice(&page);
        }
        out
    }

    fn deterministic_bytes(n: usize, seed: u8) -> Vec<u8> {
        // 可复现的伪随机填充（xorshift，周期足够长，避免周期性误导），不引 rand 依赖。
        let mut v = Vec::with_capacity(n);
        let mut x: u32 = 0x9E37_79B9 ^ (seed as u32).wrapping_mul(2654435761);
        for _ in 0..n {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            v.push((x & 0xFF) as u8);
        }
        v
    }

    #[test]
    fn roundtrip_verify_and_decrypt() {
        let raw_key = deterministic_bytes(32, 3);
        let salt = deterministic_bytes(16, 9);
        let plain = deterministic_bytes(3 * PAGE_SIZE, 42);
        let enc = encrypt(&plain, &raw_key, &salt);
        assert_eq!(&enc[..SALT_SZ], &salt[..]);

        // verify_key 正确密钥通过，错误密钥失败
        assert!(verify_key(&enc[..PAGE_SIZE], &salt, &raw_key));
        let bad = deterministic_bytes(32, 200);
        assert!(!verify_key(&enc[..PAGE_SIZE], &salt, &bad));

        // enc_key 快筛路径也应通过
        let (enc_key, _) = derive_keys(&raw_key, &salt);
        assert!(verify_enc_key(&enc[..PAGE_SIZE], &salt, &enc_key));

        // 解密还原：第 1 页头被替成 SQLite 头，其余可用区一致
        let dec = decrypt_db(&enc, &bytes_to_hex(&raw_key), None).unwrap();
        assert_eq!(&dec[..16], &SQLITE_HEADER[..]);
        // 第 1 页可用区还原一致，但偏移 18/19 被版本补丁改成 1（真实库那是 SQLite 头字段）。
        assert_eq!(&dec[16..18], &plain[16..18]);
        assert_eq!(
            &dec[20..PAGE_SIZE - RESERVE],
            &plain[20..PAGE_SIZE - RESERVE]
        );
        for i in 1..3 {
            let a = i * PAGE_SIZE;
            assert_eq!(
                &dec[a..a + PAGE_SIZE - RESERVE],
                &plain[a..a + PAGE_SIZE - RESERVE]
            );
        }
        // 文件头版本已改 1
        assert_eq!(dec[18], 1);
        assert_eq!(dec[19], 1);
    }

    #[test]
    fn wal_parses_committed_frames_only() {
        // 构造一个两帧 WAL：帧1 未提交，帧2 提交（commit_size=2）。
        let salt = [0xABu8; 8];
        let mut wal = Vec::new();
        // header
        wal.extend_from_slice(&WAL_MAGICS[0].to_be_bytes());
        wal.extend_from_slice(&0u32.to_be_bytes()); // version
        wal.extend_from_slice(&(PAGE_SIZE as u32).to_be_bytes());
        wal.extend_from_slice(&0u32.to_be_bytes()); // checkpoint seq
        wal.extend_from_slice(&salt); // salt-1 + salt-2 (8 bytes)
        wal.extend_from_slice(&[0u8; 8]); // checksum
        assert_eq!(wal.len(), WAL_HDR_SZ);
        // frame 1: pgno=5, commit=0
        let frame = |pgno: u32, commit: u32| {
            let mut f = Vec::new();
            f.extend_from_slice(&pgno.to_be_bytes());
            f.extend_from_slice(&commit.to_be_bytes());
            f.extend_from_slice(&salt);
            f.extend_from_slice(&[0u8; 8]);
            f.extend_from_slice(&vec![0u8; PAGE_SIZE]);
            f
        };
        wal.extend_from_slice(&frame(5, 0));
        wal.extend_from_slice(&frame(6, 2));
        let (frames, db_pages) = wal_committed_frames(&wal);
        assert_eq!(db_pages, 2);
        assert!(frames.contains_key(&5));
        assert!(frames.contains_key(&6));
    }

    #[test]
    fn hex_roundtrip() {
        let b = deterministic_bytes(16, 1);
        assert_eq!(hex_to_bytes(&bytes_to_hex(&b)).unwrap(), b);
        assert!(hex_to_bytes("zz").is_none());
        assert!(hex_to_bytes("abc").is_none());
    }
}
