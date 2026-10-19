//! Reapplying a policy must target the inherited priority, never add another +5.
use crate::models::{PolicyOutcome, SessionResourcePolicy};

pub(super) fn read(pid: u32) -> Result<i32, String> {
    if pid == 0 {
        return Err("PTY has no process id".into());
    }
    errno::set_errno(errno::Errno(0));
    // SAFETY: getpriority reads a numeric PID; -1 is valid when errno remains zero.
    let current = unsafe { libc::getpriority(libc::PRIO_PROCESS, pid) };
    let error = errno::errno();
    if current == -1 && error.0 != 0 {
        Err(format!(
            "getpriority: {}",
            std::io::Error::from_raw_os_error(error.0)
        ))
    } else {
        Ok(current)
    }
}

pub(super) fn apply(
    pid: u32,
    inherited: Option<i32>,
    policy: &SessionResourcePolicy,
) -> PolicyOutcome {
    apply_with(
        inherited,
        policy,
        || read(pid),
        |target| {
            // SAFETY: only the PTY's nonzero PID is passed, and no pointer is dereferenced.
            if unsafe { libc::setpriority(libc::PRIO_PROCESS, pid, target) } == 0 {
                Ok(())
            } else {
                Err(format!("setpriority: {}", std::io::Error::last_os_error()))
            }
        },
    )
}

fn apply_with(
    inherited: Option<i32>,
    policy: &SessionResourcePolicy,
    read: impl FnOnce() -> Result<i32, String>,
    set: impl FnOnce(i32) -> Result<(), String>,
) -> PolicyOutcome {
    let Some(inherited) = inherited else {
        return PolicyOutcome::degraded("could not read the PTY's inherited priority");
    };
    let target = super::unix_nice_target(inherited, policy.nice_increment().unwrap_or(0));
    let result = read().and_then(|current| {
        if current == target {
            Ok(())
        } else {
            set(target)
        }
    });
    if let Err(error) = result {
        return PolicyOutcome::degraded(error);
    }
    if policy.eco_qos
        || policy.effective_cpu_weight().is_some()
        || policy.memory_notify_bytes.is_some()
    {
        return PolicyOutcome::degraded("Unix applies nice only; CPU weight, EcoQoS and Job memory notifications require Windows");
    }
    PolicyOutcome::Applied
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn repeated_lower_priority_does_not_accumulate_and_failures_are_reported() {
        let policy = SessionResourcePolicy {
            lower_priority: true,
            ..SessionResourcePolicy::disabled()
        };
        let current = Cell::new(3);
        let writes = Cell::new(0);
        for _ in 0..10 {
            assert_eq!(
                apply_with(
                    Some(3),
                    &policy,
                    || Ok(current.get()),
                    |n| {
                        writes.set(writes.get() + 1);
                        current.set(n);
                        Ok(())
                    }
                ),
                PolicyOutcome::Applied
            );
        }
        assert_eq!((current.get(), writes.get()), (8, 1));
        assert!(matches!(
            apply_with(
                Some(3),
                &policy,
                || Err("gone".into()),
                |_| panic!("must not set")
            ),
            PolicyOutcome::Degraded { .. }
        ));
        assert!(matches!(
            apply_with(Some(3), &policy, || Ok(3), |_| Err("denied".into())),
            PolicyOutcome::Degraded { .. }
        ));
    }

    #[test]
    fn neutral_policy_is_noop_at_baseline_and_reports_a_failed_restore() {
        let policy = SessionResourcePolicy::disabled();
        assert_eq!(
            apply_with(Some(3), &policy, || Ok(3), |_| panic!("already normal")),
            PolicyOutcome::Applied
        );
        let outcome = apply_with(
            Some(3),
            &policy,
            || Ok(8),
            |target| {
                assert_eq!(target, 3);
                Err("permission denied restoring priority".into())
            },
        );
        assert!(matches!(outcome, PolicyOutcome::Degraded { .. }));
    }

    #[test]
    fn unsupported_fields_never_report_fully_applied() {
        for policy in [
            SessionResourcePolicy {
                eco_qos: true,
                ..SessionResourcePolicy::disabled()
            },
            SessionResourcePolicy {
                cpu_weight: Some(1),
                ..SessionResourcePolicy::disabled()
            },
            SessionResourcePolicy {
                memory_notify_bytes: Some(1024),
                ..SessionResourcePolicy::disabled()
            },
        ] {
            assert!(matches!(
                apply_with(Some(0), &policy, || Ok(0), |_| Ok(())),
                PolicyOutcome::Degraded { .. }
            ));
        }
        assert!(read(0).is_err());
        assert!(matches!(
            apply(0, None, &SessionResourcePolicy::default()),
            PolicyOutcome::Degraded { .. }
        ));
    }

    #[test]
    fn native_child_priority_remains_stable_after_reapplication() {
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let child = Child(
            std::process::Command::new("/bin/sleep")
                .arg("30")
                .spawn()
                .unwrap(),
        );
        let pid = child.0.id();
        let base = read(pid).unwrap();
        let policy = SessionResourcePolicy {
            lower_priority: true,
            ..SessionResourcePolicy::disabled()
        };
        for _ in 0..3 {
            assert_eq!(apply(pid, Some(base), &policy), PolicyOutcome::Applied);
            assert_eq!(read(pid).unwrap(), super::super::unix_nice_target(base, 5));
        }
    }
}
