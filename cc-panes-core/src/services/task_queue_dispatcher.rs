use std::sync::Arc;

use crate::models::task_queue::{QueueItemState, TaskQueueReason, TaskQueueState};
use crate::services::{AutomaticWriteAuthority, SessionStateMachine, TerminalBackend};
use crate::utils::error::{AppError, AppResult};

use super::terminal_service::SessionStatus;
use super::TaskQueueService;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskQueueReadiness {
    Ready,
    GlobalDisabled,
    ConfirmingIdle,
    WaitingInput,
    AutomaticWriteUnavailable,
    SessionError,
    SessionExited,
}

#[derive(Debug)]
pub enum TaskQueueSubmitFailure {
    NotReady(TaskQueueReadiness),
    Definite(AppError),
    DeliveryUnknown(AppError),
}

pub trait TaskQueueDispatchGateway: Send + Sync {
    fn readiness(&self, session_id: &str) -> AppResult<TaskQueueReadiness>;
    fn submit_text(&self, session_id: &str, prompt: &str) -> Result<(), TaskQueueSubmitFailure>;
    fn mark_submit_started(&self, session_id: &str);
}

pub struct BackendTaskQueueDispatchGateway {
    backend: Arc<dyn TerminalBackend>,
    state_machine: Arc<SessionStateMachine>,
}

impl BackendTaskQueueDispatchGateway {
    pub fn new(backend: Arc<dyn TerminalBackend>, state_machine: Arc<SessionStateMachine>) -> Self {
        Self {
            backend,
            state_machine,
        }
    }
}

impl TaskQueueDispatchGateway for BackendTaskQueueDispatchGateway {
    fn readiness(&self, session_id: &str) -> AppResult<TaskQueueReadiness> {
        let Some(status) = self.backend.get_session_status(session_id)? else {
            return Ok(TaskQueueReadiness::SessionExited);
        };
        let effective = self.state_machine.status_for_automatic_submit(
            session_id,
            status.status,
            status.last_output_at,
        );
        match effective {
            SessionStatus::Idle => {
                let authority = self.backend.automatic_write_authority(session_id)?;
                if matches!(authority, AutomaticWriteAuthority::Unavailable) {
                    Ok(TaskQueueReadiness::AutomaticWriteUnavailable)
                } else {
                    Ok(TaskQueueReadiness::Ready)
                }
            }
            SessionStatus::WaitingInput => Ok(TaskQueueReadiness::WaitingInput),
            SessionStatus::Error => Ok(TaskQueueReadiness::SessionError),
            SessionStatus::Exited => Ok(TaskQueueReadiness::SessionExited),
            _ => Ok(TaskQueueReadiness::ConfirmingIdle),
        }
    }

    fn submit_text(&self, session_id: &str, prompt: &str) -> Result<(), TaskQueueSubmitFailure> {
        let readiness = self
            .readiness(session_id)
            .map_err(TaskQueueSubmitFailure::Definite)?;
        if readiness != TaskQueueReadiness::Ready {
            return Err(TaskQueueSubmitFailure::NotReady(readiness));
        }
        self.backend
            .submit_text_to_session(session_id, prompt)
            .map_err(TaskQueueSubmitFailure::DeliveryUnknown)
    }

