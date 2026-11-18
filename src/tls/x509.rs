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
