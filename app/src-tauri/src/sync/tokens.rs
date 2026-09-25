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

fn load_or_create_master_key_with<FRead, FCanCreate, FWrite>(
    read: FRead,
    can_create: FCanCreate,
    write: FWrite,
) -> Result<[u8; 32], String>
where
    FRead: FnOnce() -> Result<Option<String>, String>,
    FCanCreate: FnOnce() -> Result<bool, String>,
    FWrite: FnOnce(&str) -> Result<(), String>,
{
    if let Some(b64) = read()? {
        let bytes = B64
            .decode(b64)
            .map_err(|_| "Stored credential key is malformed".to_string())?;
        if bytes.len() != 32 {
            return Err("Stored credential key has an invalid length".into());
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&bytes);
        return Ok(key);
    }

    if !can_create()? {
        return Err(
            "Credential recovery is required before a new master key can be created".into(),
        );
    }
    let mut k = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut k);
    write(&B64.encode(k))?; // don't encrypt-and-orphan if we can't persist the key
    Ok(k)
}

fn load_or_create_master_key() -> Option<[u8; 32]> {
    let e = Entry::new(SERVICE, MASTER_KEY_KIND).ok()?;
    load_or_create_master_key_with(
        || match e.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Credential key access is unavailable".into()),
        },
        || {
            let db = DB
                .get()
                .ok_or_else(|| "Credential database is unavailable".to_string())?;
            db.has_encrypted_secrets()
                .map(|has_encrypted| !has_encrypted)
                .map_err(|_| "Credential recovery state could not be checked".into())
        },
        |value| {
            e.set_password(value)
                .map_err(|_| "Credential key could not be stored".into())
        },
    )
    .ok()
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

/// "v1:" + base64(nonce(12) || ciphertext+tag).
fn encrypt_secret(plain: &str) -> Result<String, String> {
    let key = master_key().ok_or_else(|| "Secure credential storage is unavailable".to_string())?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let mut nonce = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), plain.as_bytes())
        .map_err(|_| "Credential encryption failed".to_string())?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    Ok(format!("v1:{}", B64.encode(out)))
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
    let Ok(encrypted) = encrypt_secret(value) else {
        return false;
    };
    if db
        .set_secret(&db_key(account_id, kind), &encrypted)
        .is_err()
    {
        return false;
    }
    db.get_secret(&db_key(account_id, kind))
        .and_then(|stored| decrypt_secret(&stored))
        .is_some_and(|stored| stored == value)
}

fn prepare_secret_updates_with<F>(
    updates: &[(&str, &str)],
    mut encrypt: F,
) -> Result<Vec<(String, String)>, String>
where
    F: FnMut(&str) -> Result<String, String>,
{
    updates
        .iter()
        .map(|(kind, value)| encrypt(value).map(|encrypted| ((*kind).to_string(), encrypted)))
        .collect()
}

/// Encrypt a complete credential batch before any account/configuration rows
/// are changed. A failure leaves the database untouched.
pub fn prepare_secret_updates(updates: &[(&str, &str)]) -> Result<Vec<(String, String)>, String> {
    prepare_secret_updates_with(updates, encrypt_secret)
}

fn delete_legacy(account_id: &str, kind: &str) -> Result<(), String> {
    let item = entry(account_id, kind)
        .map_err(|_| "Credential keychain entry is unavailable".to_string())?;
    match item.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Credential could not be removed from the OS keychain".into()),
    }
}

fn legacy_exists(account_id: &str, kind: &str) -> Result<bool, String> {
    let item = entry(account_id, kind)
        .map_err(|_| "Credential keychain entry is unavailable".to_string())?;
    match item.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(_) => Err("Credential removal could not be verified in the OS keychain".into()),
    }
}

