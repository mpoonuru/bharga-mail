//! Secret storage for credentials and OAuth tokens.
//!
//! The OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret
//! Service) is the primary, most-secure store. But an **unsigned** desktop app
//! gets a new code signature on every rebuild, and macOS ties keychain ACLs to
//! that signature — so a freshly rebuilt app can't read what the previous build
//! saved, which was silently wiping the account on every new build. To fix that
//! we also persist secrets in the local SQLite DB and read keychain-first,
//! DB-fallback. The DB copy is AES-256-GCM **encrypted at rest** under a master
//! key held in the keychain — secrets are never stored as plaintext on disk.

use std::sync::{Arc, OnceLock};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use keyring::Entry;
use rand::RngCore;

use crate::store::Store;

const SERVICE: &str = "io.github.mpoonuru.bharga";
/// Keychain entry name holding the 32-byte AES master key for the DB fallback.
const MASTER_KEY_KIND: &str = "db-master-key";

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

// ---- At-rest encryption for the DB fallback ------------------------------
// The keychain stores secrets already encrypted by the OS, but the DB fallback
// must NOT hold plaintext. We encrypt DB values with AES-256-GCM under a 32-byte
// master key that itself lives in the keychain. If the key is unavailable (e.g.
// an unsigned rebuild), we simply can't read the fallback — but never plaintext.

/// Fetch (or, on first use, generate + store) the keychain-held master key.
fn master_key() -> Option<[u8; 32]> {
    let e = Entry::new(SERVICE, MASTER_KEY_KIND).ok()?;
    if let Ok(b64) = e.get_password() {
        if let Ok(bytes) = B64.decode(b64) {
            if bytes.len() == 32 {
                let mut k = [0u8; 32];
                k.copy_from_slice(&bytes);
                return Some(k);
            }
        }
    }
    let mut k = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut k);
    e.set_password(&B64.encode(k)).ok()?; // don't encrypt-and-orphan if we can't persist the key
    Some(k)
}

/// "v1:" + base64(nonce(12) || ciphertext+tag). None if no master key available.
fn encrypt_secret(plain: &str) -> Option<String> {
    let key = master_key()?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let mut nonce = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), plain.as_bytes())
        .ok()?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    Some(format!("v1:{}", B64.encode(out)))
}

fn decrypt_secret(stored: &str) -> Option<String> {
    let body = stored.strip_prefix("v1:")?;
    let raw = B64.decode(body).ok()?;
    if raw.len() < 12 {
        return None;
    }
    let key = master_key()?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let (nonce, ct) = raw.split_at(12);
    let pt = cipher.decrypt(Nonce::from_slice(nonce), ct).ok()?;
    String::from_utf8(pt).ok()
}

/// Write a secret to the keychain (best-effort) and the encrypted DB fallback.
fn put(account_id: &str, kind: &str, value: &str) {
    if let Ok(e) = entry(account_id, kind) {
        let _ = e.set_password(value);
    }
    if let Some(db) = DB.get() {
        // Only ever persist ciphertext. If encryption is unavailable (no keychain),
        // skip the DB fallback rather than writing plaintext.
        if let Some(enc) = encrypt_secret(value) {
            let _ = db.set_secret(&db_key(account_id, kind), &enc);
        }
    }
}

/// Read a secret: keychain first (most secure when accessible), then the
/// encrypted DB fallback. Non-decryptable rows yield None — never plaintext.
fn get(account_id: &str, kind: &str) -> Option<String> {
    if let Ok(e) = entry(account_id, kind) {
        if let Ok(v) = e.get_password() {
            return Some(v);
        }
    }
    let stored = DB
        .get()
        .and_then(|db| db.get_secret(&db_key(account_id, kind)))?;
    decrypt_secret(&stored)
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

/// Store a write-only AI provider key and verify that at least one secure
/// backend can read it back. The value is never logged or returned.
pub fn save_ai_key(provider_id: &str, value: &str) -> Result<(), String> {
    put(provider_id, "ai-api-key", value);
    match get(provider_id, "ai-api-key") {
        Some(stored) if stored == value => Ok(()),
        _ => Err("Secure credential storage is unavailable".into()),
    }
}

pub fn ai_key(provider_id: &str) -> Option<String> {
    get(provider_id, "ai-api-key")
}

pub fn delete_ai_key(provider_id: &str) -> Result<(), String> {
    if let Ok(e) = entry(provider_id, "ai-api-key") {
        let _ = e.delete_credential();
    }
    if let Some(db) = DB.get() {
        db.delete_secret(&db_key(provider_id, "ai-api-key"));
    }
    if get(provider_id, "ai-api-key").is_some() {
        Err("Could not remove the provider credential".into())
    } else {
        Ok(())
    }
}
