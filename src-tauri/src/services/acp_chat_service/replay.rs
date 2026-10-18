//! A load response is a transaction boundary for the agent's streamed history.
//! Failed, timed out or cancelled loads must discard provisional replay content.
use crate::utils::AppResult;
use std::future::Future;

struct ReplayBoundary<F: Fn(&str)> {
    emit: F,
    committed: bool,
}

impl<F: Fn(&str)> Drop for ReplayBoundary<F> {
    fn drop(&mut self) {
        if !self.committed {
            (self.emit)("abort");
        }
    }
}

pub(super) async fn load<T, F, Fut>(emit: F, request: Fut) -> AppResult<T>
where
    F: Fn(&str),
    Fut: Future<Output = AppResult<T>>,
{
    let mut boundary = ReplayBoundary {
        emit,
        committed: false,
    };
    (boundary.emit)("begin");
    let result = request.await?;
    boundary.committed = true;
    (boundary.emit)("commit");
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::AppError;
    use std::{sync::Mutex, time::Duration};

    #[tokio::test]
    async fn successful_replay_commits_after_updates() {
        let events = Mutex::new(Vec::new());
        load(
            |phase| events.lock().unwrap().push(phase.to_string()),
            async {
                events.lock().unwrap().push("update".into());
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(*events.lock().unwrap(), ["begin", "update", "commit"]);
    }

    #[tokio::test]
    async fn failed_replay_aborts_before_fallback() {
        let events = Mutex::new(Vec::new());
        let result: AppResult<()> = load(
            |phase| events.lock().unwrap().push(phase.to_string()),
            async {
                events.lock().unwrap().push("update".into());
                Err(AppError::coded("ACP_AGENT_ERROR", "load rejected"))
            },
        )
        .await;
        assert!(result.is_err());
        events.lock().unwrap().push("fallback".into());
        assert_eq!(
            *events.lock().unwrap(),
            ["begin", "update", "abort", "fallback"]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn dropping_a_timed_out_replay_aborts_its_updates() {
        let events = Mutex::new(Vec::new());
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            load(
                |phase| events.lock().unwrap().push(phase.to_string()),
                async {
                    events.lock().unwrap().push("update".into());
                    std::future::pending::<AppResult<()>>().await
                },
            ),
        )
        .await;
        assert!(result.is_err());
        assert_eq!(*events.lock().unwrap(), ["begin", "update", "abort"]);
    }
}