/// Remove a migrated per-secret Keychain value after its encrypted DB batch commits.
pub fn delete_legacy_secret(account_id: &str, kind: &str) -> Result<(), String> {
    delete_legacy(account_id, kind)
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
    let _ = delete_legacy(account_id, kind);
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
        || {
            let _ = delete_legacy(account_id, kind);
        },
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

fn clear_kind_with<FDeleteEncrypted, FDeleteLegacy, FEncryptedExists, FLegacyExists>(
    delete_encrypted: FDeleteEncrypted,
    delete_legacy_value: FDeleteLegacy,
    encrypted_exists: FEncryptedExists,
    legacy_value_exists: FLegacyExists,
) -> Result<(), String>
where
    FDeleteEncrypted: FnOnce() -> Result<(), String>,
    FDeleteLegacy: FnOnce() -> Result<(), String>,
    FEncryptedExists: FnOnce() -> Result<bool, String>,
    FLegacyExists: FnOnce() -> Result<bool, String>,
{
    let encrypted_result = delete_encrypted();
    let legacy_result = delete_legacy_value();
    encrypted_result?;
    legacy_result?;
    if encrypted_exists()? || legacy_value_exists()? {
        return Err("Credential cleanup could not be verified".into());
    }
    Ok(())
}

/// Remove every credential for an account and verify both storage backends.
/// Failures are propagated so the account row remains available for retry.
pub fn clear(account_id: &str) -> Result<(), String> {
    for kind in ["access", "refresh", "imap-pass", "smtp-pass"] {
        let encrypted_key = db_key(account_id, kind);
        clear_kind_with(
            || match DB.get() {
                Some(db) => db
                    .delete_secret(&encrypted_key)
                    .map_err(|_| "Encrypted credential could not be removed".into()),
                None => Ok(()),
            },
            || delete_legacy(account_id, kind),
            || {
                Ok(DB
                    .get()
                    .is_some_and(|db| db.get_secret(&encrypted_key).is_some()))
            },
            || legacy_exists(account_id, kind),
        )?;
    }
    Ok(())
}

/// Store/read a password by kind (e.g. "imap-pass", "smtp-pass").
pub fn save_secret(account_id: &str, kind: &str, value: &str) -> Result<(), String> {
    put(account_id, kind, value)
}

pub fn secret(account_id: &str, kind: &str) -> Option<String> {
    get(account_id, kind)
}

/// Read an isolated calendar credential. Mail token namespaces are never used.
pub fn calendar_secret(source_id: &str, kind: &str) -> Option<String> {
    get(&format!("calendar:{source_id}"), kind)
}

/// Remove and verify every supported credential for a calendar source.
pub fn clear_calendar_credentials(source_id: &str) -> Result<(), String> {
    let credential_id = format!("calendar:{source_id}");
    for kind in ["username", "password", "access", "refresh"] {
        let encrypted_key = db_key(&credential_id, kind);
        clear_kind_with(
            || match DB.get() {
                Some(db) => db
                    .delete_secret(&encrypted_key)
                    .map_err(|_| "Encrypted calendar credential could not be removed".into()),
                None => Ok(()),
            },
            || delete_legacy(&credential_id, kind),
            || {
                Ok(DB
                    .get()
                    .is_some_and(|db| db.get_secret(&encrypted_key).is_some()))
            },
            || legacy_exists(&credential_id, kind),
        )?;
    }
    Ok(())
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
    let encrypted_key = db_key(provider_id, "ai-api-key");
    clear_kind_with(
        || match DB.get() {
            Some(db) => db
                .delete_secret(&encrypted_key)
                .map_err(|_| "Encrypted provider credential could not be removed".into()),
            None => Ok(()),
        },
        || delete_legacy(provider_id, "ai-api-key"),
        || {
            Ok(DB
                .get()
                .is_some_and(|db| db.get_secret(&encrypted_key).is_some()))
        },
        || legacy_exists(provider_id, "ai-api-key"),
    )
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::sync::OnceLock;

    use super::{
        cached_master_key, clear_kind_with, load_or_create_master_key_with,
        prepare_secret_updates_with, resolve_secret,
    };

    #[test]
    fn master_key_access_failure_never_writes_a_replacement() {
        let writes = Cell::new(0);
        let result = load_or_create_master_key_with(
            || Err("Keychain access denied".into()),
            || Ok(true),
            |_| {
                writes.set(writes.get() + 1);
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(writes.get(), 0);
    }

    #[test]
    fn malformed_master_key_never_writes_a_replacement() {
        let writes = Cell::new(0);
        let result = load_or_create_master_key_with(
            || Ok(Some("not-a-valid-master-key".into())),
            || Ok(true),
            |_| {
                writes.set(writes.get() + 1);
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(writes.get(), 0);
    }

    #[test]
    fn missing_master_key_with_existing_ciphertext_requires_recovery() {
        let writes = Cell::new(0);
        let result = load_or_create_master_key_with(
            || Ok(None),
            || Ok(false),
            |_| {
                writes.set(writes.get() + 1);
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(writes.get(), 0);
    }

    #[test]
    fn first_secret_preparation_failure_aborts_the_batch() {
        let attempts = Cell::new(0);
        let result =
            prepare_secret_updates_with(&[("imap-pass", "one"), ("smtp-pass", "two")], |_| {
                attempts.set(attempts.get() + 1);
                Err("first secret failed".into())
            });
        assert!(result.is_err());
        assert_eq!(attempts.get(), 1);
    }

    #[test]
    fn second_secret_preparation_failure_aborts_the_batch() {
        let attempts = Cell::new(0);
        let result =
            prepare_secret_updates_with(&[("imap-pass", "one"), ("smtp-pass", "two")], |value| {
                attempts.set(attempts.get() + 1);
                if value == "two" {
                    Err("second secret failed".into())
                } else {
                    Ok("encrypted-one".into())
                }
            });
        assert!(result.is_err());
        assert_eq!(attempts.get(), 2);
    }

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

    #[test]
    fn credential_cleanup_failure_is_reported() {
        let result = clear_kind_with(
            || Err("database unavailable".into()),
            || Ok(()),
            || Ok(true),
            || Ok(false),
        );
        assert_eq!(result.unwrap_err(), "database unavailable");
    }

    #[test]
    fn credential_cleanup_requires_verified_absence() {
        let result = clear_kind_with(|| Ok(()), || Ok(()), || Ok(false), || Ok(true));
        assert!(result.is_err());
    }
}
