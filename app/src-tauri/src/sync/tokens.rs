//! Secret storage for credentials and OAuth tokens.
//!
//! The OS keychain stores one AES-256-GCM master key. Account and provider
//! credentials live as authenticated ciphertext in the local database, so a
//! process unlocks Keychain once instead of once per account. Older per-secret
//! Keychain entries migrate lazily and are deleted only after verified storage.

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
/// Cached for the process lifetime so macOS asks for Keychain access at most once.
static MASTER_KEY: OnceLock<Option<[u8; 32]>> = OnceLock::new();

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

fn load_or_create_master_key() -> Option<[u8; 32]> {
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

fn cached_master_key<F>(cache: &OnceLock<Option<[u8; 32]>>, load: F) -> Option<[u8; 32]>
where
    F: FnOnce() -> Option<[u8; 32]>,
{
    *cache.get_or_init(load)
}

/// Fetch the keychain-held master key once for this process.
fn master_key() -> Option<[u8; 32]> {
    cached_master_key(&MASTER_KEY, load_or_create_master_key)
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

fn persist_encrypted(account_id: &str, kind: &str, value: &str) -> bool {
    let Some(db) = DB.get() else { return false };
    let Some(encrypted) = encrypt_secret(value) else { return false };
    if db.set_secret(&db_key(account_id, kind), &encrypted).is_err() {
        return false;
    }
    db.get_secret(&db_key(account_id, kind))
        .and_then(|stored| decrypt_secret(&stored))
        .is_some_and(|stored| stored == value)
}

fn delete_legacy(account_id: &str, kind: &str) {
    if let Ok(entry) = entry(account_id, kind) {
        let _ = entry.delete_credential();
    }
}

fn resolve_secret<FReadLegacy, FPersist, FDeleteLegacy>(
    encrypted: Option<String>,
    read_legacy: FReadLegacy,
    persist: FPersist,
    delete_legacy: FDeleteLegacy,
) -> Option<String>
where
    FReadLegacy: FnOnce() -> Option<String>,
    FPersist: FnOnce(&str) -> bool,
    FDeleteLegacy: FnOnce(),
{
    if encrypted.is_some() {
        return encrypted;
    }
    let legacy = read_legacy()?;
    if persist(&legacy) {
        delete_legacy();
    }
    Some(legacy)
}

/// Write an encrypted secret and verify it before removing a legacy entry.
fn put(account_id: &str, kind: &str, value: &str) -> Result<(), String> {
    if !persist_encrypted(account_id, kind, value) {
        return Err("Secure credential storage is unavailable".into());
    }
    delete_legacy(account_id, kind);
    Ok(())
}

/// Read encrypted storage first, migrating a legacy Keychain entry only when needed.
fn get(account_id: &str, kind: &str) -> Option<String> {
    let encrypted = DB
        .get()
        .and_then(|db| db.get_secret(&db_key(account_id, kind)))
        .and_then(|stored| decrypt_secret(&stored));
    resolve_secret(
        encrypted,
        || entry(account_id, kind).ok()?.get_password().ok(),
        |legacy| persist_encrypted(account_id, kind, legacy),
        || delete_legacy(account_id, kind),
    )
}

pub fn save(account_id: &str, access: &str, refresh: Option<&str>) -> Result<(), String> {
    put(account_id, "access", access)?;
    if let Some(r) = refresh {
        put(account_id, "refresh", r)?;
    }
    Ok(())
}

pub fn access_token(account_id: &str) -> Option<String> {
    get(account_id, "access")
}

pub fn refresh_token(account_id: &str) -> Option<String> {
    get(account_id, "refresh")
}

pub fn clear(account_id: &str) {
    for kind in ["access", "refresh", "imap-pass", "smtp-pass"] {
        delete_legacy(account_id, kind);
        if let Some(db) = DB.get() {
            db.delete_secret(&db_key(account_id, kind));
        }
    }
}

/// Store/read a password by kind (e.g. "imap-pass", "smtp-pass").
pub fn save_secret(account_id: &str, kind: &str, value: &str) -> Result<(), String> {
    put(account_id, kind, value)
}

pub fn secret(account_id: &str, kind: &str) -> Option<String> {
    get(account_id, kind)
}

/// Store a write-only AI provider key and verify that at least one secure
/// backend can read it back. The value is never logged or returned.
pub fn save_ai_key(provider_id: &str, value: &str) -> Result<(), String> {
    put(provider_id, "ai-api-key", value)
}

pub fn ai_key(provider_id: &str) -> Option<String> {
    get(provider_id, "ai-api-key")
}

pub fn delete_ai_key(provider_id: &str) -> Result<(), String> {
    delete_legacy(provider_id, "ai-api-key");
    if let Some(db) = DB.get() {
        db.delete_secret(&db_key(provider_id, "ai-api-key"));
    }
    if get(provider_id, "ai-api-key").is_some() {
        Err("Could not remove the provider credential".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::sync::OnceLock;

    use super::{cached_master_key, resolve_secret};

    #[test]
    fn master_key_loader_runs_once_per_cache() {
        let cache = OnceLock::new();
        let loads = Cell::new(0);
        let first = cached_master_key(&cache, || {
            loads.set(loads.get() + 1);
            Some([7; 32])
        });
        let second = cached_master_key(&cache, || {
            loads.set(loads.get() + 1);
            Some([9; 32])
        });
        assert_eq!(first, Some([7; 32]));
        assert_eq!(second, Some([7; 32]));
        assert_eq!(loads.get(), 1);
    }

    #[test]
    fn encrypted_value_skips_legacy_keychain_read() {
        let legacy_reads = Cell::new(0);
        let value = resolve_secret(
            Some("encrypted-value".into()),
            || {
                legacy_reads.set(legacy_reads.get() + 1);
                Some("legacy".into())
            },
            |_| false,
            || {},
        );
        assert_eq!(value.as_deref(), Some("encrypted-value"));
        assert_eq!(legacy_reads.get(), 0);
    }

    #[test]
    fn legacy_value_is_deleted_only_after_verified_persist() {
        let deletes = Cell::new(0);
        let value = resolve_secret(
            None,
            || Some("legacy".into()),
            |candidate| candidate == "legacy",
            || deletes.set(deletes.get() + 1),
        );
        assert_eq!(value.as_deref(), Some("legacy"));
        assert_eq!(deletes.get(), 1);
    }

    #[test]
    fn failed_persist_keeps_legacy_value() {
        let deletes = Cell::new(0);
        let value = resolve_secret(
            None,
            || Some("legacy".into()),
            |_| false,
            || deletes.set(deletes.get() + 1),
        );
        assert_eq!(value.as_deref(), Some("legacy"));
        assert_eq!(deletes.get(), 0);
    }
}
