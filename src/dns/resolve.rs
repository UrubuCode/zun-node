//! The stub resolver behind Node's `resolve*` family: one DNS question put to
//! a chosen server, and the answer section parsed into records.
//!
//! # Why this exists at all
//!
//! `dns.resolve4()` is *not* `getaddrinfo`. Node routes it through c-ares,
//! which talks to the servers `dns.setServers()` names and returns whole
//! resource records — an `MX` priority, an `SOA` serial, a `TXT` record's
//! chunks — none of which the system resolver's address-only interface can
//! express. So the module needs a stub resolver of its own, and the choice was
//! a resolver *crate* or the wire format. See the note in `mod.rs` for why this
//! is the wire format; in short, what is needed here is one question, no cache,
//! no DNSSEC, and a caller-owned server list, which is a fraction of what any
//! resolver library is.
//!
//! # Scope
//!
//! RFC 1035 message format with RFC 1035 §4.1.4 name compression, over UDP with
//! a TCP retry when the answer comes back truncated (RFC 1035 §4.2.2, which is
//! what makes a long `TXT` or an `ANY` answer readable at all). One question
//! per message, class `IN`, recursion desired — the same four decisions
//! c-ares' `ares_create_query` makes for `ares_query`.
//!
//! Each server is tried in turn, `tries` times each, with a per-attempt read
//! timeout; that is c-ares' `ARES_OPT_TRIES` / `ARES_OPT_TIMEOUTMS` loop
//! flattened, and `Resolver({ timeout, tries })` in Node's API is exactly those
//! two knobs.
//!
//! # Blocking
//!
//! The query is synchronous, because ABI v1 has no way for an extension to
//! complete a call later: there is no handle the host could poll and no
//! callback it could be given. The TS layer restores Node's *observable*
//! asynchrony by delivering the result through `process.nextTick`, so a
//! `resolve4` callback still runs on a later tick than its caller, and a
//! pending-query window still exists for `setServers` to refuse (which is what
//! `test-dns-setserver-when-querying.js` asserts). What it does not restore is
//! concurrency: two queries issued back to back run one after the other.

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use zun_abi::ZunValue;

use super::{failed, ok_records, parse_socket_addr, sys, RS, US};
use crate::abi::{arg_i64, arg_str, ret_str};

/// The c-ares code names this module reports, which are the strings Node's
/// `DNSException` takes for a query failure (`internal/errors.js` passes a
/// non-number `code` through unchanged).
mod code {
    pub(super) const BADNAME: &str = "EBADNAME";
    pub(super) const BADQUERY: &str = "EBADQUERY";
    pub(super) const BADRESP: &str = "EBADRESP";
    pub(super) const CONNREFUSED: &str = "ECONNREFUSED";
    pub(super) const FORMERR: &str = "EFORMERR";
    pub(super) const NODATA: &str = "ENODATA";
    pub(super) const NOTFOUND: &str = "ENOTFOUND";
    pub(super) const NOTIMP: &str = "ENOTIMP";
    pub(super) const REFUSED: &str = "EREFUSED";
    pub(super) const SERVFAIL: &str = "ESERVFAIL";
    pub(super) const TIMEOUT: &str = "ETIMEOUT";
}

/// RFC 1035 §3.2.2 / §3.2.3 type codes, plus the three later additions Node
/// exposes (`SRV`, `NAPTR`, `CAA`, `TLSA`).
pub(in crate::dns) const TYPE_A: u16 = 1;
const TYPE_NS: u16 = 2;
const TYPE_CNAME: u16 = 5;
pub(in crate::dns) const TYPE_SOA: u16 = 6;
const TYPE_PTR: u16 = 12;
pub(in crate::dns) const TYPE_MX: u16 = 15;
pub(in crate::dns) const TYPE_TXT: u16 = 16;
const TYPE_AAAA: u16 = 28;
const TYPE_SRV: u16 = 33;
const TYPE_NAPTR: u16 = 35;
const TYPE_TLSA: u16 = 52;
pub(in crate::dns) const TYPE_ANY: u16 = 255;
const TYPE_CAA: u16 = 257;
const CLASS_IN: u16 = 1;

