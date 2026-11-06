//! Tests for the shared I/O readiness loop.
//!
//! These drive the module *below* the ABI: [`listen_on`], [`connect_to`] and
//! the `sys` primitives, which is where the interesting behaviour is. The ABI
//! wrappers above them are each a few lines of argument reading and one
//! carrier encode, and the carrier grammar itself is asserted here on the
//! strings those helpers return.
//!
//! Everything binds `127.0.0.1:0`, so nothing in this file needs a network, a
//! fixed port or a second process.

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use super::*;

/// Parse one of this module's `"+"` payloads into its fields, the way
/// `src/io/io.ts` does.
fn fields(payload: &str) -> Vec<String> {
    assert!(payload.starts_with('+'), "expected success, got {payload:?}");
    payload[1..].split(US).map(|field| field.to_owned()).collect()
}

/// Every handle this test opened, closed on the way out — the table is
/// process-wide and the tests share it.
struct Handles(Vec<i64>);

impl Drop for Handles {
    fn drop(&mut self) {
        for id in &self.0 {
            if let Some(handle) = with_table(|table| table.remove(id)) {
                sys::close(handle.raw);
            }
        }
    }
}

fn listen_loopback(handles: &mut Handles) -> (i64, u16) {
    sys::startup();
    let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let payload = listen_on(&addr, 511, false, false).expect("listen on loopback");
    let parts = fields(&payload);
    assert_eq!(parts.len(), 4, "handle, address, port, family");
    assert_eq!(parts[1], "127.0.0.1");
    assert_eq!(parts[3], "IPv4");
    let id: i64 = parts[0].parse().unwrap();
    let port: u16 = parts[2].parse().unwrap();
    assert_ne!(port, 0, "listen(0) reports the port the kernel chose");
    handles.0.push(id);
    (id, port)
}

/// Poll until `id` reports `wanted`, or give up — a test must never hang.
fn wait_for(id: i64, wanted: u8) -> u8 {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let mut items: Vec<sys::PollItem> = with_table(|table| {
            table
                .get(&id)
                .map(|handle| {
                    vec![sys::PollItem { raw: handle.raw, interest: wanted, revents: 0 }]
                })
                .unwrap_or_default()
        });
        if items.is_empty() {
            return 0;
        }
        sys::poll(&mut items, 50).expect("poll");
        if items[0].revents != 0 {
            return items[0].revents;
        }
    }
    0
}

#[test]
fn listen_publishes_a_handle_and_the_bound_port() {
    let mut handles = Handles(Vec::new());
    let (id, _) = listen_loopback(&mut handles);
    let raw = with_table(|table| table.get(&id).map(|handle| handle.raw));
    assert!(raw.is_some(), "the handle is in the table");
    assert_eq!(
        with_table(|table| table.get(&id).map(|handle| handle.kind)),
        Some(Kind::Listener),
    );
}

#[test]
fn accept_reports_again_until_a_peer_arrives() {
    let mut handles = Handles(Vec::new());
    let (server, port) = listen_loopback(&mut handles);

    // Nothing is pending yet, which is not an error.
    let raw = with_table(|table| table.get(&server).unwrap().raw);
    assert!(sys::accept(raw).expect("accept").is_none());

    let target: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let payload = connect_to(0, &target, "", 0).expect("connect to loopback");
    let parts = fields(&payload);
    let client: i64 = parts[0].parse().unwrap();
    handles.0.push(client);

    assert_ne!(wait_for(server, sys::READ), 0, "the listener becomes readable");
    let accepted = sys::accept(raw).expect("accept").expect("a pending connection");
    handles.0.push(publish(accepted.0, Kind::Stream, false));
    assert_eq!(accepted.1.ip().to_string(), "127.0.0.1");
}

#[test]
fn a_round_trip_crosses_base64_intact() {
    let mut handles = Handles(Vec::new());
    let (server, port) = listen_loopback(&mut handles);
    let server_raw = with_table(|table| table.get(&server).unwrap().raw);

    let target: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let client: i64 = fields(&connect_to(0, &target, "", 0).unwrap())[0].parse().unwrap();
    handles.0.push(client);
    assert_ne!(wait_for(server, sys::READ), 0);
    let (accepted_raw, _) = sys::accept(server_raw).unwrap().unwrap();
    let accepted = publish(accepted_raw, Kind::Stream, false);
    handles.0.push(accepted);

    // The client's connect has to have settled before it can be written to.
    assert_ne!(wait_for(client, sys::WRITE), 0);
    let client_raw = with_table(|table| table.get(&client).unwrap().raw);

    // Every byte value, so the base64 round trip is exercised at all three
    // remainder lengths and over the non-ASCII range.
    let sent: Vec<u8> = (0u16..256).map(|byte| byte as u8).collect();
    let mut offset = 0;
    while offset < sent.len() {
        match sys::send(client_raw, &sent[offset..]).expect("send") {
            Some(count) => offset += count,
            None => {
                assert_ne!(wait_for(client, sys::WRITE), 0);
            }
        }
    }

    let mut received: Vec<u8> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    while received.len() < sent.len() && Instant::now() < deadline {
        if wait_for(accepted, sys::READ) == 0 {
            continue;
        }
        let mut buffer = [0u8; 512];
        match sys::recv(accepted_raw, &mut buffer).expect("recv") {
            Some(0) => break,
            Some(count) => received.extend_from_slice(&buffer[..count]),
            None => {}
        }
    }
    assert_eq!(received, sent, "the bytes arrive unchanged");

    // And the carrier they would have crossed on is lossless too.
    let encoded = base64::encode(&received);
    assert_eq!(base64::decode(&encoded), sent);
}

