//! IMAP inbox fetch (rustls TLS) for plain IMAP/SMTP accounts. Pulls recent
//! messages and parses them into the store. Sending is handled by `smtp.rs`.

use imap::{ClientBuilder, ConnectionMode, TlsKind};
use mailparse::MailHeaderMap;

use super::{tokens, SyncError};
use crate::store::{Message, MessageMeta, Party, Security, Store, Thread};

/// Connect, select a folder, fetch the most recent messages, persist them.
/// Runs blocking IMAP I/O; call via [`fetch_folder_async`] from async code.
pub fn fetch_folder(store: &Store, account_id: &str, folder: &str, limit: u32, group: bool, force_full: bool) -> Result<usize, SyncError> {
    let acct = store
        .imap_account(account_id)
        .ok_or_else(|| SyncError::Transient(format!("no saved IMAP settings for {account_id} — re-add the account")))?;
    let password = tokens::secret(account_id, "imap-pass")
        .filter(|p| !p.is_empty())
        .ok_or_else(|| SyncError::Transient(format!("no saved password for {} — re-add the account", acct.email)))?;
    let mode = match acct.imap_security {
        Security::Ssl => ConnectionMode::Tls,
        Security::Starttls => ConnectionMode::StartTls,
        Security::None => ConnectionMode::Plaintext,
    };

    log::info!("imap: syncing {} [{folder}] via {}:{} ({:?})", acct.email, acct.imap_host, acct.imap_port, acct.imap_security);
    let client = ClientBuilder::new(acct.imap_host.clone(), acct.imap_port)
        .tls_kind(TlsKind::Rust)
        .mode(mode)
        .connect()
        .map_err(|e| {
            log::error!("imap connect to {}:{} failed: {e}", acct.imap_host, acct.imap_port);
            SyncError::Transient(format!("can't reach {}:{} — {e}", acct.imap_host, acct.imap_port))
        })?;
    let mut session = client
        .login(&acct.imap_username, &password)
        .map_err(|(e, _)| {
            log::error!("imap login for {} (user {}) failed: {e}", acct.email, acct.imap_username);
            SyncError::Transient(format!("login failed for {} — check the username/password — {e}", acct.imap_username))
        })?;

    let mailbox = session
        .select(folder)
        .map_err(|e| SyncError::Transient(format!("couldn't open {folder} for {} — {e}", acct.email)))?;

    // Incremental sync (like Gmail historyId / Graph delta): if the mailbox hasn't
    // been renumbered (UIDVALIDITY matches the stored cursor), fetch only the UIDs
    // that arrived at/after the last seen UIDNEXT. Otherwise seed with the most
    // recent `limit` messages and track UIDs incrementally from then on.
    let uid_validity = mailbox.uid_validity;
    let uid_next = mailbox.uid_next;
    let cursor = store.imap_folder_cursor(account_id, folder);
    // `force_full` (backfill / "load older") bypasses the incremental cursor so a
    // growing `limit` re-seeds the most-recent N and pulls in older messages.
    let incremental = !force_full && matches!((uid_validity, cursor), (Some(uv), Some((cv, _))) if uv == cv);

    let fetches = if incremental {
        let prev_uid_next = cursor.expect("incremental implies a stored cursor").1;
        // Nothing new since last sync — leave the cursor as-is and return.
        if matches!(uid_next, Some(next) if next <= prev_uid_next) {
            let _ = session.logout();
            return Ok(0);
        }
        session
            .uid_fetch(format!("{prev_uid_next}:*"), "(FLAGS BODY.PEEK[])")
            .map_err(|e| SyncError::Transient(e.to_string()))?
    } else {
        let total = mailbox.exists;
        if total == 0 {
            if let (Some(uv), Some(next)) = (uid_validity, uid_next) {
                let _ = store.set_imap_folder_cursor(account_id, folder, uv, next);
            }
            let _ = session.logout();
            return Ok(0);
        }
        if force_full {
            // Backfill ("load older"): fetch the `limit` messages immediately
            // OLDER than what we already hold. We always keep the most-recent
            // contiguous block, so `total - have` is the boundary below which is
            // unsynced; pull the next page down from there. No re-download of the
            // overlap, and no schema needed — just the local message count.
            let have = store.message_count_for_folder(account_id, folder) as u32;
            if have >= total {
                // Already cached the whole mailbox — nothing older to fetch.
                if let (Some(uv), Some(next)) = (uid_validity, uid_next) {
                    let _ = store.set_imap_folder_cursor(account_id, folder, uv, next);
                }
                let _ = session.logout();
                return Ok(0);
            }
            let hi = total.saturating_sub(have);
            let lo = hi.saturating_sub(limit).saturating_add(1).max(1);
            session
                .fetch(format!("{lo}:{hi}"), "(FLAGS BODY.PEEK[])")
                .map_err(|e| SyncError::Transient(e.to_string()))?
        } else {
            // Initial seed: the most-recent `limit` messages.
            let start = total.saturating_sub(limit).saturating_add(1).max(1);
            session
                .fetch(format!("{start}:{total}"), "(FLAGS BODY.PEEK[])")
                .map_err(|e| SyncError::Transient(e.to_string()))?
        }
    };

    let mut n = 0;
    let mut errors = 0;
    for f in fetches.iter() {
        let unread = !f.flags().iter().any(|fl| matches!(fl, imap::types::Flag::Seen));
        let flagged = f.flags().iter().any(|fl| matches!(fl, imap::types::Flag::Flagged));
        if let Some(raw) = f.body() {
            if let Some(thread) = parse_rfc822(account_id, raw, unread, group, folder) {
                // Count only messages that actually persisted, and surface failures
                // (a silently-swallowed upsert error was hiding emails before).
                match store.upsert_thread(&thread) {
                    Ok(()) => {
                        n += 1;
                        // Mirror the server's \Flagged keyword into the local flag set.
                        if flagged { let _ = store.set_thread_flag(&thread.id, true); }
                    }
                    Err(e) => {
                        errors += 1;
                        log::error!("imap: failed to store message: {e}");
                    }
                }
            }
        }
    }
    let _ = session.logout();

    // Advance the cursor to the mailbox's current UIDNEXT so the next sync is a delta.
    if let (Some(uv), Some(next)) = (uid_validity, uid_next) {
        let _ = store.set_imap_folder_cursor(account_id, folder, uv, next);
    }
    store.prune_empty_threads(); // drop any thread rows left empty by id-scheme moves
    log::info!("imap: stored {n} messages ({errors} failed) from {folder} ({})", if incremental { "delta" } else { "initial" });
    if n == 0 && errors > 0 {
        return Err(SyncError::Transient(format!("fetched mail but {errors} messages failed to save")));
    }
    Ok(n)
}

