use serde::Serialize;

/// 整机 CPU 与内存统计。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    pub cpu_percent: f32,
    pub mem_used: u64,
    pub mem_total: u64,
}
