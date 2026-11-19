//! The X.509 reading `tls.TLSSocket.getPeerCertificate()` needs: a DER
//! certificate described as the fields of Node's certificate object, in the
//! spellings OpenSSL prints them (`valid_from: 'Sep  1 12:00:00 2022 GMT'`,
//! colon-separated upper-case fingerprints, `subjectaltname: 'DNS:a, IP
//! Address:127.0.0.1'`).

use der::{Decode, Encode};
use sha1::Digest;
use x509_cert::ext::pkix::{BasicConstraints, SubjectAltName};
use x509_cert::ext::pkix::name::GeneralName;
use x509_cert::name::Name;
use x509_cert::Certificate;

use crate::fs::base64;

const US: char = '\u{1f}';

const OID_RSA: &str = "1.2.840.113549.1.1.1";
const OID_EC: &str = "1.2.840.10045.2.1";
const OID_SAN: &str = "2.5.29.17";
const OID_BASIC: &str = "2.5.29.19";

/// True when the certificate's issuer and subject are the same name.
pub(crate) fn self_issued(der: &[u8]) -> bool {
    match Certificate::from_der(der) {
        Ok(cert) => {
            let tbs = &cert.tbs_certificate;
            tbs.subject.to_der().ok() == tbs.issuer.to_der().ok()
        }
        Err(_) => false,
    }
}

fn short_name(oid: &str) -> String {
    match oid {
        "2.5.4.3" => "CN",
        "2.5.4.6" => "C",
        "2.5.4.7" => "L",
        "2.5.4.8" => "ST",
        "2.5.4.10" => "O",
        "2.5.4.11" => "OU",
        "2.5.4.5" => "serialNumber",
        "2.5.4.4" => "SN",
        "2.5.4.42" => "GN",
        "2.5.4.12" => "title",
        "2.5.4.9" => "street",
        "2.5.4.17" => "postalCode",
        "1.2.840.113549.1.9.1" => "emailAddress",
        "0.9.2342.19200300.100.1.25" => "DC",
        "0.9.2342.19200300.100.1.1" => "UID",
        other => return other.to_owned(),
    }
    .to_owned()
}

/// `K=V` lines, one per attribute, in certificate order.
fn name_lines(name: &Name) -> String {
    let mut lines = Vec::new();
    for rdn in name.0.iter() {
        for atv in rdn.0.iter() {
            let value = String::from_utf8_lossy(atv.value.value()).into_owned();
            lines.push(format!("{}={}", short_name(&atv.oid.to_string()), value.replace('\n', " ")));
        }
    }
    lines.join("\n")
}

/// Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// OpenSSL's `ASN1_TIME_print` spelling: `Mmm dd HH:MM:SS YYYY GMT`.
pub(crate) fn openssl_time(secs: i64) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let (y, m, d) = civil(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    format!(
        "{} {:>2} {:02}:{:02}:{:02} {} GMT",
        MONTHS[(m - 1) as usize],
        d,
        rem / 3600,
        (rem / 60) % 60,
        rem % 60,
        y
    )
}