/// Block on IMAP IDLE for the account's INBOX until the mailbox changes (new
/// mail, expunge, flag change) or the keep-alive timeout elapses. Returns
/// `Ok(true)` when the server pushed a change worth re-syncing. Blocking I/O —
/// call from a blocking task.
pub fn idle_wait_inbox(store: &Store, account_id: &str) -> Result<bool, SyncError> {
    let acct = store
        .imap_account(account_id)
        .ok_or_else(|| SyncError::Transient(format!("no saved IMAP settings for {account_id}")))?;
    let password = tokens::secret(account_id, "imap-pass")
        .filter(|p| !p.is_empty())
        .ok_or_else(|| SyncError::Transient(format!("no saved password for {}", acct.email)))?;
    let mode = match acct.imap_security {
        Security::Ssl => ConnectionMode::Tls,
        Security::Starttls => ConnectionMode::StartTls,
        Security::None => ConnectionMode::Plaintext,
    };
    let client = ClientBuilder::new(acct.imap_host.clone(), acct.imap_port)
        .tls_kind(TlsKind::Rust)
        .mode(mode)
        .connect()
        .map_err(|e| SyncError::Transient(format!("can't reach {}:{} — {e}", acct.imap_host, acct.imap_port)))?;
    let mut session = client
        .login(&acct.imap_username, &password)
        .map_err(|(e, _)| SyncError::Transient(format!("login failed — {e}")))?;
    session
        .select("INBOX")
        .map_err(|e| SyncError::Transient(format!("couldn't open INBOX — {e}")))?;

    let mut idle = session.idle();
    idle.timeout(std::time::Duration::from_secs(300)); // re-IDLE well under the 29-min limit
    let outcome = idle
        .wait_while(imap::extensions::idle::stop_on_any)
        .map_err(|e| SyncError::Transient(format!("IDLE failed — {e}")))?;
    drop(idle); // ends IDLE (sends DONE) before we log out
    let _ = session.logout();
    Ok(matches!(outcome, imap::extensions::idle::WaitOutcome::MailboxChanged))
}

/// Enumerate the account's IMAP folders (mailboxes), persist them with their
/// special-use role (Sent/Drafts/Trash/…), and return them.
pub fn list_folders(store: &Store, account_id: &str) -> Result<Vec<String>, SyncError> {
    let acct = store
        .imap_account(account_id)
        .ok_or_else(|| SyncError::Transient(format!("no saved IMAP settings for {account_id}")))?;
    let password = tokens::secret(account_id, "imap-pass")
        .filter(|p| !p.is_empty())
        .ok_or_else(|| SyncError::Transient(format!("no saved password for {}", acct.email)))?;
    let mode = match acct.imap_security {
        Security::Ssl => ConnectionMode::Tls,
        Security::Starttls => ConnectionMode::StartTls,
        Security::None => ConnectionMode::Plaintext,
    };
    let client = ClientBuilder::new(acct.imap_host.clone(), acct.imap_port)
        .tls_kind(TlsKind::Rust)
        .mode(mode)
        .connect()
        .map_err(|e| SyncError::Transient(format!("can't reach {}:{} — {e}", acct.imap_host, acct.imap_port)))?;
    let mut session = client
        .login(&acct.imap_username, &password)
        .map_err(|(e, _)| SyncError::Transient(format!("login failed — {e}")))?;

    let names = session
        .list(Some(""), Some("*"))
        .map_err(|e| SyncError::Transient(format!("LIST failed — {e}")))?;
    let mut out = Vec::new();
    for nm in names.iter() {
        let name = nm.name().to_string();
        let role = folder_role(&name);
        let _ = store.upsert_folder(account_id, &name, role.as_deref());
        out.push(name);
    }
    let _ = session.logout();
    // Always make sure INBOX exists in the list.
    if !out.iter().any(|n| n.eq_ignore_ascii_case("INBOX")) {
        let _ = store.upsert_folder(account_id, "INBOX", Some("inbox"));
        out.insert(0, "INBOX".into());
    }
    log::info!("imap: {} folders for {}", out.len(), acct.email);
    Ok(out)
}

