use serde::{Deserialize, Serialize};

/// 文件系统条目
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: Option<String>,
    pub extension: Option<String>,
    pub hidden: bool,
}

/// 目录列表
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub entries: Vec<FsEntry>,
}

/// 文件内容
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub encoding: String,
    pub size: u64,
    pub language: Option<String>,
}

/// 搜索结果
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub rel_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<u32>,
}