/// The message id counter. A DNS id only has to be unpredictable enough that an
/// off-path answer does not match, and distinct between in-flight queries;
/// since queries here are serialized, a per-process counter seeded from the
/// clock gives both.
static NEXT_ID: AtomicU16 = AtomicU16::new(0);

fn next_id() -> u16 {
    let seeded = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    if seeded == 0 {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.subsec_nanos())
            .unwrap_or(1);
        NEXT_ID.store((nanos as u16) | 1, Ordering::Relaxed);
    }
    NEXT_ID.load(Ordering::Relaxed)
}

/// `dnsQuery(servers, name, rrtype, timeoutMs, tries)`.
///
/// `servers` is the caller's server list as `address US port` records — the
/// resolver channel's own list, so a `Resolver` really does query the servers
/// it was given and the default resolver really does follow
/// `dns.setServers()`.
pub(crate) unsafe extern "C" fn query(
    args: *const ZunValue,
    count: usize,
    out: *mut ZunValue,
) -> i32 {
    // SAFETY: the host passes `count` initialized values matching
    // `[Str, Str, Str, I64, I64]`.
    let servers = match unsafe { arg_str(args, count, 0) } {
        Ok(value) => value,
        Err(status) => return status,
    };
    // SAFETY: as above.
    let name = match unsafe { arg_str(args, count, 1) } {
        Ok(value) => value,
        Err(status) => return status,
    };
    // SAFETY: as above.
    let rrtype = match unsafe { arg_str(args, count, 2) } {
        Ok(value) => value,
        Err(status) => return status,
    };
    // SAFETY: as above, for the two integers.
    let timeout_ms = unsafe { arg_i64(args, count, 3) };
    // SAFETY: as above.
    let tries = unsafe { arg_i64(args, count, 4) };

    let payload = match run_query(servers, name, rrtype, timeout_ms, tries) {
        Ok(records) => ok_records(&records),
        Err(code) => failed(code),
    };
    // SAFETY: `out` is the host's writable return slot.
    unsafe { ret_str(out, &payload) }
}

/// The whole query, from the server list to the records, as a plain function so
/// that the unit tests can drive it.
pub(in crate::dns) fn run_query(
    servers: &str,
    name: &str,
    rrtype: &str,
    timeout_ms: i64,
    tries: i64,
) -> Result<Vec<Vec<String>>, &'static str> {
    let Some(qtype) = qtype_of(rrtype) else {
        return Err(code::BADQUERY);
    };
    let question = encode_name(name).ok_or(code::BADNAME)?;
    let targets = parse_servers(servers);
    if targets.is_empty() {
        return Err(code::CONNREFUSED);
    }
    sys::ensure_network_ready();

    // c-ares' default is 5 s / 4 tries; a `timeout` of -1 in Node's
    // `Resolver({ timeout })` means "the library default".
    let timeout = Duration::from_millis(if timeout_ms > 0 { timeout_ms as u64 } else { 5_000 });
    let attempts = if tries > 0 { tries as u32 } else { 4 };

    // One overall deadline of `timeout * tries`, rather than that per *server*.
    // c-ares spends its budget across the whole server list (it round-robins
    // and shortens each attempt as the list grows); multiplying the budget by
    // the number of configured resolvers instead would make a single
    // unreachable network cost a minute on a three-resolver machine, which is
    // nobody's idea of a 5-second timeout.
    let deadline = Instant::now() + timeout * attempts;

    let id = next_id();
    let request = encode_query(id, &question, qtype);
    let mut last = code::CONNREFUSED;

    for target in &targets {
        for _ in 0..attempts {
            if Instant::now() >= deadline {
                return Err(last);
            }
            match exchange(*target, &request, timeout, id) {
                Ok(response) => return decode_answers(&response, qtype),
                Err(code) => {
                    last = code;
                    // A server that answered with a protocol error has
                    // answered: c-ares stops rather than asking the next one,
                    // and so does this.
                    if code != code::TIMEOUT && code != code::CONNREFUSED {
                        return Err(code);
                    }
                }
            }
        }
    }
    Err(last)
}