/// Infer a folder's special-use role from its name (covers the common
/// conventions: "Sent", "INBOX.Sent", "Sent Items", "Drafts", "Trash", etc.).
fn folder_role(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    let leaf = lower.rsplit(['/', '.']).next().unwrap_or(&lower);
    if leaf == "inbox" {
        return Some("inbox".into());
    }
    if leaf.contains("sent") {
        return Some("sent".into());
    }
    if leaf.contains("draft") {
        return Some("drafts".into());
    }
    if leaf.contains("trash") || leaf.contains("deleted") {
        return Some("trash".into());
    }
    if leaf.contains("junk") || leaf.contains("spam") {
        return Some("junk".into());
    }
    if leaf.contains("archive") {
        return Some("archive".into());
    }
    None
}

/// IMAP mailbox management — create / rename / delete a folder on the server,
/// then mirror the change locally.
pub enum FolderAction {
    Create(String),
    Rename(String, String),
    Delete(String),
}

pub fn manage_folder(store: &Store, account_id: &str, action: FolderAction) -> Result<(), SyncError> {
    let acct = store
        .imap_account(account_id)
        .ok_or_else(|| SyncError::Transient(format!("no saved IMAP settings for {account_id}")))?;
    let password = tokens::secret(account_id, "imap-pass")
        .filter(|p| !p.is_empty())
        .ok_or_else(|| SyncError::Transient(format!("no saved password for {}", acct.email)))?;
    let mode = match acct.imap_security {
        Security::Ssl => ConnectionMode::Tls,
        Security::Starttls => ConnectionMode::StartTls,
        Security::None => ConnectionMode::Plaintext,
    };
    let client = ClientBuilder::new(acct.imap_host.clone(), acct.imap_port)
        .tls_kind(TlsKind::Rust)
        .mode(mode)
        .connect()
        .map_err(|e| SyncError::Transient(format!("can't reach {}:{} — {e}", acct.imap_host, acct.imap_port)))?;
    let mut session = client
        .login(&acct.imap_username, &password)
        .map_err(|(e, _)| SyncError::Transient(format!("login failed — {e}")))?;

    let res = match &action {
        FolderAction::Create(name) => session.create(name),
        FolderAction::Rename(from, to) => session.rename(from, to),
        FolderAction::Delete(name) => session.delete(name),
    };
    let _ = session.logout();
    res.map_err(|e| SyncError::Transient(format!("folder operation failed — {e}")))?;

    // Mirror the change in the local store so the sidebar updates immediately.
    match action {
        FolderAction::Create(name) => {
            let _ = store.upsert_folder(account_id, &name, folder_role(&name).as_deref());
        }
        FolderAction::Rename(from, to) => {
            store.rename_folder_local(account_id, &from, &to);
            let _ = store.upsert_folder(account_id, &to, folder_role(&to).as_deref());
        }
        FolderAction::Delete(name) => store.delete_folder_local(account_id, &name),
    }
    Ok(())
}

pub async fn manage_folder_async(store: std::sync::Arc<Store>, account_id: String, action: FolderAction) -> Result<(), SyncError> {
    tokio::task::spawn_blocking(move || manage_folder(&store, &account_id, action))
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?
}

pub async fn list_folders_async(store: std::sync::Arc<Store>, account_id: String) -> Result<Vec<String>, SyncError> {
    tokio::task::spawn_blocking(move || list_folders(&store, &account_id))
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?
}

/// Relocate a thread's messages from their current IMAP mailbox to `to_folder`,
/// matching each message by its RFC Message-ID header and using the IMAP MOVE
/// (RFC 6851) command. The local move has already happened; this is best-effort
/// server reconciliation, so a server that lacks MOVE simply surfaces an error
/// (we never EXPUNGE blindly — that could delete unrelated \Deleted messages).
pub fn move_thread(store: &Store, account_id: &str, thread_id: &str, to_folder: &str) -> Result<(), SyncError> {
    let (source, msg_ids) = store
        .thread_move_refs(thread_id)
        .ok_or_else(|| SyncError::Transient("thread not found locally".into()))?;
    if msg_ids.is_empty() || source.eq_ignore_ascii_case(to_folder) {
        return Ok(());
    }
    let acct = store
        .imap_account(account_id)
        .ok_or_else(|| SyncError::Transient(format!("no saved IMAP settings for {account_id}")))?;
    let password = tokens::secret(account_id, "imap-pass")
        .filter(|p| !p.is_empty())
        .ok_or_else(|| SyncError::Transient(format!("no saved password for {}", acct.email)))?;
    let mode = match acct.imap_security {
        Security::Ssl => ConnectionMode::Tls,
        Security::Starttls => ConnectionMode::StartTls,
        Security::None => ConnectionMode::Plaintext,
    };
    let client = ClientBuilder::new(acct.imap_host.clone(), acct.imap_port)
        .tls_kind(TlsKind::Rust)
        .mode(mode)
        .connect()
        .map_err(|e| SyncError::Transient(format!("can't reach {}:{} — {e}", acct.imap_host, acct.imap_port)))?;
    let mut session = client
        .login(&acct.imap_username, &password)
        .map_err(|(e, _)| SyncError::Transient(format!("login failed — {e}")))?;
    session
        .select(&source)
        .map_err(|e| SyncError::Transient(format!("couldn't open {source} — {e}")))?;

    let mut moved = 0usize;
    for mid in &msg_ids {
        // Strip any stray quotes/angle brackets are kept — search by the raw id.
        let query = format!("HEADER MESSAGE-ID \"{}\"", mid.replace('"', ""));
        let uids = session.uid_search(&query).unwrap_or_default();
        if uids.is_empty() {
            continue;
        }
        let set = uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
        session
            .uid_mv(&set, to_folder)
            .map_err(|e| SyncError::Transient(format!("server move to {to_folder} failed — {e}")))?;
        moved += uids.len();
    }
    let _ = session.logout();
    log::info!("imap: moved {moved} message(s) {source} -> {to_folder} for {}", acct.email);
    Ok(())
}

