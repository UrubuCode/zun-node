//! `node:tls` — the TLS record layer behind Node's `tls` and `https` modules,
//! as a native `zun_abi` extension.
//!
//! # A memory-BIO engine, not a socket
//!
//! Node drives OpenSSL through a pair of memory BIOs: the bytes a TCP socket
//! delivers are written into the engine, and whatever the engine wants to send
//! is read out of it and written to the socket. This module is the same shape
//! over [rustls]: a *session* is one `rustls::Connection` in a handle table, and
//! the TypeScript layer (`src/tls/tls.ts`) owns the `net.Socket` underneath and
//! shuttles bytes between the two. Nothing here touches a file descriptor, so
//! the shared I/O loop (`src/io`) needs no TLS awareness at all.
//!
//! Every call that moves bytes answers one **poll record** (see [`poll`]):
//! whether the handshake is done, the ciphertext to send, the plaintext that
//! arrived, and whether the peer sent `close_notify` — so a single native call
//! per socket event is enough.
//!
//! # Verification is reported, not enforced
//!
//! Node verifies the peer chain inside the handshake but *decides* in
//! JavaScript: `rejectUnauthorized` turns a failed verification into a
//! destroyed socket after the fact, and `checkServerIdentity` (the host name
//! match) is a JS function a user may replace. The verifiers here therefore
//! always let the handshake proceed, while checking the handshake signatures
//! for real, and record the chain verdict as the OpenSSL `X509_V_ERR_*` code
//! Node reports in `authorizationError` (`DEPTH_ZERO_SELF_SIGNED_CERT`,
//! `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `CERT_HAS_EXPIRED`, ...). The host name is
//! never checked here.
//!
//! # What crosses the boundary
//!
//! The grammar `src/crypto/mod.rs` documents: `"+" payload | "-"`, fields
//! separated by U+001F, byte strings in base64. Option records passed *in* are
//! `key US value` pairs separated by U+001E.
//!
//! # Deviations from OpenSSL
//!
//! rustls implements TLS 1.2 and 1.3 only, with AEAD suites only (ECDHE +
//! AES-GCM / ChaCha20-Poly1305), so `minVersion: 'TLSv1'`, RSA key exchange,
//! CBC suites, DHE, PSK and renegotiation do not exist here.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::server::{ClientHello, ParsedCertificate, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use rustls::{
    CertificateError, ClientConfig, ClientConnection, Connection, DigitallySignedStruct,
    DistinguishedName, RootCertStore, ServerConfig, ServerConnection, SignatureScheme,
};
use zun_abi::ZunValue;

use crate::abi::{arg_bool, arg_i64, arg_str, ret_str};
use crate::fs::base64;
use crate::Descriptor;
use zun_abi::ZunTy::{Bool, I64, Str};

pub(crate) mod x509;

#[cfg(test)]
mod tests;

const RS: char = '\u{1e}';
const US: char = '\u{1f}';
/// Separator inside one option value (a list of byte strings).
const GS: char = '\u{1d}';

/// The chain verdict a verifier recorded: `(code, message)`, `None` when the
/// chain verified.
type Verdict = Arc<Mutex<Option<(String, String)>>>;

struct Session {
    /// `None` while a lazy server session is still reading the ClientHello
    /// (`accepting`) or waiting for the TS layer to pick its context
    /// (`accepted`): that is the `SNICallback` window.
    conn: Option<Connection>,
    accepting: Option<rustls::server::Acceptor>,
    accepted: Option<rustls::server::Accepted>,
    /// Ciphertext that arrived while `accepted` was waiting.
    pending: Vec<u8>,
    verdict: Verdict,
    eof: bool,
    /// A fatal error already reported; later calls answer it again.
    failed: Option<(String, String)>,
}

struct Table(HashMap<i64, Session>);

// SAFETY: the `Mutex` below is the only way in, each session is owned by its
// handle, and no reference to one outlives the call that took it.
unsafe impl Send for Table {}

static SESSIONS: Mutex<Option<Table>> = Mutex::new(None);
static NEXT_HANDLE: AtomicI64 = AtomicI64::new(1);

fn with_sessions<R>(action: impl FnOnce(&mut HashMap<i64, Session>) -> R) -> R {
    let mut guard = SESSIONS.lock().unwrap_or_else(|p| p.into_inner());
    action(&mut guard.get_or_insert_with(|| Table(HashMap::new())).0)
}

fn fail(code: &str, message: &str) -> String {
    #[cfg(test)]
    eprintln!("tls fail: {code}: {message}");
    crate::abi::fail_system("", code, 0, message);
    "-".to_owned()
}

// ---------------------------------------------------------------------------
// Option records
// ---------------------------------------------------------------------------

/// A decoded `key US value (RS key US value)*` record. A key may repeat.
pub(crate) struct Options(Vec<(String, String)>);