/// One request/response exchange with one server: UDP first, TCP when the
/// answer is truncated.
fn exchange(
    server: SocketAddr,
    request: &[u8],
    timeout: Duration,
    id: u16,
) -> Result<Vec<u8>, &'static str> {
    let bind: SocketAddr = match server {
        SocketAddr::V4(_) => SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0),
        SocketAddr::V6(_) => SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), 0),
    };
    let socket = UdpSocket::bind(bind).map_err(|_| code::CONNREFUSED)?;
    socket.set_read_timeout(Some(timeout)).map_err(|_| code::CONNREFUSED)?;
    socket.send_to(request, server).map_err(|_| code::CONNREFUSED)?;

    // 4096 covers every EDNS-less UDP answer (the 512-byte limit of RFC 1035
    // §2.3.4 with room for a server that ignores it); anything larger sets TC
    // and is refetched over TCP below.
    let mut buffer = vec![0u8; 4096];
    loop {
        let (length, from) = socket.recv_from(&mut buffer).map_err(|_| code::TIMEOUT)?;
        if from.ip() != server.ip() {
            // An answer from somewhere else is not this query's answer.
            continue;
        }
        if length < 12 {
            return Err(code::BADRESP);
        }
        if u16::from_be_bytes([buffer[0], buffer[1]]) != id {
            continue;
        }
        if buffer[2] & 0x02 == 0 {
            buffer.truncate(length);
            return Ok(buffer);
        }
        return exchange_tcp(server, request, timeout, id);
    }
}

/// RFC 1035 §4.2.2: the same message over TCP, length-prefixed.
fn exchange_tcp(
    server: SocketAddr,
    request: &[u8],
    timeout: Duration,
    id: u16,
) -> Result<Vec<u8>, &'static str> {
    let mut stream = TcpStream::connect_timeout(&server, timeout).map_err(|_| code::CONNREFUSED)?;
    stream.set_read_timeout(Some(timeout)).map_err(|_| code::CONNREFUSED)?;
    let length = u16::try_from(request.len()).map_err(|_| code::BADQUERY)?;
    stream.write_all(&length.to_be_bytes()).map_err(|_| code::CONNREFUSED)?;
    stream.write_all(request).map_err(|_| code::CONNREFUSED)?;

    let mut header = [0u8; 2];
    stream.read_exact(&mut header).map_err(|_| code::TIMEOUT)?;
    let expected = u16::from_be_bytes(header) as usize;
    if expected < 12 {
        return Err(code::BADRESP);
    }
    let mut response = vec![0u8; expected];
    stream.read_exact(&mut response).map_err(|_| code::TIMEOUT)?;
    if u16::from_be_bytes([response[0], response[1]]) != id {
        return Err(code::BADRESP);
    }
    Ok(response)
}

/// `address US port` records into socket addresses, dropping anything that is
/// not an address (the TS layer has already validated them, so this is the
/// belt to that braces).
pub(in crate::dns) fn parse_servers(servers: &str) -> Vec<SocketAddr> {
    let mut out = Vec::new();
    if servers.is_empty() {
        return out;
    }
    for record in servers.split(RS) {
        let mut fields = record.split(US);
        let Some(address) = fields.next() else { continue };
        let port = fields.next().and_then(|text| text.parse::<u16>().ok()).unwrap_or(53);
        if let Some(socket) = parse_socket_addr(address, port) {
            out.push(socket);
        }
    }
    out
}

