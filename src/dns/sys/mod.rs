//! The platform contract behind `node:dns`: one set of plain Rust functions,
//! implemented twice.
//!
//! Everything above this module (`addrinfo.rs`, `config.rs`, `resolve.rs`) is
//! platform-independent; everything below it is syscalls. Both implementations
//! answer the same signatures and are written against libuv's behavior, because
//! that is what Node's `dns` exposes: `uv_getaddrinfo` and `uv_getnameinfo` on
//! one side, c-ares' `ares_init_options` server discovery on the other.
//!
//! `std::net::ToSocketAddrs` is deliberately not the route. It is a
//! `getaddrinfo` call with the hints fixed: no `ai_flags`, so `AI_ADDRCONFIG` /
//! `AI_ALL` / `AI_V4MAPPED` — which `dns.lookup(host, { hints })` exists to
//! pass — cannot be expressed, no `ai_family` beyond "whatever both", and no
//! access to the error *code*, which is the whole payload of a failed
//! `dns.lookup`. libuv calls the raw entry point for the same reasons, so this
//! module does too.

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(in crate::dns) use windows::*;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub(in crate::dns) use unix::*;

/// One resolver the machine is configured with, as c-ares' server list sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::dns) struct Server {
    pub(in crate::dns) address: String,
    pub(in crate::dns) port: u16,
}
