//! Secret storage for credentials and OAuth tokens.
//!
//! The OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret
//! Service) is the primary, most-secure store. But an **unsigned** desktop app
//! gets a new code signature on every rebuild, and macOS ties keychain ACLs to
//! that signature — so a freshly rebuilt app can't read what the previous build
//! saved, which was silently wiping the account on every new build. To fix that
//! we also persist secrets in the local SQLite DB (keyed off the stable app
//! identifier, so it survives rebuilds) and read keychain-first, DB-fallback.

use std::sync::{Arc, OnceLock};

use keyring::Entry;

use crate::store::Store;

const SERVICE: &str = "de.pjtelesoft.aethermail";

/// Process-wide store handle for the DB fallback. Set once at startup.
static DB: OnceLock<Arc<Store>> = OnceLock::new();

/// Wire up the DB-backed fallback. Call once during app setup.
pub fn init_db(store: Arc<Store>) {
    let _ = DB.set(store);
}

fn db_key(account_id: &str, kind: &str) -> String {
    format!("{account_id}:{kind}")
}

fn entry(account_id: &str, kind: &str) -> keyring::Result<Entry> {
    Entry::new(SERVICE, &db_key(account_id, kind))
}

/// Write a secret to the keychain (best-effort) and the DB fallback (reliable).
fn put(account_id: &str, kind: &str, value: &str) {
    if let Ok(e) = entry(account_id, kind) {
        let _ = e.set_password(value);
    }
    if let Some(db) = DB.get() {
        let _ = db.set_secret(&db_key(account_id, kind), value);
    }
}

/// Read a secret: keychain first (most secure when accessible), then the DB
/// fallback (which survives unsigned-app rebuilds).
fn get(account_id: &str, kind: &str) -> Option<String> {
    if let Ok(e) = entry(account_id, kind) {
        if let Ok(v) = e.get_password() {
            return Some(v);
        }
    }
    DB.get().and_then(|db| db.get_secret(&db_key(account_id, kind)))
}

pub fn save(account_id: &str, access: &str, refresh: Option<&str>) {
    put(account_id, "access", access);
    if let Some(r) = refresh {
        put(account_id, "refresh", r);
    }
}

pub fn access_token(account_id: &str) -> Option<String> {
    get(account_id, "access")
}

pub fn refresh_token(account_id: &str) -> Option<String> {
    get(account_id, "refresh")
}

pub fn clear(account_id: &str) {
    for kind in ["access", "refresh", "imap-pass", "smtp-pass"] {
        if let Ok(e) = entry(account_id, kind) {
            let _ = e.delete_credential();
        }
        if let Some(db) = DB.get() {
            db.delete_secret(&db_key(account_id, kind));
        }
    }
}

/// Store/read a password by kind (e.g. "imap-pass", "smtp-pass").
pub fn save_secret(account_id: &str, kind: &str, value: &str) {
    put(account_id, kind, value);
}

pub fn secret(account_id: &str, kind: &str) -> Option<String> {
    get(account_id, kind)
}
