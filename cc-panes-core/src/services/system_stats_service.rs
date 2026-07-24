use crate::models::SystemStats;
use parking_lot::Mutex;
use sysinfo::System;

/// 按调用采样整机资源，不创建线程或定时任务。
pub struct SystemStatsService {
    system: Mutex<System>,
}

impl Default for SystemStatsService {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemStatsService {
    pub fn new() -> Self {
        Self {
            system: Mutex::new(System::new()),
        }
    }

    pub fn get_system_stats(&self) -> SystemStats {
        let mut system = self.system.lock();
        system.refresh_cpu_usage();
        system.refresh_memory();

        SystemStats {
            cpu_percent: system.global_cpu_usage(),
            mem_used: system.used_memory(),
            mem_total: system.total_memory(),
        }
    }
}
