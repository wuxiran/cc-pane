//! Coalesce tray updates on a single background worker per burst. In particular,
//! the leading update must not query the daemon on an event/UI callback thread.
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub(super) struct TrayRefresh {
    state: Mutex<State>,
    throttle: Duration,
}

struct State {
    running: bool,
    dirty: bool,
    last_started: Instant,
}

impl TrayRefresh {
    pub(super) fn new(throttle: Duration) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                running: false,
                dirty: false,
                last_started: Instant::now() - throttle,
            }),
            throttle,
        })
    }

    pub(super) fn request(self: &Arc<Self>, rebuild: impl Fn() + Send + 'static) {
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.dirty = true;
            if state.running {
                return;
            }
            state.running = true;
        }
        let worker = self.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("ccpanes-tray-refresh".into())
            .spawn(move || worker.run(rebuild))
        {
            self.state.lock().unwrap_or_else(|e| e.into_inner()).running = false;
            tracing::warn!(%error, "Failed to start tray refresh thread");
        }
    }

    fn run(&self, rebuild: impl Fn()) {
        loop {
            let delay = {
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                if !state.dirty {
                    state.running = false;
                    return;
                }
                self.throttle.saturating_sub(state.last_started.elapsed())
            };
            std::thread::sleep(delay);
            {
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                state.dirty = false;
                state.last_started = Instant::now();
            }
            // Never hold the scheduling lock across daemon I/O or AppKit dispatch.
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(&rebuild)).is_err() {
                self.state.lock().unwrap_or_else(|e| e.into_inner()).running = false;
                tracing::warn!("Tray refresh panicked; a later event can retry");
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn slow_leading_refresh_is_off_thread_and_events_coalesce_without_overlap() {
        let scheduler = TrayRefresh::new(Duration::from_millis(1));
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let caller = std::thread::current().id();
        scheduler.request(move || {
            started_tx.send(std::thread::current().id()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        });
        assert_ne!(
            started_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            caller
        );
        for _ in 0..100 {
            scheduler.request(|| panic!("existing worker must own the rebuild"));
        }
        assert!(started_rx.try_recv().is_err());
        release_tx.send(()).unwrap();
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        release_tx.send(()).unwrap();
        assert!(started_rx.recv_timeout(Duration::from_millis(50)).is_err());
    }
}