pub async fn move_thread_async(store: std::sync::Arc<Store>, account_id: String, thread_id: String, to_folder: String) -> Result<(), SyncError> {
    tokio::task::spawn_blocking(move || move_thread(&store, &account_id, &thread_id, &to_folder))
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?
}

/// Set or clear the IMAP `\Flagged` keyword on every message in a thread, then
/// mirror the result into the local flag set. Mirrors `move_thread`'s shape:
/// resolve the thread's source folder + Message-IDs, SEARCH each to its UID(s),
/// and UID STORE the flag. Best-effort — the local flag is updated regardless so
/// the star works offline; a server failure surfaces as a transient error.
pub fn flag_thread(store: &Store, account_id: &str, thread_id: &str, flagged: bool) -> Result<(), SyncError> {
    // Local mirror first so the UI is correct even if the server is unreachable.
    let _ = store.set_thread_flag(thread_id, flagged);

    let (source, msg_ids) = match store.thread_move_refs(thread_id) {
        Some(v) => v,
        None => return Ok(()),
    };
    if msg_ids.is_empty() {
        return Ok(());
    }
    let acct = store
        .imap_account(account_id)
        .ok_or_else(|| SyncError::Transient(format!("no saved IMAP settings for {account_id}")))?;
    let password = tokens::secret(account_id, "imap-pass")
        .filter(|p| !p.is_empty())
        .ok_or_else(|| SyncError::Transient(format!("no saved password for {}", acct.email)))?;
    let mode = match acct.imap_security {
        Security::Ssl => ConnectionMode::Tls,
        Security::Starttls => ConnectionMode::StartTls,
        Security::None => ConnectionMode::Plaintext,
    };
    let client = ClientBuilder::new(acct.imap_host.clone(), acct.imap_port)
        .tls_kind(TlsKind::Rust)
        .mode(mode)
        .connect()
        .map_err(|e| SyncError::Transient(format!("can't reach {}:{} — {e}", acct.imap_host, acct.imap_port)))?;
    let mut session = client
        .login(&acct.imap_username, &password)
        .map_err(|(e, _)| SyncError::Transient(format!("login failed — {e}")))?;
    session
        .select(&source)
        .map_err(|e| SyncError::Transient(format!("couldn't open {source} — {e}")))?;

    let query = if flagged { "+FLAGS (\\Flagged)" } else { "-FLAGS (\\Flagged)" };
    for mid in &msg_ids {
        let search = format!("HEADER MESSAGE-ID \"{}\"", mid.replace('"', ""));
        let uids = session.uid_search(&search).unwrap_or_default();
        if uids.is_empty() {
            continue;
        }
        let set = uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
        session
            .uid_store(&set, query)
            .map_err(|e| SyncError::Transient(format!("server flag update failed — {e}")))?;
    }
    let _ = session.logout();
    log::info!("imap: {} thread {thread_id} for {}", if flagged { "flagged" } else { "unflagged" }, acct.email);
    Ok(())
}

pub async fn flag_thread_async(store: std::sync::Arc<Store>, account_id: String, thread_id: String, flagged: bool) -> Result<(), SyncError> {
    tokio::task::spawn_blocking(move || flag_thread(&store, &account_id, &thread_id, flagged))
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?
}