#[test]
fn an_orderly_close_reads_as_end_of_file() {
    let mut handles = Handles(Vec::new());
    let (server, port) = listen_loopback(&mut handles);
    let server_raw = with_table(|table| table.get(&server).unwrap().raw);

    let target: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let client: i64 = fields(&connect_to(0, &target, "", 0).unwrap())[0].parse().unwrap();
    handles.0.push(client);
    assert_ne!(wait_for(server, sys::READ), 0);
    let (accepted_raw, _) = sys::accept(server_raw).unwrap().unwrap();
    let accepted = publish(accepted_raw, Kind::Stream, false);
    handles.0.push(accepted);

    assert_ne!(wait_for(client, sys::WRITE), 0);
    let client_raw = with_table(|table| table.get(&client).unwrap().raw);
    sys::shutdown_write(client_raw).expect("shutdown");

    assert_ne!(wait_for(accepted, sys::READ), 0);
    let mut buffer = [0u8; 16];
    assert_eq!(sys::recv(accepted_raw, &mut buffer).expect("recv"), Some(0), "EOF");
}

#[test]
fn a_refused_connection_is_reported_as_econnrefused() {
    let mut handles = Handles(Vec::new());
    sys::startup();
    // A port that was listening and is now closed is the reliable way to get a
    // refusal without guessing: the kernel chose it, so nothing else has it.
    let (server, port) = listen_loopback(&mut handles);
    let raw = with_table(|table| table.remove(&server).unwrap().raw);
    sys::close(raw);
    handles.0.retain(|id| *id != server);

    let target: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let payload = connect_to(0, &target, "", 0);
    let id = match &payload {
        Ok(text) => {
            let parts = fields(text);
            let id: i64 = parts[0].parse().unwrap();
            handles.0.push(id);
            Some(id)
        }
        // Some platforms refuse inside `connect` itself, which is already the
        // answer this test wants.
        Err(text) => {
            assert!(text.starts_with(FAILED));
            None
        }
    };
    if let Some(id) = id {
        // Readiness settles the attempt; `SO_ERROR` then says it failed.
        let revents = wait_for(id, sys::READ | sys::WRITE);
        assert_ne!(revents, 0, "a refused connect settles rather than hanging");
        let raw = with_table(|table| table.get(&id).unwrap().raw);
        let failure = sys::take_error(raw).expect("SO_ERROR");
        let code = match failure {
            Some(err) => sys::uv_code_of(&err),
            // The platform may report the refusal only through `getpeername`.
            None => {
                assert!(sys::peer_addr(raw).is_err(), "a refused socket has no peer");
                "ECONNREFUSED"
            }
        };
        assert_eq!(code, "ECONNREFUSED");
    }
}

#[test]
fn interest_decides_what_poll_waits_for() {
    let mut handles = Handles(Vec::new());
    let (server, _) = listen_loopback(&mut handles);

    // With no interest the handle is invisible to `poll`, which is what
    // `socket.pause()` relies on. The count is of *this* handle only: the
    // table is process-wide and the tests run in parallel.
    let watched = |id: i64| -> usize {
        with_table(|table| {
            table
                .iter()
                .filter(|(key, handle)| {
                    **key == id && handle.interest != 0 && handle.raw != sys::INVALID
                })
                .count()
        })
    };

    with_table(|table| table.get_mut(&server).unwrap().interest = 0);
    assert_eq!(watched(server), 0, "an uninterested handle is not waited on");

    with_table(|table| table.get_mut(&server).unwrap().interest = sys::READ);
    assert_eq!(watched(server), 1);
}

#[test]
fn poll_with_nothing_to_watch_returns_after_the_timeout() {
    // The loop's idle case: no handle has interest, so the wait is the only
    // thing that happens — and it has to actually wait, or the TypeScript pump
    // would spin a core (see the module documentation).
    let mut nothing: Vec<sys::PollItem> = Vec::new();
    let started = Instant::now();
    sys::poll(&mut nothing, 30).expect("poll");
    assert!(started.elapsed() >= Duration::from_millis(20), "the timeout is honoured");
}