fn hex_colon(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

fn ip_text(bytes: &[u8]) -> String {
    match bytes.len() {
        4 => format!("{}.{}.{}.{}", bytes[0], bytes[1], bytes[2], bytes[3]),
        16 => {
            let mut a = [0u8; 16];
            a.copy_from_slice(bytes);
            // OpenSSL prints every group, upper-case, without compression.
            a.chunks(2)
                .map(|g| format!("{:X}", u16::from_be_bytes([g[0], g[1]])))
                .collect::<Vec<_>>()
                .join(":")
        }
        _ => hex(bytes),
    }
}

/// `subject US issuer US valid_from US valid_to US serialNumber US fingerprint
/// US fingerprint256 US fingerprint512 US subjectaltname US bits US modulus US
/// exponent US pubkey(b64) US ca US asn1Curve US nistCurve US validFromSecs US
/// validToSecs`. Absent fields are empty.
pub(crate) fn describe(der: &[u8]) -> Option<String> {
    let cert = Certificate::from_der(der).ok()?;
    let tbs = &cert.tbs_certificate;
    let subject = name_lines(&tbs.subject);
    let issuer = name_lines(&tbs.issuer);
    let from = tbs.validity.not_before.to_unix_duration().as_secs() as i64;
    let to = tbs.validity.not_after.to_unix_duration().as_secs() as i64;
    let serial = {
        let bytes = tbs.serial_number.as_bytes();
        let trimmed: &[u8] = {
            let mut i = 0;
            while i + 1 < bytes.len() && bytes[i] == 0 {
                i += 1;
            }
            &bytes[i..]
        };
        hex(trimmed)
    };
    let fp1 = hex_colon(&sha1::Sha1::digest(der));
    let fp256 = hex_colon(&sha2::Sha256::digest(der));
    let fp512 = hex_colon(&sha2::Sha512::digest(der));

    let mut san = String::new();
    let mut ca = false;
    if let Some(exts) = &tbs.extensions {
        for ext in exts {
            let id = ext.extn_id.to_string();
            if id == OID_SAN {
                if let Ok(names) = SubjectAltName::from_der(ext.extn_value.as_bytes()) {
                    let parts: Vec<String> = names
                        .0
                        .iter()
                        .filter_map(|g| match g {
                            GeneralName::DnsName(s) => Some(format!("DNS:{}", san_escape(&s.to_string()))),
                            GeneralName::Rfc822Name(s) => Some(format!("email:{}", san_escape(&s.to_string()))),
                            GeneralName::UniformResourceIdentifier(s) => Some(format!("URI:{}", san_escape(&s.to_string()))),
                            GeneralName::IpAddress(o) => Some(format!("IP Address:{}", ip_text(o.as_bytes()))),
                            _ => None,
                        })
                        .collect();
                    san = parts.join(", ");
                }
            } else if id == OID_BASIC {
                if let Ok(bc) = BasicConstraints::from_der(ext.extn_value.as_bytes()) {
                    ca = bc.ca;
                }
            }
        }
    }

    let spki = &tbs.subject_public_key_info;
    let alg = spki.algorithm.oid.to_string();
    let key_bytes = spki.subject_public_key.raw_bytes();
    let (mut bits, mut modulus, mut exponent, mut curve, mut nist) =
        (String::new(), String::new(), String::new(), String::new(), String::new());
    let mut pubkey = spki.to_der().map(|d| base64::encode(&d)).unwrap_or_default();
    if alg == OID_RSA {
        use rsa::pkcs1::DecodeRsaPublicKey;
        use rsa::traits::PublicKeyParts;
        if let Ok(key) = rsa::RsaPublicKey::from_pkcs1_der(key_bytes) {
            bits = key.n().bits().to_string();
            modulus = hex(&key.n().to_bytes_be());
            exponent = format!("0x{}", key.e().to_str_radix(16));
        }
    } else if alg == OID_EC {
        pubkey = base64::encode(key_bytes);
        let params = spki
            .algorithm
            .parameters
            .as_ref()
            .and_then(|p| p.decode_as::<der::asn1::ObjectIdentifier>().ok())
            .map(|o| o.to_string())
            .unwrap_or_default();
        let (b, c, n) = match params.as_str() {
            "1.2.840.10045.3.1.7" => ("256", "prime256v1", "P-256"),
            "1.3.132.0.34" => ("384", "secp384r1", "P-384"),
            "1.3.132.0.35" => ("521", "secp521r1", "P-521"),
            "1.3.132.0.10" => ("256", "secp256k1", ""),
            _ => ("", "", ""),
        };
        bits = b.to_owned();
        curve = c.to_owned();
        nist = n.to_owned();
    }

    Some(
        [
            subject,
            issuer,
            openssl_time(from),
            openssl_time(to),
            serial,
            fp1,
            fp256,
            fp512,
            san,
            bits,
            modulus,
            exponent,
            pubkey,
            if ca { "1".to_owned() } else { "0".to_owned() },
            curve,
            nist,
            from.to_string(),
            to.to_string(),
        ]
        .join(&US.to_string()),
    )
}

/// False only when both the certificate and the private key are RSA and their
/// moduli differ -- OpenSSL's `key values mismatch`. Any other pairing is left
/// to the handshake.
pub(crate) fn rsa_key_matches(cert_der: &[u8], key_der: &[u8]) -> bool {
    use rsa::pkcs1::{DecodeRsaPrivateKey, DecodeRsaPublicKey};
    use rsa::pkcs8::DecodePrivateKey;
    use rsa::traits::PublicKeyParts;
    let Ok(cert) = Certificate::from_der(cert_der) else { return true };
    let spki = &cert.tbs_certificate.subject_public_key_info;
    if spki.algorithm.oid.to_string() != OID_RSA {
        return true;
    }
    let Ok(public) = rsa::RsaPublicKey::from_pkcs1_der(spki.subject_public_key.raw_bytes()) else {
        return true;
    };
    let private = rsa::RsaPrivateKey::from_pkcs1_der(key_der)
        .or_else(|_| rsa::RsaPrivateKey::from_pkcs8_der(key_der));
    match private {
        Ok(private) => private.n() == public.n(),
        Err(_) => true,
    }
}

/// The `subjectPublicKey` bit string contents: what a webpki signature
/// algorithm takes as the public key.
pub(crate) fn public_key_bits(der: &[u8]) -> Option<Vec<u8>> {
    let cert = Certificate::from_der(der).ok()?;
    Some(cert.tbs_certificate.subject_public_key_info.subject_public_key.raw_bytes().to_vec())
}

/// The subject name, DER-encoded.
pub(crate) fn subject_der(der: &[u8]) -> Option<Vec<u8>> {
    let cert = Certificate::from_der(der).ok()?;
    cert.tbs_certificate.subject.to_der().ok()
}

/// `(issuer DER, TBS DER, signature, notBefore, notAfter)`.
pub(crate) fn signed_parts(der: &[u8]) -> Option<(Vec<u8>, Vec<u8>, Vec<u8>, i64, i64)> {
    let cert = Certificate::from_der(der).ok()?;
    let tbs = &cert.tbs_certificate;
    Some((
        tbs.issuer.to_der().ok()?,
        tbs.to_der().ok()?,
        cert.signature.raw_bytes().to_vec(),
        tbs.validity.not_before.to_unix_duration().as_secs() as i64,
        tbs.validity.not_after.to_unix_duration().as_secs() as i64,
    ))
}

/// Node's alt-name spelling: a name with a separator, quote, backslash or a
/// non-printable character is written as a JSON-style quoted string
/// (`DNS:"a\u0000b"`), so the list stays unambiguous.
fn san_escape(name: &str) -> String {
    let needs = name.chars().any(|c| c == ',' || c == '"' || c == '\\' || (c as u32) < 0x20 || (c as u32) > 0x7e);
    if !needs {
        return name.to_owned();
    }
    let mut out = String::from("\"");
    for c in name.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 || (c as u32) > 0x7e => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

// ---------------------------------------------------------------------------
// `crypto.X509Certificate`: a hand-rolled DER walk
// ---------------------------------------------------------------------------
//
// `x509_cert` (through `der`) rejects any time before 1970, which the Node
// corpus exercises (a `validFromDate` in 1949), and refuses certificates whose
// public key does not decode -- which `X509Certificate` must still open,
// failing only when `publicKey` is read. So the class walks the structure
// itself.

/// One TLV: `(tag, content start, end)`.
fn tlv(der: &[u8], at: usize) -> Option<(u8, usize, usize)> {
    let tag = *der.get(at)?;
    let first = *der.get(at + 1)? as usize;
    let (len, start) = if first < 0x80 {
        (first, at + 2)
    } else {
        let count = first & 0x7f;
        if count == 0 || count > 4 {
            return None;
        }
        let mut len = 0usize;
        for i in 0..count {
            len = (len << 8) | *der.get(at + 2 + i)? as usize;
        }
        (len, at + 2 + count)
    };
    let end = start.checked_add(len)?;
    if end > der.len() {
        return None;
    }
    Some((tag, start, end))
}

/// `(tag, header start, content start, end)` of each TLV inside `start..end`.
type Child = (u8, usize, usize, usize);

fn children(der: &[u8], start: usize, end: usize) -> Option<Vec<Child>> {
    let mut out = Vec::new();
    let mut at = start;
    while at < end {
        let (tag, s, e) = tlv(der, at)?;
        if e > end {
            return None;
        }
        out.push((tag, at, s, e));
        at = e;
    }
    Some(out)
}

fn oid_text(bytes: &[u8]) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut value: u64 = 0;
    let mut first = true;
    for &b in bytes {
        value = (value << 7) | (b & 0x7f) as u64;
        if b & 0x80 == 0 {
            if first {
                let (a, c) = if value < 40 {
                    (0, value)
                } else if value < 80 {
                    (1, value - 40)
                } else {
                    (2, value - 80)
                };
                parts.push(a.to_string());
                parts.push(c.to_string());
                first = false;
            } else {
                parts.push(value.to_string());
            }
            value = 0;
        }
    }
    parts.join(".")
}

fn string_value(tag: u8, bytes: &[u8]) -> String {
    if tag == 0x1e {
        let units: Vec<u16> =
            bytes.chunks(2).filter(|c| c.len() == 2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&units);
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn name_lines_der(der: &[u8], start: usize, end: usize) -> Option<String> {
    let mut lines = Vec::new();
    for (_, _, s, e) in children(der, start, end)? {
        for (_, _, as_, ae) in children(der, s, e)? {
            let kids = children(der, as_, ae)?;
            if kids.len() < 2 || kids[0].0 != 0x06 {
                return None;
            }
            let oid = oid_text(&der[kids[0].2..kids[0].3]);
            let value = string_value(kids[1].0, &der[kids[1].2..kids[1].3]);
            lines.push(format!("{}={}", short_name(&oid), value.replace('\n', " ")));
        }
    }
    Some(lines.join("\n"))
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn parse_time(tag: u8, bytes: &[u8]) -> Option<i64> {
    let text = std::str::from_utf8(bytes).ok()?;
    let digits = text.trim_end_matches('Z');
    let num = |s: &str| s.parse::<i64>().ok();
    let (y, rest) = match tag {
        0x17 => {
            let yy = num(digits.get(0..2)?)?;
            (if yy >= 50 { 1900 + yy } else { 2000 + yy }, digits.get(2..)?)
        }
        0x18 => (num(digits.get(0..4)?)?, digits.get(4..)?),
        _ => return None,
    };
    let mo = num(rest.get(0..2)?)?;
    let d = num(rest.get(2..4)?)?;
    let h = num(rest.get(4..6)?)?;
    let mi = num(rest.get(6..8)?)?;
    let s = rest.get(8..10).and_then(num).unwrap_or(0);
    Some(days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + s)
}

/// OpenSSL's long name for a signature algorithm, and the digest `verify`
/// hashes with (empty for one that takes none).
fn sig_alg_name(oid: &str) -> (&'static str, &'static str) {
    match oid {
        "1.2.840.113549.1.1.4" => ("md5WithRSAEncryption", "md5"),
        "1.2.840.113549.1.1.5" => ("sha1WithRSAEncryption", "sha1"),
        "1.2.840.113549.1.1.11" => ("sha256WithRSAEncryption", "sha256"),
        "1.2.840.113549.1.1.12" => ("sha384WithRSAEncryption", "sha384"),
        "1.2.840.113549.1.1.13" => ("sha512WithRSAEncryption", "sha512"),
        "1.2.840.113549.1.1.14" => ("sha224WithRSAEncryption", "sha224"),
        "1.2.840.113549.1.1.10" => ("rsassaPss", "sha256"),
        "1.2.840.10045.4.1" => ("ecdsa-with-SHA1", "sha1"),
        "1.2.840.10045.4.3.1" => ("ecdsa-with-SHA224", "sha224"),
        "1.2.840.10045.4.3.2" => ("ecdsa-with-SHA256", "sha256"),
        "1.2.840.10045.4.3.3" => ("ecdsa-with-SHA384", "sha384"),
        "1.2.840.10045.4.3.4" => ("ecdsa-with-SHA512", "sha512"),
        "1.3.101.112" => ("ED25519", ""),
        "1.3.101.113" => ("ED448", ""),
        "1.2.840.10040.4.3" => ("dsaWithSHA1", "sha1"),
        "2.16.840.1.101.3.4.3.2" => ("dsa_with_SHA256", "sha256"),
        _ => ("", ""),
    }
}

fn general_names(der: &[u8], start: usize, end: usize) -> Option<Vec<String>> {
    let mut out = Vec::new();
    for (tag, _, s, e) in children(der, start, end)? {
        let body = &der[s..e];
        let text = || san_escape(&String::from_utf8_lossy(body));
        match tag {
            0x81 => out.push(format!("email:{}", text())),
            0x82 => out.push(format!("DNS:{}", text())),
            0x86 => out.push(format!("URI:{}", text())),
            0x87 => out.push(format!("IP Address:{}", ip_text(body))),
            0xa4 => {
                if let Some((_, ns, ne)) = tlv(der, s) {
                    let lines = name_lines_der(der, ns, ne).unwrap_or_default();
                    out.push(format!("DirName:{}", lines.replace('\n', "/")));
                }
            }
            _ => {}
        }
    }
    Some(out)
}

/// Everything `X509Certificate` reports, `US`-separated:
/// `0 subject, 1 issuer, 2 validFrom, 3 validTo, 4 validFromSecs, 5 validToSecs,
/// 6 serial, 7 fp1, 8 fp256, 9 fp512, 10 subjectAltName (\x01 when absent),
/// 11 infoAccess (\x01 when absent), 12 ca, 13 extKeyUsage (comma list, \x01
/// when absent), 14 signature algorithm OID, 15 its name, 16 its digest,
/// 17 tbs b64, 18 signature b64, 19 spki b64, 20 issuer DER b64,
/// 21 subject DER b64, 22 keyUsage bits (-1 absent), 23 SKID hex, 24 AKID hex,
/// 25 RSA/EC bits, 26 modulus, 27 exponent, 28 EC curve, 29 NIST curve`.
pub(crate) fn x509_fields(der: &[u8]) -> Option<String> {
    let (tag, cs, ce) = tlv(der, 0)?;
    if tag != 0x30 || ce != der.len() {
        return None;
    }
    let top = children(der, cs, ce)?;
    if top.len() != 3 || top[0].0 != 0x30 || top[1].0 != 0x30 || top[2].0 != 0x03 {
        return None;
    }
    let tbs_der = &der[top[0].1..top[0].3];
    let sig_alg_kids = children(der, top[1].2, top[1].3)?;
    let first = sig_alg_kids.first()?;
    let sig_oid = oid_text(&der[first.2..first.3]);
    let sig = der.get(top[2].2 + 1..top[2].3)?.to_vec();

    let mut tk = children(der, top[0].2, top[0].3)?.into_iter().peekable();
    if tk.peek()?.0 == 0xa0 {
        tk.next();
    }
    let serial = tk.next()?;
    let _alg = tk.next()?;
    let issuer = tk.next()?;
    let validity = tk.next()?;
    let subject = tk.next()?;
    let spki = tk.next()?;
    if serial.0 != 0x02 || issuer.0 != 0x30 || validity.0 != 0x30 || subject.0 != 0x30 || spki.0 != 0x30 {
        return None;
    }
    let times = children(der, validity.2, validity.3)?;
    if times.len() != 2 {
        return None;
    }
    let from = parse_time(times[0].0, &der[times[0].2..times[0].3])?;
    let to = parse_time(times[1].0, &der[times[1].2..times[1].3])?;
    let serial_hex = {
        let bytes = &der[serial.2..serial.3];
        let mut i = 0;
        while i + 1 < bytes.len() && bytes[i] == 0 {
            i += 1;
        }
        hex(&bytes[i..])
    };

    let absent = "\u{1}".to_owned();
    let (mut san, mut info, mut eku) = (absent.clone(), absent.clone(), absent);
    let mut ca = false;
    let mut key_usage: i64 = -1;
    let (mut skid, mut akid) = (String::new(), String::new());
    for ext_wrap in tk {
        if ext_wrap.0 != 0xa3 {
            continue;
        }
        let (_, es, ee) = tlv(der, ext_wrap.2)?;
        for (_, _, s, e) in children(der, es, ee)? {
            let kids = children(der, s, e)?;
            let oid = oid_text(&der[kids.first()?.2..kids.first()?.3]);
            let value = kids.last()?;
            if value.0 != 0x04 {
                continue;
            }
            let Some((vtag, vs, ve)) = tlv(der, value.2) else { continue };
            match oid.as_str() {
                "2.5.29.17" => san = general_names(der, vs, ve)?.join(", "),
                "2.5.29.19" => {
                    if let Some(k) = children(der, vs, ve) {
                        ca = k.first().map(|k| k.0 == 0x01 && k.3 > k.2 && der[k.2] != 0).unwrap_or(false);
                    }
                }
                "2.5.29.15" if vtag == 0x03 && ve > vs + 1 => {
                    let mut bits: i64 = 0;
                    for (i, b) in der[vs + 1..ve].iter().take(2).enumerate() {
                        bits |= (*b as i64) << (8 * i);
                    }
                    key_usage = bits;
                }
                "2.5.29.37" => {
                    let list: Vec<String> = children(der, vs, ve)?
                        .iter()
                        .filter(|k| k.0 == 0x06)
                        .map(|k| oid_text(&der[k.2..k.3]))
                        .collect();
                    eku = list.join(",");
                }
                "2.5.29.14" if vtag == 0x04 => skid = hex(&der[vs..ve]),
                "2.5.29.35" => {
                    if let Some(k) = children(der, vs, ve) {
                        if let Some(id) = k.iter().find(|k| k.0 == 0x80) {
                            akid = hex(&der[id.2..id.3]);
                        }
                    }
                }
                "1.3.6.1.5.5.7.1.1" => {
                    let mut lines = Vec::new();
                    for (_, _, ds, de) in children(der, vs, ve)? {
                        let d = children(der, ds, de)?;
                        if d.len() != 2 {
                            continue;
                        }
                        let method = oid_text(&der[d[0].2..d[0].3]);
                        let label = match method.as_str() {
                            "1.3.6.1.5.5.7.48.1" => "OCSP".to_owned(),
                            "1.3.6.1.5.5.7.48.2" => "CA Issuers".to_owned(),
                            other => other.to_owned(),
                        };
                        for n in general_names(der, d[1].1, d[1].3)? {
                            lines.push(format!("{label} - {n}"));
                        }
                    }
                    info = lines.join("\n");
                }
                _ => {}
            }
        }
    }

    let spki_der = &der[spki.1..spki.3];
    let (mut bits, mut modulus, mut exponent, mut curve, mut nist) =
        (String::new(), String::new(), String::new(), String::new(), String::new());
    if let Some(sk) = children(der, spki.2, spki.3) {
        if sk.len() == 2 && sk[0].0 == 0x30 && sk[1].0 == 0x03 {
            let alg = children(der, sk[0].2, sk[0].3).unwrap_or_default();
            let alg_oid = alg.first().map(|a| oid_text(&der[a.2..a.3])).unwrap_or_default();
            let key_bytes = der.get(sk[1].2 + 1..sk[1].3).unwrap_or(&[]);
            if alg_oid == OID_RSA {
                use rsa::pkcs1::DecodeRsaPublicKey;
                use rsa::traits::PublicKeyParts;
                if let Ok(key) = rsa::RsaPublicKey::from_pkcs1_der(key_bytes) {
                    bits = key.n().bits().to_string();
                    modulus = hex(&key.n().to_bytes_be());
                    exponent = format!("0x{}", key.e().to_str_radix(16));
                }
            } else if alg_oid == OID_EC {
                let params = alg.get(1).map(|a| oid_text(&der[a.2..a.3])).unwrap_or_default();
                let (b, c, n) = match params.as_str() {
                    "1.2.840.10045.3.1.7" => ("256", "prime256v1", "P-256"),
                    "1.3.132.0.34" => ("384", "secp384r1", "P-384"),
                    "1.3.132.0.35" => ("521", "secp521r1", "P-521"),
                    "1.3.132.0.10" => ("256", "secp256k1", ""),
                    _ => ("", "", ""),
                };
                bits = b.to_owned();
                curve = c.to_owned();
                nist = n.to_owned();
            }
        }
    }
    let (sig_name, sig_digest) = sig_alg_name(&sig_oid);
    Some(
        [
            name_lines_der(der, subject.2, subject.3)?,
            name_lines_der(der, issuer.2, issuer.3)?,
            openssl_time(from),
            openssl_time(to),
            from.to_string(),
            to.to_string(),
            serial_hex,
            hex_colon(&sha1::Sha1::digest(der)),
            hex_colon(&sha2::Sha256::digest(der)),
            hex_colon(&sha2::Sha512::digest(der)),
            san,
            info,
            if ca { "1".into() } else { "0".into() },
            eku,
            sig_oid,
            sig_name.to_owned(),
            sig_digest.to_owned(),
            base64::encode(tbs_der),
            base64::encode(&sig),
            base64::encode(spki_der),
            base64::encode(&der[issuer.1..issuer.3]),
            base64::encode(&der[subject.1..subject.3]),
            key_usage.to_string(),
            skid,
            akid,
            bits,
            modulus,
            exponent,
            curve,
            nist,
        ]
        .join(&US.to_string()),
    )
}

#[cfg(test)]
mod walk_tests {
    use super::*;

    #[test]
    fn civil_round_trip_before_1970() {
        let secs = days_from_civil(1949, 12, 25) * 86_400;
        assert_eq!(openssl_time(secs), "Dec 25 00:00:00 1949 GMT");
        assert_eq!(parse_time(0x17, b"500101235958Z"), Some(days_from_civil(1950, 1, 1) * 86_400 + 86_398));
    }

    #[test]
    fn oid_text_decodes_multibyte_arcs() {
        assert_eq!(oid_text(&[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), "1.2.840.113549.1.1.11");
    }
}