fn qtype_of(rrtype: &str) -> Option<u16> {
    Some(match rrtype {
        "A" => TYPE_A,
        "AAAA" => TYPE_AAAA,
        "ANY" => TYPE_ANY,
        "CAA" => TYPE_CAA,
        "CNAME" => TYPE_CNAME,
        "MX" => TYPE_MX,
        "NAPTR" => TYPE_NAPTR,
        "NS" => TYPE_NS,
        "PTR" => TYPE_PTR,
        "SOA" => TYPE_SOA,
        "SRV" => TYPE_SRV,
        "TLSA" => TYPE_TLSA,
        "TXT" => TYPE_TXT,
        _ => return None,
    })
}

/// RFC 1035 §3.1: a domain name as length-prefixed labels, terminated by a
/// zero length. A trailing dot is the root and is dropped; a label longer than
/// 63 bytes or a name longer than 255 is not representable.
pub(in crate::dns) fn encode_name(name: &str) -> Option<Vec<u8>> {
    let trimmed = name.strip_suffix('.').unwrap_or(name);
    let mut out = Vec::with_capacity(trimmed.len() + 2);
    if !trimmed.is_empty() {
        for label in trimmed.split('.') {
            if label.is_empty() || label.len() > 63 {
                return None;
            }
            out.push(label.len() as u8);
            out.extend_from_slice(label.as_bytes());
        }
    }
    out.push(0);
    if out.len() > 255 {
        return None;
    }
    Some(out)
}

pub(in crate::dns) fn encode_query(id: u16, question: &[u8], qtype: u16) -> Vec<u8> {
    let mut out = Vec::with_capacity(question.len() + 16);
    out.extend_from_slice(&id.to_be_bytes());
    // QR=0 OPCODE=QUERY AA=0 TC=0 RD=1, and a zeroed response half.
    out.extend_from_slice(&[0x01, 0x00]);
    out.extend_from_slice(&1u16.to_be_bytes()); // QDCOUNT
    out.extend_from_slice(&0u16.to_be_bytes()); // ANCOUNT
    out.extend_from_slice(&0u16.to_be_bytes()); // NSCOUNT
    out.extend_from_slice(&0u16.to_be_bytes()); // ARCOUNT
    out.extend_from_slice(question);
    out.extend_from_slice(&qtype.to_be_bytes());
    out.extend_from_slice(&CLASS_IN.to_be_bytes());
    out
}

/// A cursor over the message, which every reader below shares so that name
/// decompression can jump backwards without losing the forward position.
struct Reader<'a> {
    message: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn u8(&mut self) -> Result<u8, &'static str> {
        let byte = *self.message.get(self.at).ok_or(code::BADRESP)?;
        self.at += 1;
        Ok(byte)
    }

    fn u16(&mut self) -> Result<u16, &'static str> {
        Ok(u16::from_be_bytes([self.u8()?, self.u8()?]))
    }

    fn u32(&mut self) -> Result<u32, &'static str> {
        Ok(u32::from_be_bytes([self.u8()?, self.u8()?, self.u8()?, self.u8()?]))
    }

    fn bytes(&mut self, length: usize) -> Result<&'a [u8], &'static str> {
        let end = self.at.checked_add(length).ok_or(code::BADRESP)?;
        let slice = self.message.get(self.at..end).ok_or(code::BADRESP)?;
        self.at = end;
        Ok(slice)
    }

    /// RFC 1035 §4.1.4: labels, with a two-bit `11` prefix meaning "continue at
    /// this offset". The pointer budget is bounded by the message length, which
    /// makes a compression loop terminate rather than hang.
    fn name(&mut self) -> Result<String, &'static str> {
        let mut out = String::new();
        let mut at = self.at;
        let mut jumps = 0usize;
        let mut forward: Option<usize> = None;
        loop {
            let length = *self.message.get(at).ok_or(code::BADRESP)?;
            if length & 0xc0 == 0xc0 {
                let low = *self.message.get(at + 1).ok_or(code::BADRESP)?;
                let offset = (((length & 0x3f) as usize) << 8) | low as usize;
                if forward.is_none() {
                    forward = Some(at + 2);
                }
                jumps += 1;
                if jumps > self.message.len() || offset >= self.message.len() {
                    return Err(code::BADRESP);
                }
                at = offset;
                continue;
            }
            if length & 0xc0 != 0 {
                return Err(code::BADRESP);
            }
            at += 1;
            if length == 0 {
                break;
            }
            let end = at + length as usize;
            let label = self.message.get(at..end).ok_or(code::BADRESP)?;
            if !out.is_empty() {
                out.push('.');
            }
            out.push_str(&escape_label(label));
            at = end;
        }
        self.at = forward.unwrap_or(at);
        Ok(out)
    }
}