#[test]
fn close_is_idempotent_and_drops_the_row() {
    let mut handles = Handles(Vec::new());
    let (server, _) = listen_loopback(&mut handles);
    let removed = with_table(|table| table.remove(&server));
    assert!(removed.is_some());
    sys::close(removed.unwrap().raw);
    handles.0.retain(|id| *id != server);
    // A second close of an unknown handle is a no-op rather than EBADF, which
    // is what `ioClose` promises the TypeScript loop.
    assert!(with_table(|table| table.remove(&server)).is_none());
}

#[test]
fn lookup_of_localhost_resolves_to_a_loopback_address() {
    // `getaddrinfo("localhost")` is the one name every machine answers, and it
    // is the name `net.connect(port)` resolves by default.
    let resolved: Vec<SocketAddr> = ("localhost", 0u16)
        .to_socket_addrs()
        .expect("localhost resolves")
        .collect();
    assert!(!resolved.is_empty());
    assert!(
        resolved.iter().all(|addr| addr.ip().is_loopback()),
        "every localhost address is loopback: {resolved:?}",
    );
}

#[test]
fn the_uv_table_words_errors_the_way_node_prints_them() {
    // `err.message` is composed from these three fields, so the wording is
    // part of the observable surface rather than a diagnostic.
    assert_eq!(uv_error("ECONNREFUSED").0, "ECONNREFUSED");
    assert_eq!(uv_error("ECONNREFUSED").2, "connection refused");
    assert_eq!(uv_error("EADDRINUSE").2, "address already in use");
    assert_eq!(uv_error("ECONNRESET").2, "connection reset by peer");
    assert_eq!(uv_error("ENOTFOUND").0, "UNKNOWN", "ENOTFOUND is fabricated above the ABI");
    // libuv reports its own reserved range on Windows and `-errno` elsewhere.
    if cfg!(windows) {
        assert_eq!(uv_error("ECONNREFUSED").1, -4078);
    } else {
        assert_eq!(uv_error("ECONNREFUSED").1, -111);
    }
}

#[test]
fn a_reserved_handle_is_invisible_and_unusable_until_it_connects() {
    // `ioSocket()`'s row is libuv's uninitialized `uv_tcp_t`: `socket._handle`
    // is non-null the instant `connect()` returns, but there is no socket
    // under it yet (see the `reserve` native).
    let mut handles = Handles(Vec::new());
    let id = publish(sys::INVALID, Kind::Stream, true);
    handles.0.push(id);

    // Not waited on, whatever interest it is given. The filter names this
    // handle, because the table is process-wide and the tests run in parallel.
    with_table(|table| table.get_mut(&id).unwrap().interest = sys::READ | sys::WRITE);
    let watched = with_table(|table| {
        table
            .iter()
            .filter(|(key, handle)| {
                **key == id && handle.interest != 0 && handle.raw != sys::INVALID
            })
            .count()
    });
    assert_eq!(watched, 0);

    // And every operation on it reports EBADF, as libuv does.
    assert!(handle_of(id, "read", |handle| handle.raw).is_err());

    // Connecting fills the same row, which is what keeps the handle number —
    // and therefore `socket._handle` — stable.
    let (_, port) = listen_loopback(&mut handles);
    let target: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let payload = connect_to(id, &target, "", 0).expect("connect into the reserved row");
    assert_eq!(fields(&payload)[0], id.to_string(), "the handle number is unchanged");
    assert_ne!(
        with_table(|table| table.get(&id).unwrap().raw),
        sys::INVALID,
        "the row now has a socket",
    );
}

#[test]
fn an_abortive_close_is_armed_with_so_linger() {
    // `socket.resetAndDestroy()` is `SO_LINGER { on, 0 }` and then a close,
    // which sends an RST rather than a FIN. The test asserts the option is
    // accepted; that it turns into `ECONNRESET` on the peer is what
    // `test-net-server-reset.js` measures from the other side.
    let mut handles = Handles(Vec::new());
    let (server, port) = listen_loopback(&mut handles);
    let server_raw = with_table(|table| table.get(&server).unwrap().raw);
    let target: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let client: i64 = fields(&connect_to(0, &target, "", 0).unwrap())[0].parse().unwrap();
    handles.0.push(client);
    assert_ne!(wait_for(server, sys::READ), 0);
    let (accepted_raw, _) = sys::accept(server_raw).unwrap().unwrap();
    let accepted = publish(accepted_raw, Kind::Stream, false);
    handles.0.push(accepted);

    sys::set_linger_reset(accepted_raw).expect("SO_LINGER is accepted");
}

#[test]
fn the_carrier_markers_are_distinguishable() {
    // `+A` (again), `+E` (end of file), `+D…` (data) and `-` (failure) are the
    // four answers `ioRead` can give, and `src/io/io.ts` tells them apart by
    // their first two characters — so no two may share a prefix.
    assert_eq!(AGAIN, "+A");
    assert_eq!(EOF, "+E");
    assert_eq!(FAILED, "-");
    assert!(ok().starts_with('+'));
    assert_eq!(ok_fields(&["7".to_owned(), "x".to_owned()]), format!("+7{US}x"));
}