impl Options {
    pub(crate) fn parse(text: &str) -> Options {
        let mut out = Vec::new();
        for record in text.split(RS) {
            if record.is_empty() {
                continue;
            }
            match record.split_once(US) {
                Some((k, v)) => out.push((k.to_owned(), v.to_owned())),
                None => out.push((record.to_owned(), String::new())),
            }
        }
        Options(out)
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    fn all<'a>(&'a self, key: &'a str) -> impl Iterator<Item = &'a str> + 'a {
        self.0.iter().filter(move |(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    fn flag(&self, key: &str) -> bool {
        matches!(self.get(key), Some("1"))
    }
}

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

/// Certificates from bytes that are either PEM (any number of `CERTIFICATE`
/// blocks) or one DER certificate.
pub(crate) fn parse_certs(bytes: &[u8]) -> Result<Vec<CertificateDer<'static>>, String> {
    if bytes.windows(10).any(|w| w == b"-----BEGIN") {
        let mut out = Vec::new();
        for item in CertificateDer::pem_slice_iter(bytes) {
            match item {
                Ok(cert) => out.push(cert),
                Err(_) => return Err("bad certificate PEM".to_owned()),
            }
        }
        Ok(out)
    } else if bytes.is_empty() {
        Ok(Vec::new())
    } else {
        Ok(vec![CertificateDer::from(bytes.to_vec())])
    }
}

/// A private key from PEM (PKCS#1, PKCS#8, SEC1, or an encrypted PKCS#8 block
/// opened with `passphrase`) or DER.
pub(crate) fn parse_key(bytes: &[u8], passphrase: Option<&str>) -> Result<PrivateKeyDer<'static>, (String, String)> {
    let text = String::from_utf8_lossy(bytes);
    if text.contains("-----BEGIN ENCRYPTED PRIVATE KEY-----") {
        let Some(pass) = passphrase else {
            return Err(bad_decrypt());
        };
        let body = pem_body(&text, "ENCRYPTED PRIVATE KEY").ok_or_else(no_start_line)?;
        let info = pkcs8::EncryptedPrivateKeyInfo::try_from(body.as_slice()).map_err(|_| no_start_line())?;
        let doc = info.decrypt(pass.as_bytes()).map_err(|_| bad_decrypt())?;
        return Ok(PrivateKeyDer::Pkcs8(doc.as_bytes().to_vec().into()));
    }
    if text.contains("Proc-Type: 4,ENCRYPTED") {
        // Legacy OpenSSL PEM encryption (`DEK-Info`) is not implemented.
        return Err(bad_decrypt());
    }
    if text.contains("-----BEGIN") {
        return PrivateKeyDer::from_pem_slice(bytes).map_err(|_| no_start_line());
    }
    PrivateKeyDer::try_from(bytes.to_vec()).map_err(|_| no_start_line())
}

fn no_start_line() -> (String, String) {
    (
        "ERR_OSSL_PEM_NO_START_LINE".to_owned(),
        "error:0480006C:PEM routines::no start line".to_owned(),
    )
}

fn bad_decrypt() -> (String, String) {
    (
        "ERR_OSSL_BAD_DECRYPT".to_owned(),
        "error:1C800064:Provider routines::bad decrypt".to_owned(),
    )
}

fn pem_body(text: &str, label: &str) -> Option<Vec<u8>> {
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    let start = text.find(&begin)? + begin.len();
    let stop = text[start..].find(&end)? + start;
    let b64: String = text[start..stop].chars().filter(|c| !c.is_whitespace()).collect();
    Some(base64::decode(&b64))
}

fn provider_for(options: &Options) -> Arc<CryptoProvider> {
    let mut provider = rustls_rustcrypto::provider();
    if let Some(list) = options.get("ciphers") {
        let wanted: Vec<String> = list.split(':').map(|s| s.trim().to_owned()).collect();
        let kept: Vec<_> = provider
            .cipher_suites
            .iter()
            .copied()
            .filter(|suite| {
                let (name, standard, _) = cipher_names(suite.suite());
                wanted.iter().any(|w| w == name || w == standard)
            })
            .collect();
        // A list that names nothing rustls has (Node's corpus asks for CBC and
        // DHE suites) keeps the defaults rather than making every handshake
        // fail; a TLS 1.3 suite is always kept, as in OpenSSL, where `ciphers`
        // configures TLS 1.2 only.
        if kept.iter().any(|s| s.version() == &rustls::version::TLS12) {
            let mut suites: Vec<_> = provider
                .cipher_suites
                .iter()
                .copied()
                .filter(|s| s.version() == &rustls::version::TLS13)
                .collect();
            suites.extend(kept.into_iter().filter(|s| s.version() == &rustls::version::TLS12));
            provider.cipher_suites = suites;
        }
    }
    Arc::new(provider)
}

fn versions_for(options: &Options) -> Result<Vec<&'static rustls::SupportedProtocolVersion>, String> {
    let rank = |name: &str| -> i32 {
        match name {
            "TLSv1" => 10,
            "TLSv1.1" => 11,
            "TLSv1.2" => 12,
            "TLSv1.3" => 13,
            _ => 0,
        }
    };
    let min = options.get("minVersion").map(rank).unwrap_or(12);
    let max = options.get("maxVersion").map(rank).unwrap_or(13);
    let mut out = Vec::new();
    if min <= 12 && max >= 12 {
        out.push(&rustls::version::TLS12);
    }
    if min <= 13 && max >= 13 {
        out.push(&rustls::version::TLS13);
    }
    if out.is_empty() {
        return Err(fail("ERR_SSL_NO_PROTOCOLS_AVAILABLE", "error:0A0000BF:SSL routines::no protocols available"));
    }
    Ok(out)
}

