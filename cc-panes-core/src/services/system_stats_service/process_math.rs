pub(super) fn cpu_percent_since(
    previous_time_100ns: u64,
    current_time_100ns: u64,
    elapsed: std::time::Duration,
) -> f32 {
    let elapsed_100ns = elapsed.as_secs_f64() * 10_000_000.0;
    if elapsed_100ns <= 0.0 {
        return 0.0;
    }
    let Some(delta) = current_time_100ns.checked_sub(previous_time_100ns) else {
        return 0.0;
    };
    (delta as f64 / elapsed_100ns * 100.0) as f32
}
