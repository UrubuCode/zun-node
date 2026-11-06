//! Unit tests for the `node:dns` natives.
//!
//! Three groups, and the split is deliberate. The *wire format* is tested
//! against hand-assembled messages, because that is the half with no
//! environment in it: a byte sequence in, records out, no network and no
//! resolver configuration. The *system resolver* is tested only on what holds
//! on every machine — the loopback address resolves to itself, a reserved
//! name does not resolve — because anything stronger would be asserting the
//! tester's DNS. The *configuration* reader is tested for shape.

use super::resolve::{
    decode_answers, encode_name, encode_query, parse_servers, TYPE_A, TYPE_ANY, TYPE_MX, TYPE_SOA,
    TYPE_TXT,
};
use super::{ok_fields, ok_records, parse_ip, sys, RS, US};

// ---------------------------------------------------------------------------
// The carrier
// ---------------------------------------------------------------------------

#[test]
fn ok_records_joins_with_the_separators() {
    let records = vec![
        vec!["1.2.3.4".to_owned(), "60".to_owned()],
        vec!["5.6.7.8".to_owned(), "60".to_owned()],
    ];
    let encoded = ok_records(&records);
    assert_eq!(encoded, format!("+1.2.3.4{US}60{RS}5.6.7.8{US}60"));
}

#[test]
fn an_empty_record_list_is_a_bare_plus() {
    let empty: Vec<Vec<String>> = Vec::new();
    assert_eq!(ok_records(&empty), "+");
}

#[test]
fn ok_fields_is_one_record() {
    assert_eq!(ok_fields(&["host".to_owned(), "ssh".to_owned()]), format!("+host{US}ssh"));
}

#[test]
fn parse_ip_accepts_only_inet_pton_forms() {
    assert!(parse_ip("127.0.0.1").is_some());
    assert!(parse_ip("::1").is_some());
    assert!(parse_ip("2001:4860:4860::8888").is_some());
    // No zone, no port, no trailing text, no leading space.
    assert!(parse_ip("fe80::1%eth0").is_none());
    assert!(parse_ip("127.0.0.1:53").is_none());
    assert!(parse_ip(" 127.0.0.1").is_none());
    assert!(parse_ip("").is_none());
}

#[test]
fn parse_servers_reads_the_record_grammar() {
    let list = format!("8.8.8.8{US}53{RS}[::1] bad{RS}2001:4860:4860::8888{US}5353");
    let parsed = parse_servers(&list);
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].to_string(), "8.8.8.8:53");
    assert_eq!(parsed[1].port(), 5353);
}

// ---------------------------------------------------------------------------
// The wire format
// ---------------------------------------------------------------------------

