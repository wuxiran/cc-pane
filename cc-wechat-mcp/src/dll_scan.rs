//! 从 Weixin.dll 代码段提取 internal_db_key 候选（PE 解析 + 机器码模式匹配，跨平台可测）。
//!
//! 微信 4.x 内存里的原始密钥需与一个「内部密钥」XOR 后才是真正库密钥。该内部密钥以
//! 立即数编入 Weixin.dll 代码段：连续 4 条 `mov rdx, imm64`（48 BA + 8 字节），各间隔
//! 3~8 字节，最后紧跟 `test rax, rax`（48 85 C0）；4 个立即数拼成 32 字节即一个候选。
//! 手写 PE 解析（只需 section 表 + Characteristics），不引 goblin。

use anyhow::{bail, Result};
use std::path::{Path, PathBuf};

pub const KEY_SZ: usize = 32;
const IMAGE_SCN_CNT_CODE: u32 = 0x0000_0020;
const IMAGE_SCN_MEM_EXECUTE: u32 = 0x2000_0000;

/// 解析 PE，返回所有「代码/可执行」节的原始数据切片。非法 PE 返回 Err。
pub fn code_sections(blob: &[u8]) -> Result<Vec<&[u8]>> {
    if blob.len() < 0x40 || &blob[0..2] != b"MZ" {
        bail!("不是 PE 文件（缺 MZ）");
    }
    let e_lfanew = u32::from_le_bytes([blob[0x3C], blob[0x3D], blob[0x3E], blob[0x3F]]) as usize;
    if e_lfanew + 24 > blob.len() || &blob[e_lfanew..e_lfanew + 4] != b"PE\0\0" {
        bail!("不是 PE 文件（缺 PE 签名）");
    }
    let coff = e_lfanew + 4;
    let num_sections = u16::from_le_bytes([blob[coff + 2], blob[coff + 3]]) as usize;
    let size_opt_hdr = u16::from_le_bytes([blob[coff + 16], blob[coff + 17]]) as usize;
    let sect_table = coff + 20 + size_opt_hdr;

    let mut out = Vec::new();
    for i in 0..num_sections {
        let base = sect_table + i * 40;
        if base + 40 > blob.len() {
            break;
        }
        let sh = &blob[base..base + 40];
        let size_raw = u32::from_le_bytes([sh[16], sh[17], sh[18], sh[19]]) as usize;
        let ptr_raw = u32::from_le_bytes([sh[20], sh[21], sh[22], sh[23]]) as usize;
        let chars = u32::from_le_bytes([sh[36], sh[37], sh[38], sh[39]]);
        if chars & (IMAGE_SCN_CNT_CODE | IMAGE_SCN_MEM_EXECUTE) == 0 {
            continue;
        }
        if ptr_raw + size_raw <= blob.len() && size_raw > 0 {
            out.push(&blob[ptr_raw..ptr_raw + size_raw]);
        }
    }
    Ok(out)
}

/// 在一段机器码里扫描 internal_db_key 候选，去重保序。
pub fn scan_internal_keys(data: &[u8]) -> Vec<[u8; KEY_SZ]> {
    let mut keys = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut i = 0usize;
    while i + 10 <= data.len() {
        if data[i] == 0x48 && data[i + 1] == 0xBA {
            if let Some((key, end)) = try_match_at(data, i) {
                if seen.insert(key) {
                    keys.push(key);
                }
                i = end; // 非重叠，继续
                continue;
            }
        }
        i += 1;
    }
    keys
}

/// 从位置 i（指向第一个 48 BA）尝试匹配完整模式，成功返回 (32字节密钥, 匹配结束偏移)。
fn try_match_at(data: &[u8], i: usize) -> Option<([u8; KEY_SZ], usize)> {
    let mut key = [0u8; KEY_SZ];
    // 第一个立即数
    if i + 10 > data.len() {
        return None;
    }
    key[0..8].copy_from_slice(&data[i + 2..i + 10]);
    let mut pos = i + 10;

    // 再匹配 3 个 48 BA imm64，间隔 3~8（非贪婪 => 先试最短间隔）
    for slot in 1..4 {
        let mut matched = None;
        for gap in 3..=8usize {
            let p = pos + gap;
            if p + 10 <= data.len() && data[p] == 0x48 && data[p + 1] == 0xBA {
                key[slot * 8..slot * 8 + 8].copy_from_slice(&data[p + 2..p + 10]);
                matched = Some(p + 10);
                break;
            }
        }
        pos = matched?;
    }

    // 最后 48 85 C0
    for gap in 3..=8usize {
        let p = pos + gap;
        if p + 3 <= data.len() && data[p] == 0x48 && data[p + 1] == 0x85 && data[p + 2] == 0xC0 {
            return Some((key, p + 3));
        }
    }
    None
}

/// 扫描整个 DLL 文件的代码段，返回去重候选。
pub fn extract_internal_db_keys(dll_path: &Path) -> Result<Vec<[u8; KEY_SZ]>> {
    let blob = std::fs::read(dll_path)?;
    let mut keys = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for section in code_sections(&blob)? {
        for k in scan_internal_keys(section) {
            if seen.insert(k) {
                keys.push(k);
            }
        }
    }
    log::info!(
        "从 {} 提取到 {} 个 internal_db_key 候选",
        dll_path.display(),
        keys.len()
    );
    Ok(keys)
}

