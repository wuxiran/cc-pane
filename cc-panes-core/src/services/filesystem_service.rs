use crate::constants::fs_limits::{MAX_DIR_ENTRIES, MAX_READ_SIZE, MAX_WRITE_SIZE};
use crate::models::filesystem::{DirListing, FileContent, FsEntry};
use crate::utils::AppResult;
use encoding_rs::Encoding;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use tracing::debug;

/// 只读目录前缀（这些目录下的文件不允许编辑）
const READONLY_PREFIXES: &[&str] = &["node_modules", ".git"];

pub struct FileSystemService;

impl Default for FileSystemService {
    fn default() -> Self {
        Self::new()
    }
}

impl FileSystemService {
    pub fn new() -> Self {
        Self
    }

    /// 校验路径安全性（路径沙箱）
    fn validate_path(path: &str) -> AppResult<PathBuf> {
        if path.is_empty() {
            return Err("Path cannot be empty".into());
        }
        let p = PathBuf::from(path);
        // 禁止路径穿越
        for component in p.components() {
            if let std::path::Component::ParentDir = component {
                return Err(format!("Path contains illegal '..' component: {}", path).into());
            }
        }
        let canonical = p
            .canonicalize()
            .map_err(|e| format!("Invalid path '{}': {}", path, e))?;
        // 确保不是系统关键路径
        #[cfg(windows)]
        {
            let path_str = canonical.to_string_lossy().to_lowercase();
            // 使用环境变量获取系统目录，不硬编码驱动器号
            let blocked: Vec<String> = [
                std::env::var("WINDIR").ok(),
                std::env::var("ProgramFiles").ok(),
                std::env::var("ProgramFiles(x86)").ok(),
                std::env::var("SystemRoot").ok(),
            ]
            .into_iter()
            .flatten()
            .map(|p| p.to_lowercase())
            .collect();
            for dir in &blocked {
                if path_str.starts_with(dir.as_str()) {
                    return Err("Access to system directories is not allowed".into());
                }
            }
        }
        Ok(canonical)
    }

    /// 判断是否隐藏（接受已有 metadata，避免重复 I/O）
    fn is_hidden_with_meta(
        name: &str,
        #[allow(unused_variables)] meta: Option<&fs::Metadata>,
    ) -> bool {
        if name.starts_with('.') {
            return true;
        }
        #[cfg(windows)]
        {
            if let Some(m) = meta {
                return Self::is_hidden_win_attr(m);
            }
        }
        false
    }

    /// Windows 隐藏属性检查（纯属性判断，无 I/O）
    #[cfg(windows)]
    fn is_hidden_win_attr(meta: &fs::Metadata) -> bool {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
    }

