//! Named, fallible runtime threads. Never use `thread::spawn` for production work:
//! its allocation/OS failure panics and can take down every terminal in the process.

use std::io;
use std::thread::{Builder, JoinHandle};

pub fn spawn_named<F, T>(name: &str, task: F) -> io::Result<JoinHandle<T>>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    #[cfg(test)]
    if FAIL_NEXT.with(|flag| flag.replace(false)) {
        return Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            format!("injected thread creation failure: {name}"),
        ));
    }
    Builder::new().name(name.to_owned()).spawn(task).map_err(|error| {
        tracing::error!(thread_name = name, error = %error, os_error = ?error.raw_os_error(), "failed to create runtime thread");
        error
    })
}

/// Optional background work may be skipped, but its degradation must remain visible.
pub fn spawn_optional(name: &str, task: impl FnOnce() + Send + 'static) {
    if let Err(error) = spawn_named(name, task) {
        tracing::warn!(thread_name = name, %error, "optional background task disabled for this run");
    }
}

#[cfg(test)]
thread_local! { static FAIL_NEXT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }

#[cfg(test)]
pub(crate) fn fail_next_spawn() {
    FAIL_NEXT.with(|flag| flag.set(true));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn issue64_thread_exhaustion_is_an_error_and_drops_task_resources() {
        let owned = std::sync::Arc::new(());
        let task_owned = owned.clone();
        fail_next_spawn();
        let failure = spawn_named("fixture", move || drop(task_owned)).unwrap_err();
        assert_eq!(failure.kind(), io::ErrorKind::WouldBlock);
        assert_eq!(std::sync::Arc::strong_count(&owned), 1);
        // No real resource exhaustion and no globally persistent test fault.
        assert_eq!(
            spawn_named("after-fixture", || 42).unwrap().join().unwrap(),
            42
        );
    }
}