/// Fetch a single attachment's decoded bytes by Message-ID + filename. IMAP has
/// no stored UID yet, so we SEARCH the INBOX by the Message-ID header, re-fetch
/// the full message, and extract the named part.
pub fn fetch_attachment(store: &Store, account_id: &str, message_id: &str, filename: &str) -> Result<Vec<u8>, SyncError> {
    let acct = store.imap_account(account_id).ok_or(SyncError::AuthRequired)?;
    let password = tokens::secret(account_id, "imap-pass").ok_or(SyncError::AuthRequired)?;
    let mode = match acct.imap_security {
        Security::Ssl => ConnectionMode::Tls,
        Security::Starttls => ConnectionMode::StartTls,
        Security::None => ConnectionMode::Plaintext,
    };
    let client = ClientBuilder::new(acct.imap_host.clone(), acct.imap_port)
        .tls_kind(TlsKind::Rust)
        .mode(mode)
        .connect()
        .map_err(|e| SyncError::Transient(e.to_string()))?;
    let mut session = client
        .login(&acct.imap_username, &password)
        .map_err(|(e, _)| SyncError::Transient(e.to_string()))?;
    session.select("INBOX").map_err(|e| SyncError::Transient(e.to_string()))?;

    // Stored message ids are account-scoped ("account\u{1}<real-message-id>"); the
    // server only knows the real Message-ID, so strip the prefix before searching.
    let real_id = message_id.rsplit('\u{1}').next().unwrap_or(message_id);
    let query = format!("HEADER Message-ID \"{real_id}\"");
    let seqs = session.search(query).map_err(|e| SyncError::Transient(e.to_string()))?;
    let seq = seqs.into_iter().next().ok_or_else(|| SyncError::Transient("message not found on server".into()))?;

    let raw = {
        let fetches = session.fetch(seq.to_string(), "BODY.PEEK[]").map_err(|e| SyncError::Transient(e.to_string()))?;
        fetches
            .iter()
            .next()
            .and_then(|f| f.body())
            .ok_or_else(|| SyncError::Transient("empty message body".into()))?
            .to_vec()
    };
    let _ = session.logout();

    let mail = mailparse::parse_mail(&raw).map_err(|e| SyncError::Transient(e.to_string()))?;
    extract_attachment_bytes(&mail, filename).ok_or_else(|| SyncError::Transient(format!("attachment '{filename}' not found")))
}

/// Find a named attachment in the MIME tree and return its transfer-decoded bytes.
/// Uses the SAME detection + naming as `imap_attachments` so a chip the user sees
/// always resolves back to a downloadable part — including inline photos.
fn extract_attachment_bytes(mail: &mailparse::ParsedMail, filename: &str) -> Option<Vec<u8>> {
    if is_real_attachment(mail) && attachment_name(mail) == filename {
        return mail.get_body_raw().ok();
    }
    for p in &mail.subparts {
        if let Some(b) = extract_attachment_bytes(p, filename) {
            return Some(b);
        }
    }
    None
}

pub async fn fetch_attachment_async(store: std::sync::Arc<Store>, account_id: String, message_id: String, filename: String) -> Result<Vec<u8>, SyncError> {
    tokio::task::spawn_blocking(move || fetch_attachment(&store, &account_id, &message_id, &filename))
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?
}

/// Test IMAP credentials without saving: connect, login, logout.
pub fn test_login(host: &str, port: u16, security: Security, user: &str, pass: &str) -> Result<(), SyncError> {
    let mode = match security {
        Security::Ssl => ConnectionMode::Tls,
        Security::Starttls => ConnectionMode::StartTls,
        Security::None => ConnectionMode::Plaintext,
    };
    log::info!("IMAP test: connecting to {host}:{port} (security={security:?})");
    let client = ClientBuilder::new(host.to_string(), port)
        .tls_kind(TlsKind::Rust)
        .mode(mode)
        .connect()
        .map_err(|e| {
            log::error!("IMAP connect to {host}:{port} failed: {e}");
            SyncError::Transient(format!("IMAP connect failed: {e}"))
        })?;
    log::info!("IMAP test: connected, logging in as {user}");
    let mut session = client.login(user, pass).map_err(|(e, _)| {
        log::error!("IMAP login for {user} failed: {e}");
        SyncError::Transient(format!("IMAP login failed: {e}"))
    })?;
    log::info!("IMAP test: login OK for {user}");
    let _ = session.logout();
    Ok(())
}

pub async fn fetch_folder_async(store: std::sync::Arc<Store>, account_id: String, folder: String, limit: u32, group: bool, force_full: bool) -> Result<usize, SyncError> {
    tokio::task::spawn_blocking(move || fetch_folder(&store, &account_id, &folder, limit, group, force_full))
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?
}

