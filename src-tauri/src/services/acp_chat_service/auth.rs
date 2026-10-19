//! Authentication retries the operation the user actually requested. In
//! particular, authenticating a load must not replace it with session/new.
use super::*;

pub(super) async fn retry<T, F, Fut>(
    session: &AcpChatSession,
    initialize: &Value,
    request: F,
) -> AppResult<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = AppResult<T>>,
{
    retry_operation(request, |error| authenticate(session, initialize, error)).await
}

async fn retry_operation<T, F, Fut, A, Auth>(mut request: F, authenticate: A) -> AppResult<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = AppResult<T>>,
    A: FnOnce(AppError) -> Auth,
    Auth: std::future::Future<Output = AppResult<()>>,
{
    match request().await {
        Err(error) if is_auth_required(&error) => {
            authenticate(error).await?;
            request().await
        }
        result => result,
    }
}

async fn authenticate(
    session: &AcpChatSession,
    initialize: &Value,
    original: AppError,
) -> AppResult<()> {
    let methods = initialize
        .get("authMethods")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for method in &methods {
        // ACP terminal authentication is a separate interactive process. The
        // client does not advertise `clientCapabilities.auth.terminal`, and
        // MUST NOT send its descriptor through the protocol `authenticate`
        // request (ACP v1 authentication §terminal).
        if method.get("type").and_then(Value::as_str) == Some("terminal") {
            continue;
        }
        let Some(id) = method.get("id").and_then(Value::as_str) else {
            continue;
        };
        match tokio::time::timeout(
            HANDSHAKE_TIMEOUT,
            session.request("authenticate", json!({"methodId": id})),
        )
        .await
        {
            Ok(Ok(_)) => {
                session.emit(
                    "notification",
                    json!({"method":"ccpanes/authenticated", "params":{"methodId":id}}),
                );
                return Ok(());
            }
            Ok(Err(error)) => {
                debug!(chat_id = %session.chat_id, method_id = id, %error, "ACP authenticate rejected")
            }
            Err(_) => {
                debug!(chat_id = %session.chat_id, method_id = id, "ACP authenticate timed out")
            }
        }
    }
    let names = methods
        .iter()
        .filter_map(|method| {
            method
                .get("name")
                .or_else(|| method.get("id"))
                .and_then(Value::as_str)
        })
        .collect::<Vec<_>>();
    Err(AppError::coded(
        "ACP_AUTH_REQUIRED",
        if names.is_empty() {
            original.to_string()
        } else {
            format!(
                "{original}\n该引擎需要先登录，可用方式：{}。请在终端里完成登录后重试。",
                names.join(" / ")
            )
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[tokio::test]
    async fn authentication_retries_the_same_operation_once() {
        let calls = Cell::new(0);
        let auth_calls = Cell::new(0);
        let value = retry_operation(
            || {
                let attempt = calls.get();
                calls.set(attempt + 1);
                async move {
                    if attempt == 0 {
                        Err(AppError::coded("ACP_AUTH_REQUIRED", "login"))
                    } else {
                        Ok("original-session")
                    }
                }
            },
            |_| async {
                auth_calls.set(auth_calls.get() + 1);
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(value, "original-session");
        assert_eq!(calls.get(), 2);
        assert_eq!(auth_calls.get(), 1);
    }

    #[tokio::test]
    async fn failed_login_does_not_retry_or_create_a_different_operation() {
        let calls = Cell::new(0);
        let error = retry_operation::<(), _, _, _, _>(
            || {
                calls.set(calls.get() + 1);
                async { Err(AppError::coded("ACP_AUTH_REQUIRED", "login")) }
            },
            |_| async { Err(AppError::coded("ACP_AUTH_REQUIRED", "denied")) },
        )
        .await
        .unwrap_err();
        assert_eq!(error.code(), Some("ACP_AUTH_REQUIRED"));
        assert_eq!(calls.get(), 1);
    }

    #[tokio::test]
    async fn ordinary_request_errors_do_not_start_authentication() {
        let result = retry_operation::<(), _, _, _, _>(
            || async { Err(AppError::coded("ACP_AGENT_ERROR", "session not found")) },
            |_| async { panic!("must not authenticate unrelated failures") },
        )
        .await;
        assert_eq!(result.unwrap_err().code(), Some("ACP_AGENT_ERROR"));
    }
}