fn roots_from(options: &Options) -> (RootCertStore, Vec<Vec<u8>>) {
    let mut roots = RootCertStore::empty();
    let mut raw = Vec::new();
    for ca in options.all("ca") {
        if let Ok(certs) = parse_certs(&base64::decode(ca)) {
            for cert in certs {
                raw.push(cert.as_ref().to_vec());
                // A CA that webpki cannot use as an anchor (a v1 certificate)
                // is skipped rather than failing the whole store.
                let _ = roots.add(cert);
            }
        }
    }
    (roots, raw)
}

fn alpn_from(options: &Options) -> Vec<Vec<u8>> {
    options
        .get("alpn")
        .map(|list| {
            list.split(GS)
                .filter(|s| !s.is_empty())
                .map(|s| base64::decode(s))
                .collect()
        })
        .unwrap_or_default()
}

fn certified_key(
    provider: &CryptoProvider,
    cert: &str,
    key: &str,
    passphrase: Option<&str>,
) -> Result<CertifiedKey, String> {
    let chain = parse_certs(&base64::decode(cert)).map_err(|m| fail("ERR_OSSL_PEM_NO_START_LINE", &m))?;
    let key = parse_key(&base64::decode(key), passphrase).map_err(|(c, m)| fail(&c, &m))?;
    if chain.is_empty() {
        return Err(fail("ERR_OSSL_PEM_NO_START_LINE", "error:0480006C:PEM routines::no start line"));
    }
    let key_der = key.secret_der().to_vec();
    let signing = provider
        .key_provider
        .load_private_key(key)
        .map_err(|_| fail("ERR_OSSL_UNSUPPORTED", "error:1E08010C:DECODER routines::unsupported"))?;
    if !x509::rsa_key_matches(chain[0].as_ref(), &key_der) {
        return Err(fail(
            "ERR_OSSL_X509_KEY_VALUES_MISMATCH",
            "error:05800074:x509 certificate routines::key values mismatch",
        ));
    }
    let ck = CertifiedKey::new(chain, signing);
    Ok(ck)
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/// The OpenSSL verdict for a chain, `None` when it verifies against `roots`.
fn verdict_for(
    provider: &CryptoProvider,
    roots: &RootCertStore,
    raw_roots: &[Vec<u8>],
    end_entity: &CertificateDer<'_>,
    intermediates: &[CertificateDer<'_>],
) -> Option<(String, String)> {
    // OpenSSL trusts a certificate that is itself in the CA list, which is how
    // a self-signed server certificate is accepted with `ca: [cert]`; webpki
    // would refuse it as an end entity.
    if raw_roots.iter().any(|r| r.as_slice() == end_entity.as_ref()) {
        return None;
    }
    let result = ParsedCertificate::try_from(end_entity).and_then(|parsed| {
        rustls::client::verify_server_cert_signed_by_trust_anchor(
            &parsed,
            roots,
            intermediates,
            UnixTime::now(),
            provider.signature_verification_algorithms.all,
        )
    });
    let error = match result {
        Ok(()) => return None,
        Err(e) => e,
    };
    if let Some(verdict) = verify_v1(provider, raw_roots, end_entity.as_ref()) {
        return verdict;
    }
    let pair = |c: &str, m: &str| Some((c.to_owned(), m.to_owned()));
    match error {
        rustls::Error::InvalidCertificate(CertificateError::Expired)
        | rustls::Error::InvalidCertificate(CertificateError::ExpiredContext { .. }) => {
            pair("CERT_HAS_EXPIRED", "certificate has expired")
        }
        rustls::Error::InvalidCertificate(CertificateError::NotValidYet)
        | rustls::Error::InvalidCertificate(CertificateError::NotValidYetContext { .. }) => {
            pair("CERT_NOT_YET_VALID", "certificate is not yet valid")
        }
        rustls::Error::InvalidCertificate(CertificateError::BadSignature) => {
            pair("CERT_SIGNATURE_FAILURE", "certificate signature failure")
        }
        _ => {
            let leaf_self = x509::self_issued(end_entity.as_ref());
            if leaf_self && intermediates.is_empty() {
                pair("DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed certificate")
            } else if intermediates
                .last()
                .map(|c| x509::self_issued(c.as_ref()))
                .unwrap_or(false)
            {
                pair("SELF_SIGNED_CERT_IN_CHAIN", "self-signed certificate in certificate chain")
            } else if intermediates.is_empty() {
                pair("UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unable to verify the first certificate")
            } else {
                pair("UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "unable to get local issuer certificate")
            }
        }
    }
}

/// A handshake signature check that also accepts a certificate webpki will
/// not parse (an X.509 v1 certificate, which OpenSSL still accepts and Node's
/// fixtures include): on failure the key is read from the certificate here and
/// every algorithm the scheme maps to is tried.
fn verify_any(
    first: Result<HandshakeSignatureValid, rustls::Error>,
    provider: &CryptoProvider,
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
) -> Result<HandshakeSignatureValid, rustls::Error> {
    let error = match first {
        Ok(valid) => return Ok(valid),
        Err(e) => e,
    };
    let Some(key) = x509::public_key_bits(cert.as_ref()) else {
        return Err(error);
    };
    let algs = provider
        .signature_verification_algorithms
        .mapping
        .iter()
        .filter(|(scheme, _)| *scheme == dss.scheme)
        .flat_map(|(_, algs)| algs.iter());
    for alg in algs {
        if alg.verify_signature(&key, message, dss.signature()).is_ok() {
            return Ok(HandshakeSignatureValid::assertion());
        }
    }
    Err(error)
}

/// OpenSSL-style chain check for a leaf webpki rejects outright (a v1
/// certificate): trusted when a CA in the list names its issuer, signed it,
/// and the leaf is within its validity period.
fn verify_v1(provider: &CryptoProvider, raw_roots: &[Vec<u8>], leaf: &[u8]) -> Option<Option<(String, String)>> {
    let (issuer, tbs, sig, from, to) = x509::signed_parts(leaf)?;
    let now = UnixTime::now().as_secs() as i64;
    for root in raw_roots {
        if x509::subject_der(root).as_deref() != Some(issuer.as_slice()) {
            continue;
        }
        let Some(key) = x509::public_key_bits(root) else { continue };
        let ok = provider
            .signature_verification_algorithms
            .all
            .iter()
            .any(|alg| alg.verify_signature(&key, &tbs, &sig).is_ok());
        if ok {
            if now > to {
                return Some(Some(("CERT_HAS_EXPIRED".to_owned(), "certificate has expired".to_owned())));
            }
            if now < from {
                return Some(Some(("CERT_NOT_YET_VALID".to_owned(), "certificate is not yet valid".to_owned())));
            }
            return Some(None);
        }
    }
    None
}

#[derive(Debug)]
struct Verifier {
    provider: Arc<CryptoProvider>,
    roots: RootCertStore,
    raw_roots: Vec<Vec<u8>>,
    verdict: Verdict,
    request: bool,
    hints: Vec<DistinguishedName>,
}

impl Verifier {
    fn record(&self, end_entity: &CertificateDer<'_>, intermediates: &[CertificateDer<'_>]) {
        let v = verdict_for(&self.provider, &self.roots, &self.raw_roots, end_entity, intermediates);
        *self.verdict.lock().unwrap_or_else(|p| p.into_inner()) = v;
    }
}

impl ServerCertVerifier for Verifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        self.record(end_entity, intermediates);
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_any(verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms), &self.provider, message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_any(verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms), &self.provider, message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

impl ClientCertVerifier for Verifier {
    fn offer_client_auth(&self) -> bool {
        self.request
    }

    fn client_auth_mandatory(&self) -> bool {
        false
    }

    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &self.hints
    }

    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, rustls::Error> {
        self.record(end_entity, intermediates);
        Ok(ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_any(verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms), &self.provider, message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_any(verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms), &self.provider, message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// The server certificate resolver: a default key plus `addContext`-style
/// per-host-name keys (`*.example.com` wildcards included).
#[derive(Debug)]
struct Resolver {
    default: Option<Arc<CertifiedKey>>,
    by_name: Vec<(String, Arc<CertifiedKey>)>,
}

fn name_matches(pattern: &str, name: &str) -> bool {
    let pattern = pattern.to_ascii_lowercase();
    let name = name.to_ascii_lowercase();
    if let Some(rest) = pattern.strip_prefix("*.") {
        return name
            .split_once('.')
            .map(|(_, tail)| tail == rest)
            .unwrap_or(false);
    }
    pattern == name
}

impl ResolvesServerCert for Resolver {
    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        if let Some(name) = hello.server_name() {
            // The last context added wins, as in Node's `addContext`.
            for (pattern, key) in self.by_name.iter().rev() {
                if name_matches(pattern, name) {
                    return Some(key.clone());
                }
            }
        }
        self.default.clone()
    }
}

// ---------------------------------------------------------------------------
// Session creation
// ---------------------------------------------------------------------------

fn new_session(is_server: bool, options: &Options) -> Result<Session, String> {
    let provider = provider_for(options);
    let versions = versions_for(options)?;
    let (roots, raw_roots) = roots_from(options);
    let verdict: Verdict = Arc::new(Mutex::new(None));
    let passphrase = options.get("passphrase");
    let alpn = alpn_from(options);

    let conn = if is_server {
        if options.flag("lazy") {
            return Ok(Session {
                conn: None,
                accepting: Some(rustls::server::Acceptor::default()),
                accepted: None,
                pending: Vec::new(),
                verdict,
                eof: false,
                failed: None,
            });
        }
        let config = server_config(options, verdict.clone())?;
        let conn = ServerConnection::new(Arc::new(config))
            .map_err(|e| fail("ERR_SSL_INTERNAL", &e.to_string()))?;
        Connection::Server(conn)
    } else {
        let verifier = Arc::new(Verifier {
            provider: provider.clone(),
            hints: Vec::new(),
            roots,
            raw_roots,
            verdict: verdict.clone(),
            request: false,
        });
        let builder = ClientConfig::builder_with_provider(provider.clone())
            .with_protocol_versions(&versions)
            .map_err(|e| fail("ERR_SSL_NO_PROTOCOLS_AVAILABLE", &e.to_string()))?
            .dangerous()
            .with_custom_certificate_verifier(verifier);
        let mut config = match (options.get("cert"), options.get("key")) {
            (Some(c), Some(k)) => {
                let ck = certified_key(&provider, c, k, passphrase)?;
                builder
                    .with_client_auth_cert(ck.cert.clone(), parse_key(&base64::decode(k), passphrase).map_err(|(c, m)| fail(&c, &m))?)
                    .map_err(|e| fail("ERR_OSSL_UNSUPPORTED", &e.to_string()))?
            }
            _ => builder.with_no_client_auth(),
        };
        config.alpn_protocols = alpn;
        let servername = options.get("servername").unwrap_or("");
        // An empty or IP-literal name sends no SNI, as in Node.
        let name = match ServerName::try_from(servername.to_owned()) {
            Ok(name) if !servername.is_empty() => name,
            _ => ServerName::IpAddress(std::net::Ipv4Addr::new(127, 0, 0, 1).into()),
        };
        config.enable_sni = true;
        let conn = ClientConnection::new(Arc::new(config), name)
            .map_err(|e| fail("ERR_SSL_INTERNAL", &e.to_string()))?;
        Connection::Client(conn)
    };
    Ok(Session {
        conn: Some(conn),
        accepting: None,
        accepted: None,
        pending: Vec::new(),
        verdict,
        eof: false,
        failed: None,
    })
}

/// The server half of [`new_session`]'s configuration.
fn server_config(options: &Options, verdict: Verdict) -> Result<ServerConfig, String> {
    let provider = provider_for(options);
    let versions = versions_for(options)?;
    let (roots, raw_roots) = roots_from(options);
    let passphrase = options.get("passphrase");
    let verifier = Arc::new(Verifier {
        provider: provider.clone(),
        hints: roots.subjects(),
        roots,
        raw_roots,
        verdict,
        request: options.flag("requestCert"),
    });
    let default = match (options.get("cert"), options.get("key")) {
        (Some(c), Some(k)) => Some(Arc::new(certified_key(&provider, c, k, passphrase)?)),
        _ => None,
    };
    let mut by_name = Vec::new();
    for entry in options.all("sni") {
        let parts: Vec<&str> = entry.split(GS).collect();
        if parts.len() == 3 {
            let ck = certified_key(&provider, parts[1], parts[2], passphrase)?;
            by_name.push((parts[0].to_owned(), Arc::new(ck)));
        }
    }
    let builder = ServerConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&versions)
        .map_err(|e| fail("ERR_SSL_NO_PROTOCOLS_AVAILABLE", &e.to_string()))?;
    let mut config = builder
        .with_client_cert_verifier(verifier)
        .with_cert_resolver(Arc::new(Resolver { default, by_name }));
    config.alpn_protocols = alpn_from(options);
    config.ignore_client_order = options.flag("honorCipherOrder");
    Ok(config)
}

/// The `(code, message)` Node reports for a fatal rustls error.
fn error_pair(error: &rustls::Error) -> (String, String) {
    use rustls::AlertDescription as A;
    let alert = |name: &str, num: u32| {
        (
            format!("ERR_SSL_{}", name.to_ascii_uppercase().replace(' ', "_")),
            format!("error:0A000{num:03X}:SSL routines::{name}"),
        )
    };
    match error {
        rustls::Error::AlertReceived(desc) => {
            let (name, num) = match desc {
                A::HandshakeFailure => ("sslv3 alert handshake failure", 0x410),
                A::BadCertificate => ("sslv3 alert bad certificate", 0x412),
                A::CertificateUnknown => ("sslv3 alert certificate unknown", 0x416),
                A::UnknownCA => ("tlsv1 alert unknown ca", 0x418),
                A::ProtocolVersion => ("tlsv1 alert protocol version", 0x42E),
                A::NoApplicationProtocol => ("tlsv1 alert no application protocol", 0x478),
                A::CertificateRequired => ("tlsv13 alert certificate required", 0x474),
                A::DecryptError => ("tlsv1 alert decrypt error", 0x433),
                _ => ("tlsv1 alert internal error", 0x438),
            };
            alert(name, num)
        }
        rustls::Error::NoApplicationProtocol => alert("no application protocol", 0x0EB),
        rustls::Error::PeerIncompatible(_) => alert("no shared cipher", 0x0C1),
        rustls::Error::InvalidMessage(_) => alert("wrong version number", 0x10B),
        rustls::Error::General(m) if m.contains("no server certificate") => alert("no shared cipher", 0x0C1),
        other => {
            let text = other.to_string();
            if text.contains("certificate") && text.contains("chain") {
                alert("no shared cipher", 0x0C1)
            } else {
                ("ERR_SSL_SSL_HANDSHAKE_FAILURE".to_owned(), format!("error:0A000410:SSL routines::{text}"))
            }
        }
    }
}

/// The poll record: `+ done US out US plain US eof`.
fn poll(session: &mut Session) -> String {
    if let Some((c, m)) = &session.failed {
        return fail(c, m);
    }
    let Some(conn) = session.conn.as_mut() else {
        // A lazy server session: `H` once the ClientHello is in, with the
        // requested name as a fifth field.
        if let Some(accepted) = &session.accepted {
            let name = accepted.client_hello().server_name().unwrap_or("").to_owned();
            return format!("+H{US}{US}{US}0{US}{name}");
        }
        return format!("+0{US}{US}{US}0");
    };
    let mut plain = Vec::new();
    let mut buf = [0u8; 16384];
    loop {
        match conn.reader().read(&mut buf) {
            Ok(0) => {
                session.eof = true;
                break;
            }
            Ok(n) => plain.extend_from_slice(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(_) => {
                // Unexpected EOF without close_notify: treated as end.
                session.eof = true;
                break;
            }
        }
    }
    let mut out = Vec::new();
    while conn.wants_write() {
        if conn.write_tls(&mut out).is_err() {
            break;
        }
    }
    let done = !conn.is_handshaking();
    format!(
        "+{}{US}{}{US}{}{US}{}",
        if done { "1" } else { "0" },
        base64::encode(&out),
        base64::encode(&plain),
        if session.eof { "1" } else { "0" }
    )
}

/// Like [`poll`] after a fatal error, but still hands out the alert the
/// engine queued so the TS layer can send it before reporting.
fn fail_after(session: &mut Session, error: &rustls::Error) -> String {
    let mut out = Vec::new();
    if let Some(conn) = session.conn.as_mut() {
        while conn.wants_write() {
            if conn.write_tls(&mut out).is_err() {
                break;
            }
        }
    }
    let (code, message) = error_pair(error);
    session.failed = Some((code.clone(), message.clone()));
    crate::abi::fail_system("", &code, 0, &message);
    // The pending alert is returned through a separate call (`tlsTakeAlert`).
    ALERT.with(|slot| *slot.borrow_mut() = out);
    "-".to_owned()
}

thread_local! {
    static ALERT: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
}

// ---------------------------------------------------------------------------
// Natives
// ---------------------------------------------------------------------------

macro_rules! str_arg {
    ($args:expr, $n:expr, $i:expr) => {
        match unsafe { arg_str($args, $n, $i) } {
            Ok(text) => text,
            Err(status) => return status,
        }
    };
}

/// `tlsSessionNew(isServer, options)` → `+<handle>`.
unsafe extern "C" fn session_new(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let is_server = unsafe { arg_bool(args, n, 0) };
    let options = Options::parse(str_arg!(args, n, 1));
    let payload = match new_session(is_server, &options) {
        Ok(session) => {
            let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
            with_sessions(|t| t.insert(handle, session));
            format!("+{handle}")
        }
        Err(failure) => failure,
    };
    unsafe { ret_str(out, &payload) }
}

/// `tlsCheckOptions(isServer, options)` → `+` or `-`: builds a session and
/// drops it, which is how `createSecureContext` reports a bad key at once.
unsafe extern "C" fn check_options(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let is_server = unsafe { arg_bool(args, n, 0) };
    let options = Options::parse(str_arg!(args, n, 1));
    let payload = match new_session(is_server, &options) {
        Ok(_) => "+".to_owned(),
        Err(failure) => failure,
    };
    unsafe { ret_str(out, &payload) }
}

/// `tlsFeed(handle, ciphertext)` → poll record. `ciphertext` is base64.
unsafe extern "C" fn feed(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let handle = unsafe { arg_i64(args, n, 0) };
    let bytes = base64::decode(str_arg!(args, n, 1));
    let payload = with_sessions(|t| {
        let Some(session) = t.get_mut(&handle) else {
            return fail("ERR_TLS_INVALID_STATE", "TLS session is closed");
        };
        if session.failed.is_some() {
            return poll(session);
        }
        feed_bytes(session, &bytes)
    });
    unsafe { ret_str(out, &payload) }
}

fn feed_bytes(session: &mut Session, bytes: &[u8]) -> String {
    if session.accepted.is_some() {
        session.pending.extend_from_slice(bytes);
        return poll(session);
    }
    let mut cursor: &[u8] = bytes;
    if let Some(acceptor) = session.accepting.as_mut() {
        while !cursor.is_empty() {
            match acceptor.read_tls(&mut cursor) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
        return match acceptor.accept() {
            Ok(None) => poll(session),
            Ok(Some(accepted)) => {
                session.accepting = None;
                session.accepted = Some(accepted);
                poll(session)
            }
            Err((error, mut alert)) => {
                let mut out = Vec::new();
                let _ = alert.write(&mut out);
                session.accepting = None;
                let r = fail_after(session, &error);
                ALERT.with(|slot| *slot.borrow_mut() = out);
                r
            }
        };
    }
    let Some(conn) = session.conn.as_mut() else {
        return poll(session);
    };
    while !cursor.is_empty() {
        match conn.read_tls(&mut cursor) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        if let Err(error) = conn.process_new_packets() {
            return fail_after(session, &error);
        }
    }
    poll(session)
}

/// `tlsServerAccept(handle, options)` → poll record: finish a lazy server
/// session's ClientHello with the context `options` describes (the one
/// `SNICallback` chose).
unsafe extern "C" fn server_accept(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let handle = unsafe { arg_i64(args, n, 0) };
    let options = Options::parse(str_arg!(args, n, 1));
    let payload = with_sessions(|t| {
        let Some(session) = t.get_mut(&handle) else {
            return fail("ERR_TLS_INVALID_STATE", "TLS session is closed");
        };
        let Some(accepted) = session.accepted.take() else {
            return poll(session);
        };
        let config = match server_config(&options, session.verdict.clone()) {
            Ok(config) => config,
            Err(failure) => return failure,
        };
        match accepted.into_connection(Arc::new(config)) {
            Ok(conn) => {
                session.conn = Some(Connection::Server(conn));
                let pending = std::mem::take(&mut session.pending);
                feed_bytes(session, &pending)
            }
            Err((error, mut alert)) => {
                let mut out = Vec::new();
                let _ = alert.write(&mut out);
                let r = fail_after(session, &error);
                ALERT.with(|slot| *slot.borrow_mut() = out);
                r
            }
        }
    });
    unsafe { ret_str(out, &payload) }
}

/// `tlsWrite(handle, plaintext)` → poll record.
unsafe extern "C" fn write(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let handle = unsafe { arg_i64(args, n, 0) };
    let bytes = base64::decode(str_arg!(args, n, 1));
    let payload = with_sessions(|t| {
        let Some(session) = t.get_mut(&handle) else {
            return fail("ERR_TLS_INVALID_STATE", "TLS session is closed");
        };
        if let Some(conn) = session.conn.as_mut() {
            let _ = conn.writer().write_all(&bytes);
        }
        poll(session)
    });
    unsafe { ret_str(out, &payload) }
}

/// `tlsPoll(handle)` → poll record.
unsafe extern "C" fn poll_native(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let handle = unsafe { arg_i64(args, n, 0) };
    let payload = with_sessions(|t| match t.get_mut(&handle) {
        Some(session) => poll(session),
        None => fail("ERR_TLS_INVALID_STATE", "TLS session is closed"),
    });
    unsafe { ret_str(out, &payload) }
}

/// `tlsCloseNotify(handle)` → poll record carrying the `close_notify` alert.
unsafe extern "C" fn close_notify(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let handle = unsafe { arg_i64(args, n, 0) };
    let payload = with_sessions(|t| match t.get_mut(&handle) {
        Some(session) => {
            if let Some(conn) = session.conn.as_mut() {
                conn.send_close_notify();
            }
            poll(session)
        }
        None => fail("ERR_TLS_INVALID_STATE", "TLS session is closed"),
    });
    unsafe { ret_str(out, &payload) }
}

/// `tlsTakeAlert()` → base64 of the alert a failed `tlsFeed` left queued.
unsafe extern "C" fn take_alert(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    let bytes = ALERT.with(|slot| std::mem::take(&mut *slot.borrow_mut()));
    unsafe { ret_str(out, &base64::encode(&bytes)) }
}

/// `tlsFree(handle)` → `+`.
unsafe extern "C" fn free(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let handle = unsafe { arg_i64(args, n, 0) };
    with_sessions(|t| t.remove(&handle));
    unsafe { ret_str(out, "+") }
}

fn version_name(v: rustls::ProtocolVersion) -> &'static str {
    match v {
        rustls::ProtocolVersion::TLSv1_3 => "TLSv1.3",
        rustls::ProtocolVersion::TLSv1_2 => "TLSv1.2",
        rustls::ProtocolVersion::TLSv1_1 => "TLSv1.1",
        rustls::ProtocolVersion::TLSv1_0 => "TLSv1",
        _ => "unknown",
    }
}

/// `(OpenSSL name, IANA name, version that introduced it)`.
pub(crate) fn cipher_names(suite: rustls::CipherSuite) -> (&'static str, &'static str, &'static str) {
    use rustls::CipherSuite as C;
    match suite {
        C::TLS13_AES_256_GCM_SHA384 => ("TLS_AES_256_GCM_SHA384", "TLS_AES_256_GCM_SHA384", "TLSv1.3"),
        C::TLS13_AES_128_GCM_SHA256 => ("TLS_AES_128_GCM_SHA256", "TLS_AES_128_GCM_SHA256", "TLSv1.3"),
        C::TLS13_CHACHA20_POLY1305_SHA256 => ("TLS_CHACHA20_POLY1305_SHA256", "TLS_CHACHA20_POLY1305_SHA256", "TLSv1.3"),
        C::TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384 => ("ECDHE-ECDSA-AES256-GCM-SHA384", "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384", "TLSv1.2"),
        C::TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256 => ("ECDHE-ECDSA-AES128-GCM-SHA256", "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256", "TLSv1.2"),
        C::TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256 => ("ECDHE-ECDSA-CHACHA20-POLY1305", "TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256", "TLSv1.2"),
        C::TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384 => ("ECDHE-RSA-AES256-GCM-SHA384", "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384", "TLSv1.2"),
        C::TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256 => ("ECDHE-RSA-AES128-GCM-SHA256", "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256", "TLSv1.2"),
        C::TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256 => ("ECDHE-RSA-CHACHA20-POLY1305", "TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256", "TLSv1.2"),
        _ => ("unknown", "unknown", "unknown"),
    }
}

/// `tlsInfo(handle)` →
/// `+ protocol US cipher US standardName US cipherVersion US alpn(b64) US
/// servername US verifyCode US verifyMessage US peerChain(b64 GS ...)`.
unsafe extern "C" fn info(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let handle = unsafe { arg_i64(args, n, 0) };
    let payload = with_sessions(|t| {
        let Some(session) = t.get(&handle) else {
            return fail("ERR_TLS_INVALID_STATE", "TLS session is closed");
        };
        let Some(conn) = session.conn.as_ref() else {
            return fail("ERR_TLS_INVALID_STATE", "TLS handshake has not started");
        };
        let protocol = conn.protocol_version().map(version_name).unwrap_or("");
        let (cipher, standard, cver) = conn
            .negotiated_cipher_suite()
            .map(|s| cipher_names(s.suite()))
            .unwrap_or(("", "", ""));
        let alpn = conn.alpn_protocol().map(base64::encode).unwrap_or_default();
        let servername = match conn {
            Connection::Server(s) => s.server_name().unwrap_or("").to_owned(),
            Connection::Client(_) => String::new(),
        };
        let (vcode, vmsg) = session
            .verdict
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .unwrap_or_default();
        let chain: Vec<String> = conn
            .peer_certificates()
            .map(|certs| certs.iter().map(|c| base64::encode(c.as_ref())).collect())
            .unwrap_or_default();
        let chain = chain.join(&GS.to_string());
        format!("+{protocol}{US}{cipher}{US}{standard}{US}{cver}{US}{alpn}{US}{servername}{US}{vcode}{US}{vmsg}{US}{chain}")
    });
    unsafe { ret_str(out, &payload) }
}

/// `tlsParseCert(der)` → the `getPeerCertificate()` record; see
/// [`x509::describe`].
unsafe extern "C" fn parse_cert(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let der = base64::decode(str_arg!(args, n, 0));
    let payload = match x509::describe(&der) {
        Some(text) => format!("+{text}"),
        None => fail("ERR_TLS_CERT", "unable to parse certificate"),
    };
    unsafe { ret_str(out, &payload) }
}

/// `tlsPemToDer(pem)` → `+ b64 GS b64 ...`: the certificates a PEM (or DER)
/// byte string holds, which is how `ca`/`cert` arrays are normalised.
unsafe extern "C" fn pem_to_der(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let bytes = base64::decode(str_arg!(args, n, 0));
    let payload = match parse_certs(&bytes) {
        Ok(certs) => {
            let parts: Vec<String> = certs.iter().map(|c| base64::encode(c.as_ref())).collect();
            format!("+{}", parts.join(&GS.to_string()))
        }
        Err(m) => fail("ERR_OSSL_PEM_NO_START_LINE", &m),
    };
    unsafe { ret_str(out, &payload) }
}

pub(crate) const DESCRIPTORS: &[Descriptor] = &[
    Descriptor { key: b"tlsSessionNew\0", params: &[Bool, Str], ret: Str, invoke: session_new },
    Descriptor { key: b"tlsCheckOptions\0", params: &[Bool, Str], ret: Str, invoke: check_options },
    Descriptor { key: b"tlsFeed\0", params: &[I64, Str], ret: Str, invoke: feed },
    Descriptor { key: b"tlsServerAccept\0", params: &[I64, Str], ret: Str, invoke: server_accept },
    Descriptor { key: b"tlsWrite\0", params: &[I64, Str], ret: Str, invoke: write },
    Descriptor { key: b"tlsPoll\0", params: &[I64], ret: Str, invoke: poll_native },
    Descriptor { key: b"tlsCloseNotify\0", params: &[I64], ret: Str, invoke: close_notify },
    Descriptor { key: b"tlsTakeAlert\0", params: &[], ret: Str, invoke: take_alert },
    Descriptor { key: b"tlsFree\0", params: &[I64], ret: Str, invoke: free },
    Descriptor { key: b"tlsInfo\0", params: &[I64], ret: Str, invoke: info },
    Descriptor { key: b"tlsParseCert\0", params: &[Str], ret: Str, invoke: parse_cert },
    Descriptor { key: b"tlsPemToDer\0", params: &[Str], ret: Str, invoke: pem_to_der },
    Descriptor { key: b"tlsErrorCode\0", params: &[], ret: Str, invoke: crate::last_error_code },
    Descriptor { key: b"tlsErrorMessage\0", params: &[], ret: Str, invoke: crate::last_error_message },
];