    /// 判断是否为只读路径（大小写不敏感，兼容 Windows）
    fn is_readonly_path(path: &Path) -> bool {
        for component in path.components() {
            if let std::path::Component::Normal(seg) = component {
                let seg_lower = seg.to_string_lossy().to_lowercase();
                for prefix in READONLY_PREFIXES {
                    if seg_lower == *prefix {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// 校验文件名合法性（跨平台）
    fn validate_filename(name: &str) -> AppResult<()> {
        if name.is_empty() {
            return Err("File name cannot be empty".into());
        }
        if name == "." || name == ".." {
            return Err("Invalid file name".into());
        }
        // Windows 禁止字符
        #[cfg(windows)]
        {
            let forbidden = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
            for ch in forbidden {
                if name.contains(ch) {
                    return Err(format!("File name cannot contain '{}'", ch).into());
                }
            }
            // Windows 保留名
            let reserved = [
                "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
                "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8",
                "LPT9",
            ];
            let upper = name.to_uppercase();
            let stem = upper.split('.').next().unwrap_or("");
            if reserved.contains(&stem) {
                return Err(format!("'{}' is a reserved name on Windows", name).into());
            }
        }
        #[cfg(not(windows))]
        {
            if name.contains('/') || name.contains('\0') {
                return Err("File name contains invalid characters".into());
            }
        }
        Ok(())
    }

    /// 从 DirEntry 构建 FsEntry（高效路径，list_directory 专用）
    /// DirEntry::metadata()/file_type() 在 Windows 上使用目录遍历缓存，不产生额外系统调用
    fn entry_from_dir_entry(entry: &fs::DirEntry) -> AppResult<FsEntry> {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        let file_type = entry.file_type()?;
        let is_symlink = file_type.is_symlink();

        let (is_dir, is_file, size, modified, hidden) = if is_symlink {
            // symlink 需要一次 fs::metadata 解析目标类型
            match fs::metadata(&path) {
                Ok(target_meta) => {
                    let mod_time = target_meta.modified().ok().map(|t| {
                        let dt: chrono::DateTime<chrono::Utc> = t.into();
                        dt.to_rfc3339()
                    });
                    let h = Self::is_hidden_with_meta(&name, Some(&target_meta));
                    (
                        target_meta.is_dir(),
                        target_meta.is_file(),
                        target_meta.len(),
                        mod_time,
                        h,
                    )
                }
                Err(_) => (false, false, 0, None, name.starts_with('.')), // 悬空 symlink
            }
        } else {
            // 非 symlink：DirEntry::metadata() 无额外系统调用
            let meta = entry.metadata()?;
            let mod_time = meta.modified().ok().map(|t| {
                let dt: chrono::DateTime<chrono::Utc> = t.into();
                dt.to_rfc3339()
            });
            let h = Self::is_hidden_with_meta(&name, Some(&meta));
            (meta.is_dir(), meta.is_file(), meta.len(), mod_time, h)
        };

        let extension = path.extension().map(|e| e.to_string_lossy().to_string());

        Ok(FsEntry {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            is_file,
            is_symlink,
            size,
            modified,
            extension,
            hidden,
        })
    }

    /// 从路径构建 FsEntry（用于 get_entry_info 等按路径查询的场景）
    fn entry_from_path(path: &Path) -> AppResult<FsEntry> {
        let meta = fs::symlink_metadata(path)?;
        let is_symlink = meta.is_symlink();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let modified = meta.modified().ok().map(|t| {
            let dt: chrono::DateTime<chrono::Utc> = t.into();
            dt.to_rfc3339()
        });
        let extension = path.extension().map(|e| e.to_string_lossy().to_string());

        let (is_dir, is_file, size, hidden) = if is_symlink {
            match fs::metadata(path) {
                Ok(target_meta) => {
                    let h = Self::is_hidden_with_meta(&name, Some(&target_meta));
                    (
                        target_meta.is_dir(),
                        target_meta.is_file(),
                        target_meta.len(),
                        h,
                    )
                }
                Err(_) => (false, false, 0, name.starts_with('.')),
            }
        } else {
            let h = Self::is_hidden_with_meta(&name, Some(&meta));
            (meta.is_dir(), meta.is_file(), meta.len(), h)
        };

        Ok(FsEntry {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            is_file,
            is_symlink,
            size,
            modified,
            extension,
            hidden,
        })
    }

    /// 根据文件扩展名推断 Monaco 语言
    fn detect_language(ext: &str) -> Option<String> {
        let lang = match ext.to_lowercase().as_str() {
            "ts" | "mts" | "cts" => "typescript",
            "tsx" => "typescriptreact",
            "js" | "mjs" | "cjs" => "javascript",
            "jsx" => "javascriptreact",
            "rs" => "rust",
            "py" | "pyw" => "python",
            "json" | "jsonc" => "json",
            "toml" => "ini", // Monaco 无原生 toml 支持，用 ini 近似
            "yaml" | "yml" => "yaml",
            "md" | "markdown" => "markdown",
            "html" | "htm" => "html",
            "css" => "css",
            "scss" => "scss",
            "less" => "less",
            "xml" | "svg" => "xml",
            "sql" => "sql",
            "sh" | "bash" | "zsh" => "shell",
            "ps1" | "psm1" => "powershell",
            "bat" | "cmd" => "bat",
            "c" | "h" => "c",
            "cpp" | "cc" | "cxx" | "hpp" => "cpp",
            "go" => "go",
            "java" => "java",
            "kt" | "kts" => "kotlin",
            "swift" => "swift",
            "rb" => "ruby",
            "php" => "php",
            "lua" => "lua",
            "dart" => "dart",
            "r" => "r",
            "ini" | "cfg" | "conf" => "ini",
            "dockerfile" => "dockerfile",
            "graphql" | "gql" => "graphql",
            _ => return None,
        };
        Some(lang.to_string())
    }

    // ===== 公开 API =====

    /// 列出一级目录内容
    pub fn list_directory(&self, path: &str, show_hidden: bool) -> AppResult<DirListing> {
        let dir_path = Self::validate_path(path)?;
        if !dir_path.is_dir() {
            return Err(format!("'{}' is not a directory", path).into());
        }

        let mut entries = Vec::new();
        let read_dir = fs::read_dir(&dir_path)?;

        for (count, entry_result) in read_dir.enumerate() {
            if count >= MAX_DIR_ENTRIES {
                break;
            }
            let dir_entry = match entry_result {
                Ok(e) => e,
                Err(_) => continue, // 跳过无权限的条目
            };
            // 快速隐藏检查：先查名字（零 I/O），再由 entry_from_dir_entry 查属性
            let name = dir_entry.file_name().to_string_lossy().to_string();
            if !show_hidden && name.starts_with('.') {
                continue;
            }
            match Self::entry_from_dir_entry(&dir_entry) {
                Ok(fs_entry) => {
                    if !show_hidden && fs_entry.hidden {
                        continue; // Windows 隐藏属性文件
                    }
                    entries.push(fs_entry);
                }
                Err(_) => continue, // 跳过无法读取的条目
            }
        }

        // 排序：目录在前，同类按字母排序（不区分大小写）
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(DirListing {
            path: dir_path.to_string_lossy().to_string(),
            entries,
        })
    }

    /// 读取文件内容
    pub fn read_file(&self, path: &str) -> AppResult<FileContent> {
        let file_path = Self::validate_path(path)?;
        if !file_path.is_file() {
            return Err(format!("'{}' is not a file", path).into());
        }

        let meta = fs::metadata(&file_path)?;
        if meta.len() > MAX_READ_SIZE {
            return Err(format!(
                "File too large ({:.1}MB). Maximum is {}MB",
                meta.len() as f64 / 1024.0 / 1024.0,
                MAX_READ_SIZE / 1024 / 1024
            )
            .into());
        }

        let mut raw = Vec::new();
        fs::File::open(&file_path)?.read_to_end(&mut raw)?;

        // 检测是否为二进制文件
        let is_binary = raw.iter().take(8192).any(|&b| b == 0);
        if is_binary {
            return Ok(FileContent {
                path: file_path.to_string_lossy().to_string(),
                content: String::new(),
                encoding: "binary".to_string(),
                size: meta.len(),
                language: None,
            });
        }

        // 编码检测
        let (encoding_name, content) = if let Ok(s) = std::str::from_utf8(&raw) {
            ("utf-8".to_string(), s.to_string())
        } else {
            let (detected, _, _) = Encoding::for_bom(&raw)
                .map(|(enc, _)| (enc, &raw[..], false))
                .unwrap_or_else(|| {
                    let det = encoding_rs::WINDOWS_1252; // fallback
                    (det, &raw[..], false)
                });
            let (decoded, _, _) = detected.decode(&raw);
            (detected.name().to_string(), decoded.into_owned())
        };

        let language = file_path
            .extension()
            .and_then(|e| e.to_str())
            .and_then(Self::detect_language);

        Ok(FileContent {
            path: file_path.to_string_lossy().to_string(),
            content,
            encoding: encoding_name,
            size: meta.len(),
            language,
        })
    }

    /// 写入文件
    pub fn write_file(&self, path: &str, content: &str) -> AppResult<()> {
        debug!("svc::write_file");
        let file_path = Self::validate_path(path)?;
        if Self::is_readonly_path(&file_path) {
            return Err("Cannot write to read-only path".into());
        }
        if content.len() > MAX_WRITE_SIZE {
            return Err(format!(
                "Content too large ({:.1}MB). Maximum is {}MB",
                content.len() as f64 / 1024.0 / 1024.0,
                MAX_WRITE_SIZE / 1024 / 1024
            )
            .into());
        }
        fs::write(&file_path, content)?;
        Ok(())
    }

    /// 创建空文件
    pub fn create_file(&self, path: &str) -> AppResult<()> {
        debug!("svc::create_file");
        let file_path = PathBuf::from(path);
        if let Some(name) = file_path.file_name().and_then(|n| n.to_str()) {
            Self::validate_filename(name)?;
        }
        if Self::is_readonly_path(&file_path) {
            return Err("Cannot create file in read-only path".into());
        }
        if file_path.exists() {
            return Err(format!("'{}' already exists", path).into());
        }
        if let Some(parent) = file_path.parent() {
            Self::validate_path(&parent.to_string_lossy())?;
        }
        fs::write(&file_path, "")?;
        Ok(())
    }

    /// 创建目录
    pub fn create_directory(&self, path: &str) -> AppResult<()> {
        debug!("svc::create_directory");
        let dir_path = PathBuf::from(path);
        if let Some(name) = dir_path.file_name().and_then(|n| n.to_str()) {
            Self::validate_filename(name)?;
        }
        if Self::is_readonly_path(&dir_path) {
            return Err("Cannot create directory in read-only path".into());
        }
        if dir_path.exists() {
            return Err(format!("'{}' already exists", path).into());
        }
        if let Some(parent) = dir_path.parent() {
            Self::validate_path(&parent.to_string_lossy())?;
        }
        fs::create_dir_all(&dir_path)?;
        Ok(())
    }

    /// 删除文件/目录（移到回收站）
    pub fn delete_entry(&self, path: &str) -> AppResult<()> {
        debug!("svc::delete_entry");
        let entry_path = Self::validate_path(path)?;
        if Self::is_readonly_path(&entry_path) {
            return Err("Cannot delete read-only path".into());
        }
        trash::delete(&entry_path).map_err(|e| format!("Failed to move to trash: {}", e))?;
        Ok(())
    }

    /// 重命名文件/目录
    pub fn rename_entry(&self, old_path: &str, new_name: &str) -> AppResult<()> {
        debug!("svc::rename_entry");
        Self::validate_filename(new_name)?;
        let source = Self::validate_path(old_path)?;
        if Self::is_readonly_path(&source) {
            return Err("Cannot rename read-only path".into());
        }
        let new_path = source
            .parent()
            .ok_or("Cannot determine parent directory")?
            .join(new_name);
        if new_path.exists() {
            return Err(format!("'{}' already exists", new_name).into());
        }
        fs::rename(&source, &new_path)?;
        Ok(())
    }

    /// 复制文件/目录
    pub fn copy_entry(&self, src: &str, dest_dir: &str) -> AppResult<()> {
        let source = Self::validate_path(src)?;
        let dest_parent = Self::validate_path(dest_dir)?;
        if !dest_parent.is_dir() {
            return Err(format!("Destination '{}' is not a directory", dest_dir).into());
        }
        // 防止复制目录到自身子目录（导致无限递归）
        if source.is_dir() && dest_parent.starts_with(&source) {
            return Err("Cannot copy a directory into itself".into());
        }
        let name = source.file_name().ok_or("Cannot determine source name")?;
        let dest = dest_parent.join(name);
        if dest.exists() {
            return Err(
                format!("'{}' already exists in destination", name.to_string_lossy()).into(),
            );
        }

        if source.is_dir() {
            Self::copy_dir_recursive(&source, &dest)?;
        } else {
            fs::copy(&source, &dest)?;
        }
        Ok(())
    }

    /// 移动文件/目录
    pub fn move_entry(&self, src: &str, dest_dir: &str) -> AppResult<()> {
        debug!("svc::move_entry");
        let source = Self::validate_path(src)?;
        if Self::is_readonly_path(&source) {
            return Err("Cannot move read-only path".into());
        }
        let dest_parent = Self::validate_path(dest_dir)?;
        if !dest_parent.is_dir() {
            return Err(format!("Destination '{}' is not a directory", dest_dir).into());
        }
        let name = source.file_name().ok_or("Cannot determine source name")?;
        let dest = dest_parent.join(name);
        if dest.exists() {
            return Err(
                format!("'{}' already exists in destination", name.to_string_lossy()).into(),
            );
        }
        // fs::rename 跨盘/跨文件系统会失败，降级为 copy + delete
        if fs::rename(&source, &dest).is_err() {
            if source.is_dir() {
                Self::copy_dir_recursive(&source, &dest)?;
                fs::remove_dir_all(&source)?;
            } else {
                fs::copy(&source, &dest)?;
                fs::remove_file(&source)?;
            }
        }
        Ok(())
    }

    /// 获取单个条目信息
    pub fn get_entry_info(&self, path: &str) -> AppResult<FsEntry> {
        let entry_path = Self::validate_path(path)?;
        Self::entry_from_path(&entry_path)
    }

    // ===== 内部工具方法 =====

    fn copy_dir_recursive(src: &Path, dest: &Path) -> AppResult<()> {
        fs::create_dir_all(dest)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            let dest_child = dest.join(entry.file_name());
            if entry.file_type()?.is_dir() {
                Self::copy_dir_recursive(&entry.path(), &dest_child)?;
            } else {
                fs::copy(entry.path(), &dest_child)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn svc() -> FileSystemService {
        FileSystemService::new()
    }

    fn path_str(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    // ===== validate_path =====

    #[test]
    fn validate_path_rejects_empty() {
        let err = svc().get_entry_info("").unwrap_err();
        assert!(err.message().contains("empty"));
    }

    #[test]
    fn validate_path_rejects_parent_dir_component() {
        let err = svc().get_entry_info("foo/../bar").unwrap_err();
        assert!(err.message().contains(".."));
    }

    #[test]
    fn validate_path_rejects_nonexistent() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("no-such-file.txt");
        let err = svc().get_entry_info(&path_str(&missing)).unwrap_err();
        assert!(err.message().contains("Invalid path"));
    }

    // ===== list_directory =====

    #[test]
    fn list_directory_sorts_dirs_first_then_case_insensitive() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("zeta")).unwrap();
        fs::create_dir(tmp.path().join("Alpha")).unwrap();
        fs::write(tmp.path().join("b.txt"), "b").unwrap();
        fs::write(tmp.path().join("A.txt"), "a").unwrap();

        let listing = svc().list_directory(&path_str(tmp.path()), false).unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["Alpha", "zeta", "A.txt", "b.txt"]);
        assert!(listing.entries[0].is_dir);
        assert!(listing.entries[2].is_file);
    }

    #[test]
    fn list_directory_filters_dotfiles_unless_show_hidden() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join(".hidden"), "h").unwrap();
        fs::write(tmp.path().join("visible.txt"), "v").unwrap();

        let dir = path_str(tmp.path());
        let without = svc().list_directory(&dir, false).unwrap();
        assert_eq!(without.entries.len(), 1);
        assert_eq!(without.entries[0].name, "visible.txt");

        let with = svc().list_directory(&dir, true).unwrap();
        let names: Vec<&str> = with.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&".hidden"));
        assert!(names.contains(&"visible.txt"));
    }

