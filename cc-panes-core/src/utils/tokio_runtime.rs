//! tokio 多线程运行时的 worker 线程数收口。
//!
//! daemon / cc-panes-web 之前都用 `#[tokio::main]` 默认值（= 逻辑核数），
//! 32 核机器上一个几乎只做 I/O 转发的进程就起 32 条 worker；再叠 PTY reader、
//! reaper 等线程，36 会话时 daemon 线程数接近 150。这里统一钳到 2..=8，
//! 默认 4，可用环境变量 `CC_PANES_TOKIO_WORKERS` 覆盖（非法值回落默认）。

/// 覆盖 worker 数的环境变量名。
pub const TOKIO_WORKERS_ENV: &str = "CC_PANES_TOKIO_WORKERS";
/// 未设置环境变量时的 worker 数。
pub const TOKIO_WORKERS_DEFAULT: usize = 4;
/// 钳位下限：低于 2 时 blocking 回调与 WS 推送互相饿死。
pub const TOKIO_WORKERS_MIN: usize = 2;
/// 钳位上限：I/O 转发型进程超过 8 条 worker 只增加调度开销。
pub const TOKIO_WORKERS_MAX: usize = 8;

/// 由环境变量原值计算 worker 数：缺省 / 空 / 非数字 → 默认 4，其余钳到 2..=8。
pub fn tokio_worker_threads(raw: Option<&str>) -> usize {
    let requested = raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(TOKIO_WORKERS_DEFAULT);
    requested.clamp(TOKIO_WORKERS_MIN, TOKIO_WORKERS_MAX)
}

/// 读取当前进程环境得到 worker 数。
pub fn tokio_worker_threads_from_env() -> usize {
    tokio_worker_threads(std::env::var(TOKIO_WORKERS_ENV).ok().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_when_unset_or_invalid() {
        assert_eq!(tokio_worker_threads(None), TOKIO_WORKERS_DEFAULT);
        assert_eq!(tokio_worker_threads(Some("")), TOKIO_WORKERS_DEFAULT);
        assert_eq!(tokio_worker_threads(Some("  ")), TOKIO_WORKERS_DEFAULT);
        assert_eq!(tokio_worker_threads(Some("abc")), TOKIO_WORKERS_DEFAULT);
        assert_eq!(tokio_worker_threads(Some("-3")), TOKIO_WORKERS_DEFAULT);
    }

    #[test]
    fn clamps_into_range() {
        assert_eq!(tokio_worker_threads(Some("0")), TOKIO_WORKERS_MIN);
        assert_eq!(tokio_worker_threads(Some("1")), TOKIO_WORKERS_MIN);
        assert_eq!(tokio_worker_threads(Some("2")), 2);
        assert_eq!(tokio_worker_threads(Some(" 6 ")), 6);
        assert_eq!(tokio_worker_threads(Some("8")), 8);
        assert_eq!(tokio_worker_threads(Some("64")), TOKIO_WORKERS_MAX);
    }
}