/// 按版本号从新到旧列出 base 下形如 `4.x.y` 的版本子目录。
#[cfg(windows)]
fn version_dirs(base: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = match std::fs::read_dir(base) {
        Ok(rd) => rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.is_dir()
                    && p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.chars().next().is_some_and(|c| c.is_ascii_digit()))
            })
            .collect(),
        Err(_) => return Vec::new(),
    };
    dirs.sort_by_key(|a| std::cmp::Reverse(ver_key(a))); // 倒序
    dirs
}

#[cfg(windows)]
fn ver_key(p: &Path) -> Vec<u32> {
    p.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .split('.')
        .map(|s| s.parse::<u32>().unwrap_or(0))
        .collect()
}

/// 定位 Weixin.dll。Windows 专属（注册表 + Program Files）。
#[cfg(windows)]
pub fn resolve_weixin_dll(install_path: Option<&str>) -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(p) = install_path {
        roots.push(PathBuf::from(p));
    }
    if let Some(p) = registry_install_path() {
        roots.push(PathBuf::from(p));
    }
    roots.push(PathBuf::from(r"C:\Program Files\Tencent\Weixin"));
    roots.push(PathBuf::from(r"C:\Program Files (x86)\Tencent\Weixin"));

    for root in roots {
        if !root.exists() {
            continue;
        }
        let direct = root.join("Weixin.dll");
        if direct.is_file() {
            return Some(direct);
        }
        for vd in version_dirs(&root) {
            let cand = vd.join("Weixin.dll");
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    log::warn!("未找到 Weixin.dll");
    None
}

#[cfg(windows)]
fn registry_install_path() -> Option<String> {
    let key = windows_registry::CURRENT_USER
        .open(r"SOFTWARE\Tencent\Weixin")
        .ok()?;
    key.get_string("InstallPath").ok()
}

#[cfg(not(windows))]
pub fn resolve_weixin_dll(_install_path: Option<&str>) -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_pattern(imms: [[u8; 8]; 4]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&[0x90, 0x90]); // 前导噪声
        for (i, imm) in imms.iter().enumerate() {
            v.extend_from_slice(&[0x48, 0xBA]);
            v.extend_from_slice(imm);
            if i < 3 {
                v.extend_from_slice(&[0x00, 0x11, 0x22]); // 3 字节间隔（最短）
            }
        }
        v.extend_from_slice(&[0x33, 0x44, 0x55]); // 3 字节间隔
        v.extend_from_slice(&[0x48, 0x85, 0xC0]); // test rax, rax
        v
    }

    #[test]
    fn scan_finds_32byte_key() {
        let imms = [
            [1, 2, 3, 4, 5, 6, 7, 8],
            [9, 10, 11, 12, 13, 14, 15, 16],
            [17, 18, 19, 20, 21, 22, 23, 24],
            [25, 26, 27, 28, 29, 30, 31, 32],
        ];
        let data = make_pattern(imms);
        let keys = scan_internal_keys(&data);
        assert_eq!(keys.len(), 1);
        let mut expect = [0u8; 32];
        for (i, imm) in imms.iter().enumerate() {
            expect[i * 8..i * 8 + 8].copy_from_slice(imm);
        }
        assert_eq!(keys[0], expect);
    }

    #[test]
    fn scan_rejects_incomplete_pattern() {
        // 只有 3 个 48 BA，缺第 4 个，应无命中
        let mut v = Vec::new();
        for _ in 0..3 {
            v.extend_from_slice(&[0x48, 0xBA]);
            v.extend_from_slice(&[0u8; 8]);
            v.extend_from_slice(&[0, 0, 0]);
        }
        v.extend_from_slice(&[0x48, 0x85, 0xC0]);
        assert!(scan_internal_keys(&v).is_empty());
    }

    #[test]
    fn parse_minimal_pe_code_section() {
        // 手工造一个单节 PE，节数据里埋一段模式。
        let imms = [[1u8; 8], [2u8; 8], [3u8; 8], [4u8; 8]];
        let section_data = make_pattern(imms);

        let e_lfanew = 0x40usize;
        let sect_table = e_lfanew + 4 + 20; // 无 optional header
        let data_off = sect_table + 40;

        let mut pe = vec![0u8; data_off];
        pe[0] = b'M';
        pe[1] = b'Z';
        pe[0x3C..0x40].copy_from_slice(&(e_lfanew as u32).to_le_bytes());
        pe[e_lfanew..e_lfanew + 4].copy_from_slice(b"PE\0\0");
        let coff = e_lfanew + 4;
        pe[coff + 2..coff + 4].copy_from_slice(&1u16.to_le_bytes()); // NumberOfSections
        pe[coff + 16..coff + 18].copy_from_slice(&0u16.to_le_bytes()); // SizeOfOptionalHeader
                                                                       // section header
        pe[sect_table..sect_table + 5].copy_from_slice(b".text");
        pe[sect_table + 16..sect_table + 20]
            .copy_from_slice(&(section_data.len() as u32).to_le_bytes()); // SizeOfRawData
        pe[sect_table + 20..sect_table + 24].copy_from_slice(&(data_off as u32).to_le_bytes()); // PointerToRawData
        pe[sect_table + 36..sect_table + 40]
            .copy_from_slice(&(IMAGE_SCN_CNT_CODE | IMAGE_SCN_MEM_EXECUTE).to_le_bytes());
        pe.extend_from_slice(&section_data);

        let sections = code_sections(&pe).unwrap();
        assert_eq!(sections.len(), 1);
        let keys = scan_internal_keys(sections[0]);
        assert_eq!(keys.len(), 1);
    }
}