/// Parse a raw RFC822 message into a store Thread (one message per thread,
/// keyed by Message-ID). Pure + unit-tested.
fn parse_rfc822(account_id: &str, raw: &[u8], unread: bool, group: bool, folder: &str) -> Option<Thread> {
    let mail = mailparse::parse_mail(raw).ok()?;
    let h = |name: &str| mail.headers.get_first_value(name);

    let subject = h("Subject").filter(|s| !s.is_empty()).unwrap_or_else(|| "(no subject)".into());
    let from_raw = h("From").unwrap_or_default();
    let (from_name, from_addr) = split_addr(&from_raw);
    let when = h("Date").unwrap_or_default();
    let msg_id = h("Message-ID").filter(|s| !s.is_empty()).unwrap_or_else(|| format!("imapmsg-{}", subject.len()));

    // When grouping is on, the conversation root is the first id in References,
    // else In-Reply-To, else this message itself. The thread id is scoped to the
    // folder so the same conversation in Inbox and in Sent stays separate (folder
    // browsing) rather than collapsing into one row.
    let base = if group {
        h("References")
            .and_then(|r| r.split_whitespace().next().map(str::to_string))
            .or_else(|| h("In-Reply-To").and_then(|r| r.split_whitespace().next().map(str::to_string)))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| msg_id.clone())
    } else {
        msg_id.clone()
    };
    // Scope the thread to (account, folder, conversation root) so the same email
    // in two accounts/folders stays separate and re-syncs don't duplicate.
    let thread_id = format!("{account_id}\u{1}{folder}\u{1}{base}");

    // Provenance: recipients, originating IP (from the earliest Received hop),
    // and SPF/DKIM/DMARC results — surfaced in the message Details panel.
    let to = parse_addrs(&h("To").unwrap_or_default());
    let auth = parse_auth(&mail.headers.get_all_values("Authentication-Results").join(" "));
    let meta = MessageMeta {
        cc: parse_addrs(&h("Cc").unwrap_or_default()),
        reply_to: h("Reply-To").filter(|s| !s.is_empty()),
        message_id: Some(msg_id.clone()),
        origin_ip: origin_ip(&mail.headers.get_all_values("Received")),
        auth: if auth.is_empty() { None } else { Some(auth) },
    };

    // Inline images embedded in the message (Content-ID parts referenced as
    // `cid:...` in the HTML) become data: URIs so they actually render.
    let body_html = inline_cid_images(&mail, extract_html(&mail).unwrap_or_default());
    // Preview: prefer the message's own text/plain alternative (already clean,
    // like Thunderbird/Apple Mail do); only parse the HTML when there's no plain
    // part. Gmail/Graph instead use the provider's server-side snippet.
    let preview = {
        // Keep line structure (text/plain raw, or line-preserving HTML→text), trim
        // the quoted reply history, then take the snippet of the NEW content.
        let raw = find_body(&mail, "text/plain")
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| crate::store::html_to_text(&body_html));
        crate::store::strip_quoted(&raw).chars().take(140).collect::<String>()
    };

    Some(Thread {
        id: thread_id,
        account_id: account_id.to_string(),
        subject,
        preview,
        participants: vec![if from_name.is_empty() { from_addr.clone() } else { from_name.clone() }],
        last_time: when.clone(),
        unread,
        labels: vec![],
        view: vec!["inbox".into()],
        folder: folder.to_string(),
        ai_summary: None,
        ai_draft: None,
        messages: vec![Message {
            id: format!("{account_id}\u{1}{msg_id}"),
            from: Party { name: from_name, address: from_addr },
            to,
            when,
            body_html,
            attachments: imap_attachments(&mail),
            meta: Some(meta),
        }],
    })
}

/// Parse a comma-separated address header into parties.
fn parse_addrs(raw: &str) -> Vec<Party> {
    raw.split(',')
        .filter_map(|a| {
            let a = a.trim();
            if a.is_empty() {
                return None;
            }
            let (name, address) = split_addr(a);
            Some(Party { name, address })
        })
        .collect()
}

/// The originating client IP: scan Received hops from earliest (last) to latest
/// for a bracketed/parenthesised IP literal.
fn origin_ip(received: &[String]) -> Option<String> {
    received.iter().rev().find_map(|r| find_ip(r))
}

fn find_ip(s: &str) -> Option<String> {
    for (open, close) in [('[', ']'), ('(', ')')] {
        let mut start: Option<usize> = None;
        for (i, c) in s.char_indices() {
            if c == open {
                start = Some(i + 1);
            } else if c == close {
                if let Some(st) = start {
                    let cand = s[st..i].trim();
                    if looks_like_ip(cand) {
                        return Some(cand.to_string());
                    }
                    start = None;
                }
            }
        }
    }
    None
}

fn looks_like_ip(s: &str) -> bool {
    let s = s.trim_start_matches("IPv6:");
    if s.split('.').count() == 4 && s.split('.').all(|o| o.parse::<u8>().is_ok()) {
        return true;
    }
    s.contains(':') && s.len() >= 3 && s.chars().all(|c| c.is_ascii_hexdigit() || c == ':')
}

/// Extract a compact SPF/DKIM/DMARC summary from Authentication-Results.
fn parse_auth(s: &str) -> String {
    let lower = s.to_lowercase();
    let mut parts = Vec::new();
    for key in ["spf", "dkim", "dmarc"] {
        if let Some(pos) = lower.find(&format!("{key}=")) {
            let rest = &lower[pos + key.len() + 1..];
            let val: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
            if !val.is_empty() {
                parts.push(format!("{key}={val}"));
            }
        }
    }
    parts.join("; ")
}

/// Replace `cid:` references to embedded images with self-contained data: URIs,
/// so inline images render without any network access.
fn inline_cid_images(mail: &mailparse::ParsedMail, html: String) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    fn collect(part: &mailparse::ParsedMail, out: &mut Vec<(String, String, Vec<u8>)>) {
        if part.ctype.mimetype.starts_with("image/") {
            if let Some(cid) = part.headers.get_first_value("Content-ID") {
                let id = cid.trim().trim_start_matches('<').trim_end_matches('>').to_string();
                if !id.is_empty() {
                    if let Ok(bytes) = part.get_body_raw() {
                        out.push((id, part.ctype.mimetype.clone(), bytes));
                    }
                }
            }
        }
        for p in &part.subparts {
            collect(p, out);
        }
    }
    let mut images = Vec::new();
    collect(mail, &mut images);
    if images.is_empty() {
        return html;
    }
    let mut out = html;
    for (cid, mime, bytes) in images {
        let data = format!("data:{};base64,{}", mime, STANDARD.encode(&bytes));
        out = out.replace(&format!("cid:{cid}"), &data);
    }
    out
}

