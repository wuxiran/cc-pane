//! 公共工具函数

use std::time::SystemTime;

/// 获取当前日期字符串 (YYYY-MM-DD)
pub fn current_date() -> String {
    let (year, month, day, _, _, _) = now_components();
    format!("{:04}-{:02}-{:02}", year, month, day)
}

/// 获取当前时间的 ISO 8601 格式字符串
pub fn current_datetime() -> String {
    let (year, month, day, hours, minutes, seconds) = now_components();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        year, month, day, hours, minutes, seconds
    )
}

/// 获取当前时间的各个组件
fn now_components() -> (i32, u32, u32, u64, u64, u64) {
    let now = SystemTime::now();
    let duration = now
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();

    let days = secs / 86400;
    let time_secs = secs % 86400;
    let hours = time_secs / 3600;
    let minutes = (time_secs % 3600) / 60;
    let seconds = time_secs % 60;

    let (year, month, day) = days_to_ymd(days as i64);
    (year, month, day, hours, minutes, seconds)
}

/// 将天数转换为年月日
fn days_to_ymd(days: i64) -> (i32, u32, u32) {
    let mut remaining = days;
    let mut year = 1970i32;

    loop {
        let days_in_year = if is_leap_year(year) { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        year += 1;
    }

    let leap = is_leap_year(year);
    let month_days = if leap {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    let mut month = 1u32;
    for &d in &month_days {
        if remaining < d as i64 {
            break;
        }
        remaining -= d as i64;
        month += 1;
    }

    (year, month, (remaining + 1) as u32)
}

/// 判断是否为闰年
fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}