/// A label's bytes as text. DNS labels are not required to be ASCII, so a
/// non-UTF-8 byte is replaced rather than failing the whole answer — the same
/// lenience `ares_expand_name` shows.
fn escape_label(label: &[u8]) -> String {
    String::from_utf8_lossy(label).into_owned()
}

/// Walk the answer section and build the per-type records documented in
/// `mod.rs`.
pub(in crate::dns) fn decode_answers(message: &[u8], qtype: u16) -> Result<Vec<Vec<String>>, &'static str> {
    let flags = u16::from_be_bytes([message[2], message[3]]);
    match flags & 0x000f {
        0 => {}
        1 => return Err(code::FORMERR),
        2 => return Err(code::SERVFAIL),
        3 => return Err(code::NOTFOUND),
        4 => return Err(code::NOTIMP),
        5 => return Err(code::REFUSED),
        _ => return Err(code::SERVFAIL),
    }
    let questions = u16::from_be_bytes([message[4], message[5]]);
    let answers = u16::from_be_bytes([message[6], message[7]]);

    let mut reader = Reader { message, at: 12 };
    for _ in 0..questions {
        reader.name()?;
        reader.u16()?;
        reader.u16()?;
    }

    let mut records: Vec<Vec<String>> = Vec::new();
    for _ in 0..answers {
        reader.name()?;
        let rtype = reader.u16()?;
        let rclass = reader.u16()?;
        let ttl = reader.u32()?;
        let length = reader.u16()? as usize;
        let start = reader.at;
        let end = start.checked_add(length).ok_or(code::BADRESP)?;
        if end > message.len() {
            return Err(code::BADRESP);
        }
        if rclass == CLASS_IN && (qtype == TYPE_ANY || rtype == qtype) {
            if let Some(record) = decode_record(message, start, end, rtype, ttl, qtype)? {
                records.push(record);
            }
        }
        reader.at = end;
    }

    if records.is_empty() {
        return Err(code::NODATA);
    }
    Ok(records)
}