#[test]
fn encode_name_is_length_prefixed_labels() {
    assert_eq!(encode_name("a.bc").unwrap(), vec![1, b'a', 2, b'b', b'c', 0]);
    // A trailing dot is the root and adds nothing.
    assert_eq!(encode_name("a.bc.").unwrap(), encode_name("a.bc").unwrap());
    // The root alone is one zero byte.
    assert_eq!(encode_name("").unwrap(), vec![0]);
    // An empty label and an over-long one are not representable.
    assert!(encode_name("a..b").is_none());
    assert!(encode_name(&"x".repeat(64)).is_none());
    assert!(encode_name(&vec!["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; 10].join(".")).is_none());
}

#[test]
fn encode_query_sets_one_question_and_recursion_desired() {
    let question = encode_name("example.org").unwrap();
    let message = encode_query(0x1234, &question, TYPE_A);
    assert_eq!(&message[0..2], &[0x12, 0x34]);
    assert_eq!(&message[2..4], &[0x01, 0x00]); // RD=1, nothing else
    assert_eq!(&message[4..6], &[0x00, 0x01]); // QDCOUNT = 1
    assert_eq!(&message[6..12], &[0; 6]); // no answers in a query
    assert_eq!(&message[12..12 + question.len()], &question[..]);
    let tail = &message[12 + question.len()..];
    assert_eq!(tail, &[0x00, 0x01, 0x00, 0x01]); // QTYPE=A QCLASS=IN
}

/// Assemble a response for `example.org` with the given answer records, so the
/// parser is driven by real bytes rather than by a mock.
fn response(answers: &[(u16, u32, Vec<u8>)]) -> Vec<u8> {
    let question = encode_name("example.org").unwrap();
    let mut message = Vec::new();
    message.extend_from_slice(&0x1234u16.to_be_bytes());
    message.extend_from_slice(&[0x81, 0x80]); // QR=1 RD=1 RA=1 RCODE=0
    message.extend_from_slice(&1u16.to_be_bytes());
    message.extend_from_slice(&(answers.len() as u16).to_be_bytes());
    message.extend_from_slice(&0u16.to_be_bytes());
    message.extend_from_slice(&0u16.to_be_bytes());
    message.extend_from_slice(&question);
    message.extend_from_slice(&TYPE_A.to_be_bytes());
    message.extend_from_slice(&1u16.to_be_bytes());
    for (rtype, ttl, rdata) in answers {
        // The owner name as a pointer to the question's, which is what a real
        // server sends and what exercises the decompressor.
        message.extend_from_slice(&[0xc0, 0x0c]);
        message.extend_from_slice(&rtype.to_be_bytes());
        message.extend_from_slice(&1u16.to_be_bytes());
        message.extend_from_slice(&ttl.to_be_bytes());
        message.extend_from_slice(&(rdata.len() as u16).to_be_bytes());
        message.extend_from_slice(rdata);
    }
    message
}

#[test]
fn decode_a_records() {
    let message = response(&[(TYPE_A, 300, vec![1, 2, 3, 4]), (TYPE_A, 300, vec![5, 6, 7, 8])]);
    let records = decode_answers(&message, TYPE_A).unwrap();
    assert_eq!(
        records,
        vec![
            vec!["1.2.3.4".to_owned(), "300".to_owned()],
            vec!["5.6.7.8".to_owned(), "300".to_owned()],
        ]
    );
}

#[test]
fn decode_mx_follows_a_compression_pointer_in_the_rdata() {
    // priority 42, then a pointer back to `example.org` in the question.
    let rdata = vec![0x00, 0x2a, 0xc0, 0x0c];
    let message = response(&[(TYPE_MX, 60, rdata)]);
    let records = decode_answers(&message, TYPE_MX).unwrap();
    assert_eq!(records, vec![vec!["42".to_owned(), "example.org".to_owned(), "60".to_owned()]]);
}

#[test]
fn decode_txt_splits_the_character_strings() {
    let mut rdata = vec![3];
    rdata.extend_from_slice(b"abc");
    rdata.push(2);
    rdata.extend_from_slice(b"de");
    let message = response(&[(TYPE_TXT, 7, rdata)]);
    let records = decode_answers(&message, TYPE_TXT).unwrap();
    assert_eq!(records, vec![vec!["7".to_owned(), "abc".to_owned(), "de".to_owned()]]);
}

#[test]
fn decode_soa_reads_all_five_counters() {
    let mut rdata = encode_name("ns1.example.com").unwrap();
    rdata.extend_from_slice(&encode_name("admin.example.com").unwrap());
    rdata.extend_from_slice(&3210987654u32.to_be_bytes());
    rdata.extend_from_slice(&900u32.to_be_bytes());
    rdata.extend_from_slice(&900u32.to_be_bytes());
    rdata.extend_from_slice(&1800u32.to_be_bytes());
    rdata.extend_from_slice(&3333333333u32.to_be_bytes());
    let message = response(&[(TYPE_SOA, 0, rdata)]);
    let records = decode_answers(&message, TYPE_SOA).unwrap();
    assert_eq!(
        records,
        vec![vec![
            "ns1.example.com".to_owned(),
            "admin.example.com".to_owned(),
            "3210987654".to_owned(),
            "900".to_owned(),
            "900".to_owned(),
            "1800".to_owned(),
            "3333333333".to_owned(),
        ]]
    );
}

#[test]
fn an_any_query_prefixes_every_record_with_its_type() {
    let message = response(&[(TYPE_A, 0, vec![1, 2, 3, 4])]);
    let records = decode_answers(&message, TYPE_ANY).unwrap();
    assert_eq!(records, vec![vec!["A".to_owned(), "1.2.3.4".to_owned(), "0".to_owned()]]);
}

#[test]
fn an_answer_of_another_type_is_not_reported() {
    let message = response(&[(TYPE_TXT, 0, vec![0])]);
    assert_eq!(decode_answers(&message, TYPE_A), Err("ENODATA"));
}

#[test]
fn rcodes_become_the_c_ares_codes_node_reports() {
    for (rcode, expected) in
        [(1u8, "EFORMERR"), (2, "ESERVFAIL"), (3, "ENOTFOUND"), (4, "ENOTIMP"), (5, "EREFUSED")]
    {
        let mut message = response(&[]);
        message[3] = 0x80 | rcode;
        assert_eq!(decode_answers(&message, TYPE_A), Err(expected));
    }
}

#[test]
fn an_empty_answer_section_is_enodata() {
    assert_eq!(decode_answers(&response(&[]), TYPE_A), Err("ENODATA"));
}

#[test]
fn a_truncated_record_is_ebadresp_rather_than_a_panic() {
    let mut message = response(&[(TYPE_A, 0, vec![1, 2, 3, 4])]);
    message.truncate(message.len() - 2);
    assert_eq!(decode_answers(&message, TYPE_A), Err("EBADRESP"));
}

#[test]
fn a_compression_loop_terminates() {
    // A pointer at offset 12 that points at itself: the owner-name read must
    // give up rather than spin.
    let mut message = response(&[(TYPE_A, 0, vec![1, 2, 3, 4])]);
    message[12] = 0xc0;
    message[13] = 0x0c;
    assert!(decode_answers(&message, TYPE_A).is_err());
}

// ---------------------------------------------------------------------------
// The system resolver and the machine's configuration
// ---------------------------------------------------------------------------

#[test]
fn getaddrinfo_resolves_a_literal_to_itself() {
    // Every platform's resolver answers a numeric address without a lookup, so
    // this holds with no network at all.
    let addresses = sys::getaddrinfo("127.0.0.1", 4, 0).expect("numeric lookup");
    assert_eq!(addresses.len(), 1);
    assert_eq!(addresses[0].to_string(), "127.0.0.1");
}

#[test]
fn getaddrinfo_reports_an_eai_code_for_a_reserved_name() {
    // `.invalid` is reserved by RFC 2606 precisely so that it never resolves.
    match sys::getaddrinfo("nothing.invalid", 0, 0) {
        Err(errno) => assert!(errno <= -3001 && errno >= -3014, "not an EAI_* code: {errno}"),
        // A resolver behind a wildcard-answering middlebox can "succeed"; the
        // code path under test is the error translation, so an answer here is
        // the environment's, not a failure of this crate.
        Ok(_) => {}
    }
}

#[test]
fn getnameinfo_names_the_loopback_or_says_why_not() {
    let socket = super::parse_socket_addr("127.0.0.1", 22).unwrap();
    match sys::getnameinfo(socket) {
        Ok((hostname, service)) => {
            assert!(!hostname.is_empty());
            assert!(!service.is_empty());
        }
        // A machine with no loopback PTR entry reports EAI_NONAME, which is the
        // other correct answer.
        Err(errno) => assert!(errno <= -3001, "not an EAI_* code: {errno}"),
    }
}

#[test]
fn system_servers_are_addresses_on_port_fifty_three() {
    for server in sys::system_servers() {
        assert!(parse_ip(&server.address).is_some(), "not an address: {}", server.address);
        assert_eq!(server.port, 53);
    }
}
