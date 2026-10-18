use super::*;

pub(super) async fn fork_session(
    session: &AcpChatSession,
    source: &str,
    capabilities: Option<&Value>,
    cwd: &str,
    mcp_servers: &[Value],
) -> AppResult<(String, Value)> {
    request_fork(source, capabilities, cwd, mcp_servers, |params| {
        session.request("session/fork", params)
    })
    .await
}

async fn request_fork<F, Fut>(
    source: &str,
    capabilities: Option<&Value>,
    cwd: &str,
    mcp_servers: &[Value],
    request: F,
) -> AppResult<(String, Value)>
where
    F: FnOnce(Value) -> Fut,
    Fut: std::future::Future<Output = AppResult<Value>>,
{
    if !supports_fork(capabilities) {
        return Err(AppError::coded(
            "ACP_FORK_UNSUPPORTED",
            "This agent does not support independent conversation forks",
        ));
    }
    let response = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        request(json!({
            "sessionId": source, "cwd": cwd, "mcpServers": mcp_servers,
        })),
    )
    .await
    .map_err(|_| AppError::coded("ACP_HANDSHAKE_TIMEOUT", "ACP session/fork timed out"))??;
    let child = fork_id(source, &response)?;
    Ok((child, response))
}

fn supports_fork(capabilities: Option<&Value>) -> bool {
    capabilities
        .and_then(|v| v.pointer("/sessionCapabilities/fork"))
        .is_some_and(Value::is_object)
}

fn fork_id(source: &str, response: &Value) -> AppResult<String> {
    response
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty() && !id.eq_ignore_ascii_case(source.trim()))
        .map(str::to_owned)
        .ok_or_else(|| {
            AppError::coded(
                "ACP_FORK_INVALID",
                "Fork did not return an independent session ID",
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capability_is_explicit_and_child_identity_is_required() {
        assert!(supports_fork(Some(
            &json!({"sessionCapabilities":{"fork":{}}})
        )));
        for value in [
            json!({"loadSession":true}),
            json!({"sessionCapabilities":{"fork":null}}),
        ] {
            assert!(!supports_fork(Some(&value)));
        }
        assert_eq!(
            fork_id("parent", &json!({"sessionId":"child"})).unwrap(),
            "child"
        );
        for value in [
            json!({}),
            json!({"sessionId":"parent"}),
            json!({"sessionId":" PARENT "}),
            json!({"sessionId":" "}),
        ] {
            assert!(fork_id("parent", &value).is_err());
        }
    }
    #[tokio::test]
    async fn native_request_carries_source_and_destination_and_never_falls_back() {
        let capability = json!({"sessionCapabilities":{"fork":{}}});
        let result = request_fork(
            "parent",
            Some(&capability),
            "/new/worktree",
            &[],
            |params| async move {
                assert_eq!(
                    params,
                    json!({"sessionId":"parent", "cwd":"/new/worktree", "mcpServers":[]})
                );
                Ok(json!({"sessionId":"child"}))
            },
        )
        .await
        .unwrap();
        assert_eq!(result.0, "child");
        assert!(request_fork("parent", None, "/cwd", &[], |_| async {
            panic!("must not call unsupported agent")
        })
        .await
        .is_err());
        let error = request_fork("parent", Some(&capability), "/cwd", &[], |_| async {
            Err(AppError::from("source missing"))
        })
        .await
        .unwrap_err();
        assert!(error.to_string().contains("source missing"));
    }
}