/// One resource record's RDATA as the fields `src/dns/dns.ts` expects for that
/// type. `None` means "a type this module does not model", which only an `ANY`
/// answer can contain and which c-ares drops in the same place.
fn decode_record(
    message: &[u8],
    start: usize,
    end: usize,
    rtype: u16,
    ttl: u32,
    qtype: u16,
) -> Result<Option<Vec<String>>, &'static str> {
    let mut reader = Reader { message, at: start };
    let data = message.get(start..end).ok_or(code::BADRESP)?;
    let ttl_text = ttl.to_string();

    let mut fields: Vec<String> = match rtype {
        TYPE_A => {
            if data.len() < 4 {
                return Err(code::BADRESP);
            }
            vec![
                Ipv4Addr::new(data[0], data[1], data[2], data[3]).to_string(),
                ttl_text,
            ]
        }
        TYPE_AAAA => {
            if data.len() < 16 {
                return Err(code::BADRESP);
            }
            let mut octets = [0u8; 16];
            octets.copy_from_slice(&data[..16]);
            vec![Ipv6Addr::from(octets).to_string(), ttl_text]
        }
        TYPE_NS | TYPE_CNAME | TYPE_PTR => vec![reader.name()?, ttl_text],
        TYPE_MX => {
            let priority = reader.u16()?;
            vec![priority.to_string(), reader.name()?, ttl_text]
        }
        TYPE_TXT => {
            // RFC 1035 §3.3.14: one or more length-prefixed character strings,
            // which Node reports as an array per record.
            let mut chunks = vec![ttl_text];
            while reader.at < end {
                let length = reader.u8()? as usize;
                let chunk = reader.bytes(length)?;
                chunks.push(String::from_utf8_lossy(chunk).into_owned());
            }
            chunks
        }
        TYPE_SRV => {
            let priority = reader.u16()?;
            let weight = reader.u16()?;
            let port = reader.u16()?;
            vec![
                priority.to_string(),
                weight.to_string(),
                port.to_string(),
                reader.name()?,
                ttl_text,
            ]
        }
        TYPE_SOA => {
            let nsname = reader.name()?;
            let hostmaster = reader.name()?;
            let serial = reader.u32()?;
            let refresh = reader.u32()?;
            let retry = reader.u32()?;
            let expire = reader.u32()?;
            let minttl = reader.u32()?;
            vec![
                nsname,
                hostmaster,
                serial.to_string(),
                refresh.to_string(),
                retry.to_string(),
                expire.to_string(),
                minttl.to_string(),
            ]
        }
        TYPE_NAPTR => {
            let order = reader.u16()?;
            let preference = reader.u16()?;
            let flags = read_character_string(&mut reader)?;
            let service = read_character_string(&mut reader)?;
            let regexp = read_character_string(&mut reader)?;
            let replacement = reader.name()?;
            vec![flags, service, regexp, replacement, order.to_string(), preference.to_string(), ttl_text]
        }
        TYPE_CAA => {
            // RFC 8659 §4.1: one flags octet, a length-prefixed tag, and the
            // value as the rest of the RDATA.
            let critical = reader.u8()?;
            let tag_length = reader.u8()? as usize;
            let tag = String::from_utf8_lossy(reader.bytes(tag_length)?).into_owned();
            let value = String::from_utf8_lossy(message.get(reader.at..end).ok_or(code::BADRESP)?)
                .into_owned();
            vec![
                if critical & 0x80 != 0 { "128".to_owned() } else { "0".to_owned() },
                tag,
                value,
                ttl_text,
            ]
        }
        TYPE_TLSA => {
            // RFC 6698 §2.1.
            let cert_usage = reader.u8()?;
            let selector = reader.u8()?;
            let matching = reader.u8()?;
            let certificate = message.get(reader.at..end).ok_or(code::BADRESP)?;
            vec![
                cert_usage.to_string(),
                selector.to_string(),
                matching.to_string(),
                hex(certificate),
                ttl_text,
            ]
        }
        _ => return Ok(None),
    };

    if qtype == TYPE_ANY {
        let mut with_type = vec![type_name(rtype).to_owned()];
        with_type.append(&mut fields);
        return Ok(Some(with_type));
    }
    Ok(Some(fields))
}

fn read_character_string(reader: &mut Reader<'_>) -> Result<String, &'static str> {
    let length = reader.u8()? as usize;
    Ok(String::from_utf8_lossy(reader.bytes(length)?).into_owned())
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// The `type` field Node puts on each entry of a `resolveAny` answer.
fn type_name(rtype: u16) -> &'static str {
    match rtype {
        TYPE_A => "A",
        TYPE_NS => "NS",
        TYPE_CNAME => "CNAME",
        TYPE_SOA => "SOA",
        TYPE_PTR => "PTR",
        TYPE_MX => "MX",
        TYPE_TXT => "TXT",
        TYPE_AAAA => "AAAA",
        TYPE_SRV => "SRV",
        TYPE_NAPTR => "NAPTR",
        TYPE_TLSA => "TLSA",
        TYPE_CAA => "CAA",
        _ => "UNKNOWN",
    }
}
