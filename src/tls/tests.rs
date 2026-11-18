//! Unit tests for the TLS engine: a client and a server session driven
//! against each other in memory, the way `src/tls/tls.ts` drives them over a
//! socket pair.

use super::*;

const KEY: &[u8] = include_bytes!("testdata/agent1-key.pem");
const CERT: &[u8] = include_bytes!("testdata/agent1-cert.pem");
const CA: &[u8] = include_bytes!("testdata/ca1-cert.pem");

fn record(pairs: &[(&str, String)]) -> Options {
    let text: Vec<String> = pairs.iter().map(|(k, v)| format!("{k}{US}{v}")).collect();
    Options::parse(&text.join(&RS.to_string()))
}

fn pump(client: &mut Session, server: &mut Session) {
    for _ in 0..10 {
        let mut a = Vec::new();
        while client.conn.as_mut().unwrap().wants_write() {
            client.conn.as_mut().unwrap().write_tls(&mut a).unwrap();
        }
        let mut cur: &[u8] = &a;
        while !cur.is_empty() {
            server.conn.as_mut().unwrap().read_tls(&mut cur).unwrap();
            server.conn.as_mut().unwrap().process_new_packets().unwrap();
        }
        let mut b = Vec::new();
        while server.conn.as_mut().unwrap().wants_write() {
            server.conn.as_mut().unwrap().write_tls(&mut b).unwrap();
        }
        let mut cur: &[u8] = &b;
        while !cur.is_empty() {
            client.conn.as_mut().unwrap().read_tls(&mut cur).unwrap();
            client.conn.as_mut().unwrap().process_new_packets().unwrap();
        }
    }
}

fn server_opts() -> Options {
    record(&[
        ("cert", base64::encode(CERT)),
        ("key", base64::encode(KEY)),
        ("alpn", base64::encode(b"h2") + &GS.to_string() + &base64::encode(b"http/1.1")),
    ])
}

#[test]
fn handshake_and_data_with_trusted_ca() {
    let mut server = new_session(true, &server_opts()).unwrap();
    let client_opts = record(&[
        ("ca", base64::encode(CA)),
        ("servername", "agent1".to_owned()),
        ("alpn", base64::encode(b"http/1.1")),
    ]);
    let mut client = new_session(false, &client_opts).unwrap();
    client.conn.as_mut().unwrap().writer().write_all(b"hello").unwrap();
    pump(&mut client, &mut server);
    assert!(!client.conn.as_mut().unwrap().is_handshaking());
    assert!(client.verdict.lock().unwrap().is_none());
    assert_eq!(client.conn.as_mut().unwrap().alpn_protocol(), Some(&b"http/1.1"[..]));
    let mut buf = [0u8; 16];
    let n = server.conn.as_mut().unwrap().reader().read(&mut buf).unwrap();
    assert_eq!(&buf[..n], b"hello");
    if let Some(Connection::Server(s)) = &server.conn {
        assert_eq!(s.server_name(), Some("agent1"));
    }
}

#[test]
fn untrusted_chain_is_recorded_not_fatal() {
    let mut server = new_session(true, &server_opts()).unwrap();
    let mut client = new_session(false, &record(&[("servername", "agent1".to_owned())])).unwrap();
    pump(&mut client, &mut server);
    assert!(!client.conn.as_mut().unwrap().is_handshaking());
    let verdict = client.verdict.lock().unwrap().clone().unwrap();
    assert_eq!(verdict.0, "UNABLE_TO_VERIFY_LEAF_SIGNATURE");
}

#[test]
fn describes_a_certificate() {
    let der = parse_certs(CERT).unwrap().remove(0);
    let text = x509::describe(der.as_ref()).unwrap();
    let fields: Vec<&str> = text.split(US).collect();
    assert!(fields[0].contains("CN=agent1"));
    assert!(fields[1].contains("CN=ca1"));
    assert_eq!(fields[2], "Sep  3 21:40:37 2022 GMT");
    assert_eq!(fields[4], "147D36C1C2F74206DE9FAB5F2226D78ADB00A426");
    assert_eq!(fields[9], "2048");
    assert_eq!(fields[11], "0x10001");
}

#[test]
fn mismatched_key_is_rejected() {
    let ca_key_opts = record(&[("cert", base64::encode(CA)), ("key", base64::encode(KEY))]);
    assert!(new_session(true, &ca_key_opts).is_err());
}