/// Get the displayable body. Prefers the `text/html` alternative anywhere in the
/// MIME tree (so inline images and formatting render), and only falls back to
/// `text/plain` when there is no HTML part. This avoids picking the plain-text
/// alternative — whose `[cid:...]` image placeholders would otherwise be shown
/// as literal text (and mangled into giant data: URIs by image inlining).
fn extract_html(mail: &mailparse::ParsedMail) -> Option<String> {
    if let Some(html) = find_body(mail, "text/html") {
        return Some(html);
    }
    find_body(mail, "text/plain").map(|t| format!("<p>{}</p>", t.replace('\n', "<br>")))
}

/// First non-empty body of the given MIME type, searched depth-first.
fn find_body(mail: &mailparse::ParsedMail, mime: &str) -> Option<String> {
    if mail.ctype.mimetype == mime {
        if let Ok(body) = mail.get_body() {
            if !body.trim().is_empty() {
                return Some(body);
            }
        }
    }
    for part in &mail.subparts {
        if let Some(b) = find_body(part, mime) {
            return Some(b);
        }
    }
    None
}

/// The user-facing filename for a part: the Content-Disposition `filename`, else
/// the legacy Content-Type `name=` param (older mailers / inline photos put it
/// there). Empty/absent → None.
fn part_filename(part: &mailparse::ParsedMail) -> Option<String> {
    let cd = part.get_content_disposition();
    if let Some(f) = cd.params.get("filename").filter(|s| !s.is_empty()) {
        return Some(f.clone());
    }
    part.ctype.params.get("name").filter(|s| !s.is_empty()).cloned()
}

/// A displayable name for an attachment chip — the real filename when present,
/// otherwise a stable mime-derived fallback (so unnamed inline photos still get a
/// sensible name AND resolve back on download).
fn attachment_name(part: &mailparse::ParsedMail) -> String {
    if let Some(f) = part_filename(part) {
        return f;
    }
    let mime = part.ctype.mimetype.to_lowercase();
    let ext = match mime.as_str() {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/heic" => "heic",
        "image/webp" => "webp",
        "application/pdf" => "pdf",
        other => other.rsplit('/').next().unwrap_or("bin"),
    };
    format!("attachment.{ext}")
}

/// Whether a MIME part is a real, user-facing attachment (Apple-Mail semantics):
/// explicit `Content-Disposition: attachment`, OR any named file, OR a sizeable
/// inline binary (e.g. an iOS photo / scanned doc embedded with a Content-ID).
/// Deliberately EXCLUDES the text body, MIME containers, crypto signatures, and
/// tiny unnamed images (tracking pixels / spacers / signature decorations).
fn is_real_attachment(part: &mailparse::ParsedMail) -> bool {
    if !part.subparts.is_empty() {
        return false; // multipart container, not a leaf file
    }
    let mime = part.ctype.mimetype.to_lowercase();
    if matches!(
        mime.as_str(),
        "application/pkcs7-signature" | "application/x-pkcs7-signature" | "application/pgp-signature"
    ) {
        return false; // S/MIME or PGP signature — not a user attachment
    }
    if matches!(part.get_content_disposition().disposition, mailparse::DispositionType::Attachment) {
        return true;
    }
    if part_filename(part).is_some() {
        return true; // named inline file (iOS photo, forwarded doc, …)
    }
    // Unnamed inline part: only count sizeable binaries so tracking pixels and
    // tiny signature images don't pollute the attachment list.
    let big = part.get_body_raw().map(|b| b.len()).unwrap_or(0) >= 8_000;
    big && (mime.starts_with("image/")
        || mime.starts_with("application/")
        || mime.starts_with("audio/")
        || mime.starts_with("video/"))
}

/// Collect attachment metadata from the MIME tree — every real file part, inline
/// or not (so inline photos/scans appear as downloadable chips, like Apple Mail).
fn imap_attachments(mail: &mailparse::ParsedMail) -> Vec<crate::store::AttachmentMeta> {
    let mut out = Vec::new();
    fn walk(part: &mailparse::ParsedMail, out: &mut Vec<crate::store::AttachmentMeta>) {
        if is_real_attachment(part) {
            out.push(crate::store::AttachmentMeta {
                name: attachment_name(part),
                mime: part.ctype.mimetype.clone(),
                size: part.get_body_raw().map(|b| b.len() as u64).unwrap_or(0),
            });
        }
        for p in &part.subparts {
            walk(p, out);
        }
    }
    walk(mail, &mut out);
    out
}