    fn mark_submit_started(&self, session_id: &str) {
        self.state_machine.mark_automatic_submit_started(session_id);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskQueueDispatchOutcome {
    Noop,
    Blocked(TaskQueueReadiness),
    Submitted {
        item_id: String,
    },
    Requeued {
        item_id: String,
        readiness: TaskQueueReadiness,
    },
    Failed {
        item_id: String,
    },
    DeliveryUnknown {
        item_id: String,
    },
}

pub struct TaskQueueDispatcher {
    service: Arc<TaskQueueService>,
    gateway: Arc<dyn TaskQueueDispatchGateway>,
}

impl TaskQueueDispatcher {
    pub fn new(service: Arc<TaskQueueService>, gateway: Arc<dyn TaskQueueDispatchGateway>) -> Self {
        Self { service, gateway }
    }

    pub fn check_session(&self, session_id: &str, now: i64) -> AppResult<TaskQueueDispatchOutcome> {
        let repository = self.service.repository();
        let runtime = repository.runtime()?;
        if !runtime.enabled {
            return Ok(TaskQueueDispatchOutcome::Blocked(
                TaskQueueReadiness::GlobalDisabled,
            ));
        }

        let snapshot = self.service.snapshot(session_id)?;
        let Some(head) = snapshot.items.first() else {
            return Ok(TaskQueueDispatchOutcome::Noop);
        };
        if snapshot.paused || head.state != QueueItemState::Queued {
            return Ok(TaskQueueDispatchOutcome::Noop);
        }

        let readiness = self.gateway.readiness(session_id)?;
        if readiness != TaskQueueReadiness::Ready {
            self.persist_readiness(session_id, readiness, now)?;
            return Ok(TaskQueueDispatchOutcome::Blocked(readiness));
        }

        let Some(claim) = repository.claim_next(session_id, runtime.dispatch_generation, now)?
        else {
            return Ok(TaskQueueDispatchOutcome::Noop);
        };

        let second_readiness = match self.runtime_blocker(claim.dispatch_generation)? {
            Some(readiness) => readiness,
            None => self.gateway.readiness(session_id)?,
        };
        if second_readiness != TaskQueueReadiness::Ready {
            return self.requeue_for_readiness(
                session_id,
                &claim.item.id,
                &claim.token,
                second_readiness,
                now,
            );
        }

        let prompt = match self.service.effective_prompt(session_id, &claim.item) {
            Ok(prompt) => prompt,
            Err(error) => {
                self.fail_claim(session_id, &claim.item.id, &claim.token, &error, now)?;
                return Ok(TaskQueueDispatchOutcome::Failed {
                    item_id: claim.item.id,
                });
            }
        };

        if let Some(readiness) = self.runtime_blocker(claim.dispatch_generation)? {
            return self.requeue_for_readiness(
                session_id,
                &claim.item.id,
                &claim.token,
                readiness,
                now,
            );
        }

        match self.gateway.submit_text(session_id, &prompt) {
            Ok(()) => {
                self.gateway.mark_submit_started(session_id);
                if !self
                    .service
                    .complete_claim(session_id, &claim.item.id, &claim.token, now)?
                {
                    return Err(AppError::coded(
                        "QUEUE_CLAIM_CONFLICT",
                        "Acknowledged task queue claim is no longer current",
                    ));
                }
                Ok(TaskQueueDispatchOutcome::Submitted {
                    item_id: claim.item.id,
                })
            }
            Err(TaskQueueSubmitFailure::NotReady(readiness)) => {
                self.requeue_for_readiness(session_id, &claim.item.id, &claim.token, readiness, now)
            }
            Err(TaskQueueSubmitFailure::Definite(error)) => {
                self.fail_claim(session_id, &claim.item.id, &claim.token, &error, now)?;
                Ok(TaskQueueDispatchOutcome::Failed {
                    item_id: claim.item.id,
                })
            }
            Err(TaskQueueSubmitFailure::DeliveryUnknown(error)) => {
                if !repository.mark_delivery_unknown(
                    session_id,
                    &claim.item.id,
                    &claim.token,
                    error.message(),
                    now,
                )? {
                    return Err(AppError::coded(
                        "QUEUE_CLAIM_CONFLICT",
                        "Unknown-delivery task queue claim is no longer current",
                    ));
                }
                Ok(TaskQueueDispatchOutcome::DeliveryUnknown {
                    item_id: claim.item.id,
                })
            }
        }
    }

    fn runtime_blocker(&self, dispatch_generation: i64) -> AppResult<Option<TaskQueueReadiness>> {
        let runtime = self.service.repository().runtime()?;
        Ok(if !runtime.enabled {
            Some(TaskQueueReadiness::GlobalDisabled)
        } else if runtime.dispatch_generation != dispatch_generation {
            Some(TaskQueueReadiness::ConfirmingIdle)
        } else {
            None
        })
    }

    fn requeue_for_readiness(
        &self,
        session_id: &str,
        item_id: &str,
        token: &str,
        readiness: TaskQueueReadiness,
        now: i64,
    ) -> AppResult<TaskQueueDispatchOutcome> {
        self.requeue_claim(session_id, item_id, token, now)?;
        self.persist_readiness(session_id, readiness, now)?;
        Ok(TaskQueueDispatchOutcome::Requeued {
            item_id: item_id.to_owned(),
            readiness,
        })
    }

    fn requeue_claim(
        &self,
        session_id: &str,
        item_id: &str,
        token: &str,
        now: i64,
    ) -> AppResult<()> {
        if self
            .service
            .repository()
            .return_claim_to_queue(session_id, item_id, token, now)?
        {
            Ok(())
        } else {
            Err(AppError::coded(
                "QUEUE_CLAIM_CONFLICT",
                "Task queue claim is no longer current",
            ))
        }
    }

    fn fail_claim(
        &self,
        session_id: &str,
        item_id: &str,
        token: &str,
        error: &AppError,
        now: i64,
    ) -> AppResult<()> {
        let code = error.code().unwrap_or("SUBMIT_FAILED");
        if self.service.repository().fail_claim(
            session_id,
            item_id,
            token,
            code,
            error.message(),
            now,
        )? {
            Ok(())
        } else {
            Err(AppError::coded(
                "QUEUE_CLAIM_CONFLICT",
                "Failed task queue claim is no longer current",
            ))
        }
    }

    fn persist_readiness(
        &self,
        session_id: &str,
        readiness: TaskQueueReadiness,
        now: i64,
    ) -> AppResult<()> {
        let (state, reason) = match readiness {
            TaskQueueReadiness::Ready => (TaskQueueState::Running, None),
            TaskQueueReadiness::GlobalDisabled => return Ok(()),
            TaskQueueReadiness::ConfirmingIdle => (TaskQueueState::ConfirmingIdle, None),
            TaskQueueReadiness::WaitingInput => (
                TaskQueueState::ActionRequired,
                Some(TaskQueueReason::WaitingInput),
            ),
            TaskQueueReadiness::AutomaticWriteUnavailable => (
                TaskQueueState::ActionRequired,
                Some(TaskQueueReason::AutomaticWriteUnavailable),
            ),
            TaskQueueReadiness::SessionError => (
                TaskQueueState::ActionRequired,
                Some(TaskQueueReason::SessionError),
            ),
            TaskQueueReadiness::SessionExited => (
                TaskQueueState::SessionEnded,
                Some(TaskQueueReason::SessionExited),
            ),
        };
        self.service
            .repository()
            .set_runtime_status(session_id, state, reason, now)?;
        Ok(())
    }
}
