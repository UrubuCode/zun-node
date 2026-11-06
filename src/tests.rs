//! Crate-level tests of the registration entry point itself.
//!
//! The per-module behavior is tested beside the module (`src/fs/tests.rs`,
//! `src/os/tests.rs`), each driving the real `zun_abi` registration +
//! checked-invocation path. What is left here is what belongs to no single
//! module: that `zun_register_v1` validates its registry, and that the modules
//! it publishes are all there.

use zun_abi::{OwnedRegistry, ZUN_ABI_V1};

use super::zun_register_v1;

#[test]
fn registration_publishes_every_module() {
    let mut owned = OwnedRegistry::new();
    let mut host = owned.as_registry();
    assert_eq!(unsafe { zun_register_v1(&mut host) }, 0);

    assert!(owned.module("node:fs").func("fsReadFile").is_some());
    assert!(owned.module("node:os").func("hostname").is_some());
}

#[test]
fn a_null_or_mismatched_registry_is_refused() {
    assert_eq!(unsafe { zun_register_v1(std::ptr::null_mut()) }, -1);

    let mut owned = OwnedRegistry::new();
    let mut host = owned.as_registry();
    host.abi_version = ZUN_ABI_V1 + 1;
    assert_eq!(unsafe { zun_register_v1(&mut host) }, -1);
}