fn split_addr(raw: &str) -> (String, String) {
    if let Some(open) = raw.find('<') {
        let name = raw[..open].trim().trim_matches('"').to_string();
        let addr = raw[open + 1..].trim_end_matches('>').trim().to_string();
        (name, addr)
    } else {
        (String::new(), raw.trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_and_html() {
        let raw = b"Subject: Hello\r\nFrom: Sam <sam@x.io>\r\nDate: Fri, 29 May 2026 10:00:00 +0000\r\nMessage-ID: <abc@x.io>\r\nContent-Type: text/html\r\n\r\n<p>Hi there</p>";
        let t = parse_rfc822("imap:me", raw, true, true, "INBOX").unwrap();
        assert_eq!(t.subject, "Hello");
        assert!(t.id.ends_with("<abc@x.io>"));
        assert_eq!(t.folder, "INBOX");
        assert_eq!(t.messages[0].from.address, "sam@x.io");
        assert!(t.unread);
        assert!(t.messages[0].body_html.contains("Hi there"));
    }

    #[test]
    fn extracts_attachment_metadata() {
        let raw = b"Subject: Doc\r\nFrom: A <a@b.c>\r\nContent-Type: multipart/mixed; boundary=\"bnd\"\r\n\r\n--bnd\r\nContent-Type: text/html\r\n\r\n<p>see attached</p>\r\n--bnd\r\nContent-Type: application/pdf; name=\"report.pdf\"\r\nContent-Disposition: attachment; filename=\"report.pdf\"\r\n\r\nPDFDATA\r\n--bnd--";
        let t = parse_rfc822("imap:me", raw, false, true, "INBOX").unwrap();
        assert_eq!(t.messages[0].attachments.len(), 1);
        assert_eq!(t.messages[0].attachments[0].name, "report.pdf");
        assert_eq!(t.messages[0].attachments[0].mime, "application/pdf");
    }

    #[test]
    fn same_message_in_two_folders_is_separate() {
        let raw = b"Subject: Hi\r\nFrom: A <a@b.c>\r\nMessage-ID: <m1@x>\r\nContent-Type: text/html\r\n\r\n<p>hi</p>";
        let inbox = parse_rfc822("imap:me", raw, false, true, "INBOX").unwrap();
        let sent = parse_rfc822("imap:me", raw, false, true, "Sent").unwrap();
        assert_ne!(inbox.id, sent.id, "same message in different folders must be distinct threads");
        assert_eq!(inbox.folder, "INBOX");
        assert_eq!(sent.folder, "Sent");
    }

    #[test]
    fn captures_provenance() {
        let raw = b"Subject: Hi\r\nFrom: A <a@b.c>\r\nTo: Me <me@x.de>\r\nCc: C <c@y.de>\r\nReceived: from mail.x.de (mail.x.de [203.0.113.7]) by mx.x.de\r\nAuthentication-Results: mx.x.de; spf=pass; dkim=pass; dmarc=pass\r\nMessage-ID: <m1@x.de>\r\nContent-Type: text/html\r\n\r\n<p>hi</p>";
        let t = parse_rfc822("imap:me", raw, false, true, "INBOX").unwrap();
        let m = &t.messages[0];
        assert_eq!(m.to[0].address, "me@x.de");
        let meta = m.meta.as_ref().unwrap();
        assert_eq!(meta.cc[0].address, "c@y.de");
        assert_eq!(meta.origin_ip.as_deref(), Some("203.0.113.7"));
        assert_eq!(meta.auth.as_deref(), Some("spf=pass; dkim=pass; dmarc=pass"));
    }

    #[test]
    fn prefers_html_over_plaintext_alternative() {
        // multipart/alternative: plain text with a [cid:..] placeholder + HTML with
        // a real <img>. The HTML must win so the placeholder isn't shown as text.
        let raw = b"Subject: Sig\r\nFrom: A <a@b.c>\r\nContent-Type: multipart/alternative; boundary=\"alt\"\r\n\r\n--alt\r\nContent-Type: text/plain\r\n\r\nHello [cid:logo@x]\r\n--alt\r\nContent-Type: text/html\r\n\r\n<p>Hello <img src=\"cid:logo@x\"></p>\r\n--alt--";
        let t = parse_rfc822("imap:me", raw, false, true, "INBOX").unwrap();
        let html = &t.messages[0].body_html;
        assert!(html.contains("<img"), "should use the HTML part: {html}");
        assert!(!html.contains("[cid:logo@x]"), "must not show the plain-text cid placeholder");
    }

    #[test]
    fn inlines_cid_images() {
        // multipart/related: an HTML part referencing cid:img1 + the image part.
        let raw = b"Subject: Pic\r\nFrom: A <a@b.c>\r\nContent-Type: multipart/related; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/html\r\n\r\n<p><img src=\"cid:img1\"></p>\r\n--b\r\nContent-Type: image/png\r\nContent-ID: <img1>\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8=\r\n--b--";
        let t = parse_rfc822("imap:me", raw, false, true, "INBOX").unwrap();
        let html = &t.messages[0].body_html;
        assert!(html.contains("data:image/png;base64,SGVsbG8="), "cid should be inlined: {html}");
        assert!(!html.contains("cid:img1"), "raw cid ref should be gone");
    }

    #[test]
    fn extracts_attachment_bytes_base64() {
        // "Hello" base64 = SGVsbG8=
        let raw = b"Subject: D\r\nFrom: A <a@b.c>\r\nContent-Type: multipart/mixed; boundary=\"bnd\"\r\n\r\n--bnd\r\nContent-Type: text/html\r\n\r\n<p>x</p>\r\n--bnd\r\nContent-Type: application/octet-stream; name=\"f.bin\"\r\nContent-Disposition: attachment; filename=\"f.bin\"\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8=\r\n--bnd--";
        let mail = mailparse::parse_mail(raw).unwrap();
        let bytes = extract_attachment_bytes(&mail, "f.bin").unwrap();
        assert_eq!(bytes, b"Hello");
        assert!(extract_attachment_bytes(&mail, "missing.bin").is_none());
    }
}