    #[test]
    fn list_directory_rejects_file_path() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("f.txt");
        fs::write(&file, "x").unwrap();
        let err = svc().list_directory(&path_str(&file), false).unwrap_err();
        assert!(err.message().contains("not a directory"));
    }

    // ===== read_file =====

    #[test]
    fn read_file_returns_utf8_content_and_language() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("main.rs");
        fs::write(&file, "fn main() {}").unwrap();

        let content = svc().read_file(&path_str(&file)).unwrap();
        assert_eq!(content.content, "fn main() {}");
        assert_eq!(content.encoding, "utf-8");
        assert_eq!(content.language.as_deref(), Some("rust"));
        assert_eq!(content.size, 12);
    }

    #[test]
    fn read_file_detects_language_by_extension() {
        let tmp = TempDir::new().unwrap();
        let cases = [
            ("a.py", Some("python")),
            ("a.tsx", Some("typescriptreact")),
            ("a.toml", Some("ini")),
            ("a.unknownext", None),
        ];
        for (name, expected) in cases {
            let file = tmp.path().join(name);
            fs::write(&file, "x").unwrap();
            let content = svc().read_file(&path_str(&file)).unwrap();
            assert_eq!(content.language.as_deref(), expected, "case: {}", name);
        }
    }

    #[test]
    fn read_file_marks_binary_and_omits_content() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("bin.dat");
        fs::write(&file, [0x41u8, 0x00, 0x42]).unwrap();

        let content = svc().read_file(&path_str(&file)).unwrap();
        assert_eq!(content.encoding, "binary");
        assert!(content.content.is_empty());
        assert_eq!(content.size, 3);
    }

    #[test]
    fn read_file_decodes_non_utf8_with_fallback() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("latin.txt");
        // 0xE9 = 'é' in windows-1252，不是合法 UTF-8
        fs::write(&file, [0x63u8, 0x61, 0x66, 0xE9]).unwrap();

        let content = svc().read_file(&path_str(&file)).unwrap();
        assert_eq!(content.encoding, "windows-1252");
        assert_eq!(content.content, "café");
    }

    #[test]
    fn read_file_rejects_directory() {
        let tmp = TempDir::new().unwrap();
        let err = svc().read_file(&path_str(tmp.path())).unwrap_err();
        assert!(err.message().contains("not a file"));
    }

    // ===== write_file =====

    #[test]
    fn write_file_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("out.txt");
        fs::write(&file, "").unwrap();

        svc().write_file(&path_str(&file), "hello").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "hello");
    }

    #[test]
    fn write_file_rejects_readonly_prefix() {
        let tmp = TempDir::new().unwrap();
        let nm = tmp.path().join("node_modules");
        fs::create_dir(&nm).unwrap();
        let file = nm.join("pkg.js");
        fs::write(&file, "x").unwrap();

        let err = svc().write_file(&path_str(&file), "y").unwrap_err();
        assert!(err.message().contains("read-only"));
    }

    // ===== create_file / create_directory =====

    #[test]
    fn create_file_creates_empty_file() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("new.txt");
        svc().create_file(&path_str(&file)).unwrap();
        assert!(file.is_file());
        assert_eq!(fs::read_to_string(&file).unwrap(), "");
    }

    #[test]
    fn create_file_rejects_existing() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("dup.txt");
        fs::write(&file, "x").unwrap();
        let err = svc().create_file(&path_str(&file)).unwrap_err();
        assert!(err.message().contains("already exists"));
    }

    #[cfg(windows)]
    #[test]
    fn create_file_rejects_windows_reserved_name() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("CON.txt");
        let err = svc().create_file(&path_str(&file)).unwrap_err();
        assert!(err.message().contains("reserved"));
    }

    #[test]
    fn create_directory_creates_and_rejects_existing() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("sub");
        svc().create_directory(&path_str(&dir)).unwrap();
        assert!(dir.is_dir());
        let err = svc().create_directory(&path_str(&dir)).unwrap_err();
        assert!(err.message().contains("already exists"));
    }

    // ===== rename_entry =====

    #[test]
    fn rename_entry_renames_file() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("old.txt");
        fs::write(&file, "data").unwrap();

        svc().rename_entry(&path_str(&file), "new.txt").unwrap();
        assert!(!file.exists());
        assert_eq!(
            fs::read_to_string(tmp.path().join("new.txt")).unwrap(),
            "data"
        );
    }

    #[test]
    fn rename_entry_rejects_existing_target() {
        let tmp = TempDir::new().unwrap();
        let a = tmp.path().join("a.txt");
        fs::write(&a, "a").unwrap();
        fs::write(tmp.path().join("b.txt"), "b").unwrap();

        let err = svc().rename_entry(&path_str(&a), "b.txt").unwrap_err();
        assert!(err.message().contains("already exists"));
    }

    #[test]
    fn rename_entry_rejects_invalid_name() {
        let tmp = TempDir::new().unwrap();
        let a = tmp.path().join("a.txt");
        fs::write(&a, "a").unwrap();

        assert!(svc().rename_entry(&path_str(&a), "..").is_err());
        assert!(svc().rename_entry(&path_str(&a), "").is_err());
    }

    // ===== copy_entry / move_entry =====

    #[test]
    fn copy_entry_copies_file() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src.txt");
        fs::write(&src, "content").unwrap();
        let dest_dir = tmp.path().join("dest");
        fs::create_dir(&dest_dir).unwrap();

        svc()
            .copy_entry(&path_str(&src), &path_str(&dest_dir))
            .unwrap();
        assert!(src.exists());
        assert_eq!(
            fs::read_to_string(dest_dir.join("src.txt")).unwrap(),
            "content"
        );
    }

    #[test]
    fn copy_entry_copies_directory_recursively() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("srcdir");
        fs::create_dir_all(src.join("nested")).unwrap();
        fs::write(src.join("nested").join("deep.txt"), "deep").unwrap();
        let dest_dir = tmp.path().join("dest");
        fs::create_dir(&dest_dir).unwrap();

        svc()
            .copy_entry(&path_str(&src), &path_str(&dest_dir))
            .unwrap();
        assert_eq!(
            fs::read_to_string(dest_dir.join("srcdir").join("nested").join("deep.txt")).unwrap(),
            "deep"
        );
    }

    #[test]
    fn copy_entry_rejects_copy_into_itself() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("srcdir");
        let inner = src.join("inner");
        fs::create_dir_all(&inner).unwrap();

        let err = svc()
            .copy_entry(&path_str(&src), &path_str(&inner))
            .unwrap_err();
        assert!(err.message().contains("into itself"));
    }

    #[test]
    fn copy_entry_rejects_existing_destination() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("f.txt");
        fs::write(&src, "x").unwrap();
        let dest_dir = tmp.path().join("dest");
        fs::create_dir(&dest_dir).unwrap();
        fs::write(dest_dir.join("f.txt"), "old").unwrap();

        let err = svc()
            .copy_entry(&path_str(&src), &path_str(&dest_dir))
            .unwrap_err();
        assert!(err.message().contains("already exists"));
    }

    #[test]
    fn move_entry_moves_file() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("mv.txt");
        fs::write(&src, "moved").unwrap();
        let dest_dir = tmp.path().join("dest");
        fs::create_dir(&dest_dir).unwrap();

        svc()
            .move_entry(&path_str(&src), &path_str(&dest_dir))
            .unwrap();
        assert!(!src.exists());
        assert_eq!(
            fs::read_to_string(dest_dir.join("mv.txt")).unwrap(),
            "moved"
        );
    }

    #[test]
    fn move_entry_rejects_readonly_source() {
        let tmp = TempDir::new().unwrap();
        let nm = tmp.path().join("node_modules");
        fs::create_dir(&nm).unwrap();
        let src = nm.join("pkg.js");
        fs::write(&src, "x").unwrap();
        let dest_dir = tmp.path().join("dest");
        fs::create_dir(&dest_dir).unwrap();

        let err = svc()
            .move_entry(&path_str(&src), &path_str(&dest_dir))
            .unwrap_err();
        assert!(err.message().contains("read-only"));
    }

    // ===== delete_entry（只测只读拒绝分支，避免真实回收站副作用）=====

    #[test]
    fn delete_entry_rejects_readonly_path() {
        let tmp = TempDir::new().unwrap();
        let git = tmp.path().join(".git");
        fs::create_dir(&git).unwrap();
        let file = git.join("HEAD");
        fs::write(&file, "ref").unwrap();

        let err = svc().delete_entry(&path_str(&file)).unwrap_err();
        assert!(err.message().contains("read-only"));
    }

    // ===== get_entry_info =====

    #[test]
    fn get_entry_info_returns_file_metadata() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("info.md");
        fs::write(&file, "hello").unwrap();

        let entry = svc().get_entry_info(&path_str(&file)).unwrap();
        assert_eq!(entry.name, "info.md");
        assert!(entry.is_file);
        assert!(!entry.is_dir);
        assert!(!entry.is_symlink);
        assert_eq!(entry.size, 5);
        assert_eq!(entry.extension.as_deref(), Some("md"));
        assert!(entry.modified.is_some());
        assert!(!entry.hidden);
    }

    #[test]
    fn get_entry_info_marks_dotfile_hidden() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join(".env");
        fs::write(&file, "K=V").unwrap();

        let entry = svc().get_entry_info(&path_str(&file)).unwrap();
        assert!(entry.hidden);
    }

    // ===== is_readonly_path 单元行为 =====

    #[test]
    fn is_readonly_path_matches_component_case_insensitively() {
        assert!(FileSystemService::is_readonly_path(Path::new(
            "proj/NODE_MODULES/pkg/index.js"
        )));
        assert!(FileSystemService::is_readonly_path(Path::new(
            "repo/.git/config"
        )));
        // 仅前缀相似不算命中
        assert!(!FileSystemService::is_readonly_path(Path::new(
            "proj/node_modules_backup/x"
        )));
    }
}
