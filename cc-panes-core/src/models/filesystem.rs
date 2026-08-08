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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<String>,
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFileContent {
    pub path: String,
    pub data_base64: String,
    pub mime_type: String,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileSearchResult {
    pub paths: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectContentMatch {
    pub path: String,
    pub line: usize,
    pub preview: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectContentSearchResult {
    pub matches: Vec<ProjectContentMatch>,
    pub truncated: bool,
    pub timed_out: bool,
}
