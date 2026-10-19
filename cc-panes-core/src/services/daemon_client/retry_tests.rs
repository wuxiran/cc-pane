use super::*;
use std::net::TcpListener;
use std::thread;
use std::time::Instant;

fn accept(listener: &TcpListener) -> TcpStream {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                // macOS inherits the listener's nonblocking flag on accept.
                stream.set_nonblocking(false).unwrap();
                return stream;
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock && Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(2));
            }
            Err(error) => panic!("fixture accept failed: {error}"),
        }
    }
}

fn read_request(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut byte = [0];
    while !bytes.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
    }
    let headers = String::from_utf8(bytes.clone()).unwrap();
    let length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    let mut body = vec![0; length];
    stream.read_exact(&mut body).unwrap();
    bytes.extend(body);
    String::from_utf8(bytes).unwrap()
}

fn lost_response_server(listener: TcpListener) -> Vec<String> {
    let mut stream = accept(&listener);
    assert!(read_request(&mut stream).starts_with("GET /api/health "));
    stream
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
        .unwrap();
    // The daemon consumed this input, but its response never reached the client.
    let mut applied = vec![read_request(&mut stream)];
    drop(stream);

    let mut stream = accept(&listener);
    let next = read_request(&mut stream);
    if next.starts_with("POST ") {
        // Serve an erroneous automatic retry so the regression fails promptly
        // on its duplicate-input assertion instead of hanging on a timeout.
        applied.push(next);
        stream
            .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
            .unwrap();
        drop(stream);
        stream = accept(&listener);
        assert!(read_request(&mut stream).starts_with("GET /api/health "));
    } else {
        assert!(next.starts_with("GET /api/health "));
    }
    stream
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
        .unwrap();
    applied
}

fn assert_input_not_replayed(
    send: impl FnOnce(&TerminalDaemonClient) -> AppResult<()>,
    expected_path: &str,
    expected_body: &str,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let client = TerminalDaemonClient::new(listener.local_addr().unwrap().to_string(), "fixture")
        .with_timeout(Duration::from_secs(2));
    let server = thread::spawn(move || lost_response_server(listener));
    client.health().unwrap(); // Put a live connection in the pool.
    let result = send(&client);
    let recovery = client.health(); // An explicit later request can reconnect.
    let applied = server.join().unwrap();
    let error = result.expect_err("a lost response has an unknown outcome");
    assert_eq!(error.code(), Some("DAEMON_REQUEST_OUTCOME_UNKNOWN"));
    assert!(error.message().contains("may already have been applied"));
    assert!(recovery.is_ok(), "failed connection must leave the pool");
    assert_eq!(applied.len(), 1, "terminal input must not be replayed");
    assert!(applied[0].starts_with(&format!("POST {expected_path} ")));
    assert!(applied[0].ends_with(expected_body));
}

#[test]
fn round4_lost_write_response_does_not_repeat_terminal_input() {
    assert_input_not_replayed(
        |client| client.write_session("session", "echo once\n"),
        "/api/sessions/session/write",
        r#"{"data":"echo once\n"}"#,
    );
}

#[test]
fn round4_lost_submit_response_does_not_repeat_prompt() {
    assert_input_not_replayed(
        |client| client.submit_text_to_session("session", "run once"),
        "/api/sessions/session/submit",
        r#"{"text":"run once"}"#,
    );
}
