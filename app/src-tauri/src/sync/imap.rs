//! IMAP inbox fetch (rustls TLS) for plain IMAP/SMTP accounts. Pulls recent
//! messages and parses them into the store. Sending is handled by `smtp.rs`.

use imap::{ClientBuilder, ConnectionMode, TlsKind};
use mailparse::MailHeaderMap;

use super::{SyncError, tokens};
use crate::store::{Message, MessageMeta, Party, Security, Store, Thread};

fn finish_imap_persistence<F>(errors: usize, persist_cursor: F) -> Result<(), SyncError>
where
    F: FnOnce() -> rusqlite::Result<()>,
{
    if errors > 0 {
        return Err(SyncError::Transient(format!(
            "fetched mail but {errors} local updates failed to save"
        )));
    }
    super::store_write(persist_cursor(), "persist IMAP sync cursor")
}

/// Connect, select a folder, fetch the most recent messages, persist them.
/// Runs blocking IMAP I/O; call via [`fetch_folder_async`] from async code.
pub fn fetch_folder(
    store: &Store,
    account_id: &str,
    folder: &str,
    limit: u32,
    group: bool,
    force_full: bool,
) -> Result<usize, SyncError> {
    let acct = store.imap_account(account_id).ok_or_else(|| {
        SyncError::Transient(format!(
            "no saved IMAP settings for {account_id} — re-add the account"
        ))
    })?;
    let password =
        tokens::secret(account_id, "imap-pass").filter(|p| !p.is_empty()).ok_or_else(|| {
            SyncError::Transient(format!(
                "no saved password for {} — re-add the account",
                acct.email
            ))
        })?;
    let mode = match acct.imap_security {
        Security::Ssl => ConnectionMode::Tls,
        Security::Starttls => ConnectionMode::StartTls,
        Security::None => ConnectionMode::Plaintext,
    };

    log::info!(
        "imap: syncing {} [{folder}] via {}:{} ({:?})",
        acct.email,
        acct.imap_host,
        acct.imap_port,
        acct.imap_security
    );
    let client = ClientBuilder::new(acct.imap_host.clone(), acct.imap_port)
        .tls_kind(TlsKind::Rust)
        .mode(mode)
        .connect()
        .map_err(|e| {
            log::error!("imap connect to {}:{} failed: {e}", acct.imap_host, acct.imap_port);
            SyncError::Transient(format!("can't reach {}:{} — {e}", acct.imap_host, acct.imap_port))
        })?;
    let mut session = client.login(&acct.imap_username, &password).map_err(|(e, _)| {
        log::error!("imap login for {} (user {}) failed: {e}", acct.email, acct.imap_username);
        SyncError::Transient(format!(
            "login failed for {} — check the username/password — {e}",
            acct.imap_username
        ))
    })?;

    let mailbox = session.select(folder).map_err(|e| {
        SyncError::Transient(format!("couldn't open {folder} for {} — {e}", acct.email))
    })?;

    // Incremental sync (like Gmail historyId / Graph delta): if the mailbox hasn't
    // been renumbered (UIDVALIDITY matches the stored cursor), fetch only the UIDs
    // that arrived at/after the last seen UIDNEXT. Otherwise seed with the most
    // recent `limit` messages and track UIDs incrementally from then on.
    let uid_validity = mailbox.uid_validity;
    let uid_next = mailbox.uid_next;
    let cursor = store.imap_folder_cursor(account_id, folder);
    // `force_full` (backfill / "load older") bypasses the incremental cursor so a
    // growing `limit` re-seeds the most-recent N and pulls in older messages.
    let incremental =
        !force_full && matches!((uid_validity, cursor), (Some(uv), Some((cv, _))) if uv == cv);

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
            finish_imap_persistence(0, || match (uid_validity, uid_next) {
                (Some(uv), Some(next)) => {
                    store.set_imap_folder_cursor(account_id, folder, uv, next)
                }
                _ => Ok(()),
            })?;
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
                finish_imap_persistence(0, || match (uid_validity, uid_next) {
                    (Some(uv), Some(next)) => {
                        store.set_imap_folder_cursor(account_id, folder, uv, next)
                    }
                    _ => Ok(()),
                })?;
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
        match f.body() {
            Some(raw) => match parse_rfc822(account_id, raw, unread, group, folder) {
                Ok(thread) => {
                    // Count only messages that actually persisted, and surface failures
                    // (a silently-swallowed upsert error was hiding emails before).
                    match store.upsert_thread(&thread) {
                        Ok(()) => {
                            n += 1;
                            // Mirror the server's \Flagged keyword into the local flag set.
                            if flagged && store.set_thread_flag(&thread.id, true).is_err() {
                                errors += 1;
                            }
                        }
                        Err(e) => {
                            errors += 1;
                            log::error!("imap: failed to store message: {e}");
                        }
                    }
                }
                Err(error) => {
                    errors += 1;
                    log::error!("imap: failed to parse fetched message: {error}");
                }
            },
            None => {
                errors += 1;
                log::error!("imap: fetched message did not contain an RFC822 body");
            }
        }
    }
    let _ = session.logout();

    // Never advance past a message that failed local persistence. Otherwise the
    // next delta would skip it permanently while health incorrectly reports success.
    finish_imap_persistence(errors, || match (uid_validity, uid_next) {
        (Some(uv), Some(next)) => store.set_imap_folder_cursor(account_id, folder, uv, next),
        _ => Ok(()),
    })?;
    store.prune_empty_threads(); // drop any thread rows left empty by id-scheme moves
    log::info!(
        "imap: stored {n} messages ({errors} failed) from {folder} ({})",
        if incremental { "delta" } else { "initial" }
    );
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
        .map_err(|e| {
            SyncError::Transient(format!("can't reach {}:{} — {e}", acct.imap_host, acct.imap_port))
        })?;
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
        .map_err(|e| {
            SyncError::Transient(format!("can't reach {}:{} — {e}", acct.imap_host, acct.imap_port))
        })?;
    let mut session = client
        .login(&acct.imap_username, &password)
        .map_err(|(e, _)| SyncError::Transient(format!("login failed — {e}")))?;

    let names = session
        .list(Some(""), Some("*"))
        .map_err(|e| SyncError::Transient(format!("LIST failed — {e}")))?;
    let mut out = Vec::new();
    for nm in names.iter() {
        let name = nm.name().to_string();
        // A \\Noselect mailbox is a pure hierarchy node (e.g. "INBOX" on some
        // servers, or a namespace prefix): it can never hold mail, so never
        // treat it as Sent/Drafts/… or offer it as an APPEND target.
        let noselect =
            nm.attributes().iter().any(|a| matches!(a, imap_proto::NameAttribute::NoSelect));
        // Prefer what the SERVER says (RFC 6154 SPECIAL-USE \\Sent etc.); only
        // guess from the name when the server sent no attribute.
        let from_server = if noselect { None } else { special_use_role(nm.attributes()) };
        let role = from_server.clone().or_else(|| folder_role(&name));
        let _ = store.upsert_folder(account_id, &name, role.as_deref(), from_server.is_some());
        out.push(name);
    }
    let _ = session.logout();
    // Always make sure INBOX exists in the list.
    if !out.iter().any(|n| n.eq_ignore_ascii_case("INBOX")) {
        let _ = store.upsert_folder(account_id, "INBOX", Some("inbox"), false);
        out.insert(0, "INBOX".into());
    }
    log::info!("imap: {} folders for {}", out.len(), acct.email);
    Ok(out)
}

/// Map the server-declared RFC 6154 SPECIAL-USE attribute to our role. This is
/// authoritative and language-independent — Dovecot, Gmail, Exchange, iCloud
/// all flag their real Sent folder with `\\Sent`, whatever it is called.
fn special_use_role(attrs: &[imap_proto::NameAttribute<'_>]) -> Option<String> {
    use imap_proto::NameAttribute as A;
    attrs
        .iter()
        .find_map(|a| match a {
            A::Sent => Some("sent"),
            A::Drafts => Some("drafts"),
            A::Trash => Some("trash"),
            A::Junk => Some("junk"),
            A::Archive | A::All => Some("archive"),
            _ => None,
        })
        .map(str::to_string)
}

/// Infer a folder's special-use role from its name (covers the common
/// conventions: "Sent", "INBOX.Sent", "Sent Items", "Drafts", "Trash", etc.).
fn folder_role(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    let leaf = lower.rsplit(['/', '.']).next().unwrap_or(&lower);
    if leaf == "inbox" {
        return Some("inbox".into());
    }
    // Name fallback (only when the server sent no SPECIAL-USE attribute). Covers
    // the localisations European providers actually use: DE gesendet(e)
    // (Elemente|Objekte), FR envoy(é|e)s, IT (posta )inviata, ES enviados,
    // NL verzonden, PT enviados — not just English "sent".
    if leaf.contains("sent")
        || leaf.contains("gesendet")
        || leaf.contains("envoy")
        || leaf.contains("inviat")
        || leaf.contains("enviad")
        || leaf.contains("verzonden")
    {
        return Some("sent".into());
    }
    if leaf.contains("draft")
        || leaf.contains("entw")
        || leaf.contains("brouillon")
        || leaf.contains("bozz")
        || leaf.contains("borrador")
        || leaf.contains("concept")
    {
        return Some("drafts".into());
    }
    if leaf.contains("trash")
        || leaf.contains("deleted")
        || leaf.contains("papierkorb")
        || leaf.contains("gelöscht")
        || leaf.contains("corbeille")
        || leaf.contains("cestino")
        || leaf.contains("papelera")
        || leaf.contains("prullenbak")
    {
        return Some("trash".into());
    }
    if leaf.contains("junk")
        || leaf.contains("spam")
        || leaf.contains("unerwünscht")
        || leaf.contains("indésirable")
        || leaf.contains("indesiderat")
    {
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

pub fn manage_folder(
    store: &Store,
    account_id: &str,
    action: FolderAction,
) -> Result<(), SyncError> {
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
        .map_err(|e| {
            SyncError::Transient(format!("can't reach {}:{} — {e}", acct.imap_host, acct.imap_port))
        })?;
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
            let _ = store.upsert_folder(account_id, &name, folder_role(&name).as_deref(), false);
        }
        FolderAction::Rename(from, to) => {
            store.rename_folder_local(account_id, &from, &to);
            let _ = store.upsert_folder(account_id, &to, folder_role(&to).as_deref(), false);
        }
        FolderAction::Delete(name) => store.delete_folder_local(account_id, &name),
    }
    Ok(())
}

pub async fn manage_folder_async(
    store: std::sync::Arc<Store>,
    account_id: String,
    action: FolderAction,
) -> Result<(), SyncError> {
    tokio::task::spawn_blocking(move || manage_folder(&store, &account_id, action))
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?
}

pub async fn list_folders_async(
    store: std::sync::Arc<Store>,
    account_id: String,
) -> Result<Vec<String>, SyncError> {
    tokio::task::spawn_blocking(move || list_folders(&store, &account_id))
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?
}

/// Relocate a thread's messages from their current IMAP mailbox to `to_folder`,
/// matching each message by its RFC Message-ID header and using the IMAP MOVE
/// (RFC 6851) command. The local move has already happened; this is best-effort
/// server reconciliation, so a server that lacks MOVE simply surfaces an error
/// (we never EXPUNGE blindly — that could delete unrelated \Deleted messages).
pub fn move_thread(
    store: &Store,
    account_id: &str,
    thread_id: &str,
    to_folder: &str,
) -> Result<(), SyncError> {
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
        .map_err(|e| {
            SyncError::Transient(format!("can't reach {}:{} — {e}", acct.imap_host, acct.imap_port))
        })?;
    let mut session = client
        .login(&acct.imap_username, &password)
        .map_err(|(e, _)| SyncError::Transient(format!("login failed — {e}")))?;
    session
        .select(&source)
        .map_err(|e| SyncError::Transient(format!("couldn't open {source} — {e}")))?;

    let mut moved = 0usize;
    for mid in &msg_ids {
        let Some(query) = message_id_search(mid) else { continue };
        let uids = session.uid_search(&query).unwrap_or_default();
        if uids.is_empty() {
            continue;
        }
        let set = uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
        session.uid_mv(&set, to_folder).map_err(|e| {
            SyncError::Transient(format!("server move to {to_folder} failed — {e}"))
        })?;
        moved += uids.len();
    }
    let _ = session.logout();
    log::info!("imap: moved {moved} message(s) {source} -> {to_folder} for {}", acct.email);
    Ok(())
}

pub async fn move_thread_async(
    store: std::sync::Arc<Store>,
    account_id: String,
    thread_id: String,
    to_folder: String,
) -> Result<(), SyncError> {
    tokio::task::spawn_blocking(move || move_thread(&store, &account_id, &thread_id, &to_folder))
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?
}

/// Set or clear the IMAP `\Flagged` keyword on every message in a thread, then
/// mirror the result into the local flag set. Mirrors `move_thread`'s shape:
/// resolve the thread's source folder + Message-IDs, SEARCH each to its UID(s),
/// and UID STORE the flag. Best-effort — the local flag is updated regardless so
/// the star works offline; a server failure surfaces as a transient error.
pub fn flag_thread(
    store: &Store,
    account_id: &str,
    thread_id: &str,
    flagged: bool,
) -> Result<(), SyncError> {
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
        .map_err(|e| {
            SyncError::Transient(format!("can't reach {}:{} — {e}", acct.imap_host, acct.imap_port))
        })?;
    let mut session = client
        .login(&acct.imap_username, &password)
        .map_err(|(e, _)| SyncError::Transient(format!("login failed — {e}")))?;
    session
        .select(&source)
        .map_err(|e| SyncError::Transient(format!("couldn't open {source} — {e}")))?;

    let query = if flagged { "+FLAGS (\\Flagged)" } else { "-FLAGS (\\Flagged)" };
    for mid in &msg_ids {
        let Some(search) = message_id_search(mid) else { continue };
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
    log::info!(
        "imap: {} thread {thread_id} for {}",
        if flagged { "flagged" } else { "unflagged" },
        acct.email
    );
    Ok(())
}

pub async fn flag_thread_async(
    store: std::sync::Arc<Store>,
    account_id: String,
    thread_id: String,
    flagged: bool,
) -> Result<(), SyncError> {
    tokio::task::spawn_blocking(move || flag_thread(&store, &account_id, &thread_id, flagged))
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?
}

/// Mark a thread read/unread on the IMAP server via the `\Seen` flag. Mirrors
/// `flag_thread`: resolve the thread's source folder + Message-IDs, SEARCH each
/// to its UID(s), then UID STORE the flag. Best-effort — the caller has already
/// persisted the local read state, and a server failure surfaces as a transient
/// error without failing the action.
pub fn set_read(
    store: &Store,
    account_id: &str,
    thread_id: &str,
    unread: bool,
) -> Result<(), SyncError> {
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
        .map_err(|e| {
            SyncError::Transient(format!("can't reach {}:{} — {e}", acct.imap_host, acct.imap_port))
        })?;
    let mut session = client
        .login(&acct.imap_username, &password)
        .map_err(|(e, _)| SyncError::Transient(format!("login failed — {e}")))?;
    session
        .select(&source)
        .map_err(|e| SyncError::Transient(format!("couldn't open {source} — {e}")))?;

    let query = seen_flag_query(unread);
    for mid in &msg_ids {
        let Some(search) = message_id_search(mid) else { continue };
        let uids = session.uid_search(&search).unwrap_or_default();
        if uids.is_empty() {
            continue;
        }
        let set = uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
        session
            .uid_store(&set, query)
            .map_err(|e| SyncError::Transient(format!("server read update failed — {e}")))?;
    }
    let _ = session.logout();
    log::info!(
        "imap: {} thread {thread_id} for {}",
        if unread { "marked unread" } else { "marked read" },
        acct.email,
    );
    Ok(())
}

pub async fn set_read_async(
    store: std::sync::Arc<Store>,
    account_id: String,
    thread_id: String,
    unread: bool,
) -> Result<(), SyncError> {
    tokio::task::spawn_blocking(move || set_read(&store, &account_id, &thread_id, unread))
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?
}

/// IMAP flag mutation for a read/unread action. Marking a thread read adds the
/// `\Seen` flag on the server; marking it unread removes it. Extracted so the
/// direction mapping is unit-testable without a live IMAP connection.
fn seen_flag_query(unread: bool) -> &'static str {
    if unread { r"-FLAGS (\Seen)" } else { r"+FLAGS (\Seen)" }
}

/// IMAP `SEARCH` key matching a Message-ID header. The id comes from mail anyone
/// can send, so it must not be able to leave the quoted string and inject further
/// IMAP commands: ids with control characters (CR/LF, NUL, …) or non-ASCII bytes
/// are refused with `None`, and `\` and `"` are escaped per RFC 3501 quoted-string.
fn message_id_search(message_id: &str) -> Option<String> {
    let id = message_id.trim();
    if id.is_empty() || id.len() > 998 || !id.bytes().all(|b| (0x20..0x7f).contains(&b)) {
        return None;
    }
    Some(format!("HEADER MESSAGE-ID \"{}\"", id.replace('\\', r"\\").replace('"', r#"\""#)))
}

/// Fetch a single attachment's decoded bytes by Message-ID + filename. IMAP has
/// no stored UID yet, so we SEARCH the INBOX by the Message-ID header, re-fetch
/// the full message, and extract the named part.
pub fn fetch_attachment(
    store: &Store,
    account_id: &str,
    message_id: &str,
    filename: &str,
) -> Result<Vec<u8>, SyncError> {
    // Inline attachments (data: URIs embedded in the body — iOS photos, scans)
    // are served straight from the stored HTML: no network, works offline, and
    // works for ANY folder (the IMAP path below only searches INBOX).
    if filename.starts_with("inline-") {
        if let Some(html) = store.message_body_html(message_id) {
            if let Some((_, _, bytes)) = crate::store::inline_data_attachments(&html)
                .into_iter()
                .find(|(name, _, _)| name == filename)
            {
                return Ok(bytes);
            }
        }
    }
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
    // SELECT the message's actual mailbox (Sent/Archive/custom), not a hardcoded
    // INBOX — otherwise the Message-ID search runs in the wrong folder and the
    // attachment "isn't found" even though it's right there.
    let folder = store.message_folder(message_id).unwrap_or_else(|| "INBOX".to_string());
    session.select(&folder).map_err(|e| SyncError::Transient(e.to_string()))?;

    // Stored message ids are account-scoped ("account\u{1}<real-message-id>"); the
    // server only knows the real Message-ID, so strip the prefix before searching.
    let real_id = message_id.rsplit('\u{1}').next().unwrap_or(message_id);
    let query = message_id_search(real_id)
        .ok_or_else(|| SyncError::Transient("message id can't be searched on the server".into()))?;
    let seqs = session.search(query).map_err(|e| SyncError::Transient(e.to_string()))?;
    let seq = seqs
        .into_iter()
        .next()
        .ok_or_else(|| SyncError::Transient("message not found on server".into()))?;

    let raw = {
        let fetches = session
            .fetch(seq.to_string(), "BODY.PEEK[]")
            .map_err(|e| SyncError::Transient(e.to_string()))?;
        fetches
            .iter()
            .next()
            .and_then(|f| f.body())
            .ok_or_else(|| SyncError::Transient("empty message body".into()))?
            .to_vec()
    };
    let _ = session.logout();

    let mail = mailparse::parse_mail(&raw).map_err(|e| SyncError::Transient(e.to_string()))?;
    extract_attachment_bytes(&mail, filename)
        .ok_or_else(|| SyncError::Transient(format!("attachment '{filename}' not found")))
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

pub async fn fetch_attachment_async(
    store: std::sync::Arc<Store>,
    account_id: String,
    message_id: String,
    filename: String,
) -> Result<Vec<u8>, SyncError> {
    tokio::task::spawn_blocking(move || {
        fetch_attachment(&store, &account_id, &message_id, &filename)
    })
    .await
    .map_err(|e| SyncError::Transient(e.to_string()))?
}

/// Test IMAP credentials without saving: connect, login, logout.
pub fn test_login(
    host: &str,
    port: u16,
    security: Security,
    user: &str,
    pass: &str,
) -> Result<(), SyncError> {
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

pub async fn fetch_folder_async(
    store: std::sync::Arc<Store>,
    account_id: String,
    folder: String,
    limit: u32,
    group: bool,
    force_full: bool,
) -> Result<usize, SyncError> {
    tokio::task::spawn_blocking(move || {
        fetch_folder(&store, &account_id, &folder, limit, group, force_full)
    })
    .await
    .map_err(|e| SyncError::Transient(e.to_string()))?
}

/// Parse a raw RFC822 message into a store Thread (one message per thread,
/// keyed by Message-ID). Pure + unit-tested.
pub(crate) fn parse_rfc822(
    account_id: &str,
    raw: &[u8],
    unread: bool,
    group: bool,
    folder: &str,
) -> Result<Thread, SyncError> {
    // mailparse and the walkers below recurse once per MIME level with no limit.
    // A message nested thousands of levels deep would overflow the stack, which
    // aborts the whole app — again on every sync. Such a message keeps its
    // headers and gets a notice for a body.
    let flattened;
    let raw = if is_abnormally_nested(raw) {
        log::warn!("message with abnormally nested MIME structure was not parsed");
        flattened = flatten_to_notice(raw);
        flattened.as_slice()
    } else {
        raw
    };
    let mail = mailparse::parse_mail(raw)
        .map_err(|error| SyncError::Transient(format!("invalid RFC822 message: {error}")))?;
    let h = |name: &str| mail.headers.get_first_value(name);

    let subject = h("Subject")
        .map(|s| strip_direction_overrides(&s))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "(no subject)".into());
    let from_raw = h("From").unwrap_or_default();
    let (from_name, from_addr) = split_addr(&from_raw);
    let from_name = strip_direction_overrides(&from_name);
    let when = h("Date").unwrap_or_default();
    let msg_id = h("Message-ID").filter(|s| !s.is_empty()).unwrap_or_else(|| {
        // No Message-ID: derive a stable id from the content. (The subject
        // length used before collided between unrelated messages.)
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(raw);
        let hex: String = digest.iter().take(12).map(|b| format!("{b:02x}")).collect();
        format!("imapmsg-{hex}")
    });

    // When grouping is on, the conversation root is the first id in References,
    // else In-Reply-To, else this message itself. The thread id is scoped to the
    // folder so the same conversation in Inbox and in Sent stays separate (folder
    // browsing) rather than collapsing into one row.
    let base = if group {
        h("References")
            .and_then(|r| r.split_whitespace().next().map(str::to_string))
            .or_else(|| {
                h("In-Reply-To").and_then(|r| r.split_whitespace().next().map(str::to_string))
            })
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
    // Only the topmost Authentication-Results header: each server prepends its
    // own, so the first one is the receiving server's. Any further down may have
    // been written by the sender ("spf=pass; dkim=pass; dmarc=pass").
    let auth =
        parse_auth(&mail.headers.get_first_value("Authentication-Results").unwrap_or_default());
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

    Ok(Thread {
        id: thread_id,
        account_id: account_id.to_string(),
        subject,
        preview,
        participants: vec![if from_name.is_empty() {
            from_addr.clone()
        } else {
            from_name.clone()
        }],
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
    use base64::{Engine, engine::general_purpose::STANDARD};
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
    let mut budget = INLINE_IMAGE_BUDGET;
    for (cid, mime, bytes) in images {
        let needle = format!("cid:{cid}");
        let uses = out.matches(&needle).count();
        if uses == 0 {
            continue;
        }
        let data = format!("data:{};base64,{}", mime, STANDARD.encode(&bytes));
        // One small image referenced hundreds of thousands of times would expand
        // to gigabytes. Past the budget the reference simply stays unresolved.
        let cost = uses.saturating_mul(data.len());
        if cost > budget {
            log::warn!("inline image referenced {uses} times was not embedded (size budget)");
            continue;
        }
        budget -= cost;
        out = out.replace(&needle, &data);
    }
    out
}

/// Total bytes of embedded inline-image data one message body may grow by.
const INLINE_IMAGE_BUDGET: usize = 32 * 1024 * 1024;
/// Real mail nests a handful of multipart levels; this is far above any of it.
const MAX_MIME_BOUNDARIES: usize = 100;

fn is_abnormally_nested(raw: &[u8]) -> bool {
    raw.windows(9)
        .filter(|window| window.eq_ignore_ascii_case(b"boundary="))
        .take(MAX_MIME_BOUNDARIES + 1)
        .count()
        > MAX_MIME_BOUNDARIES
}

/// The message's own headers with a plain-text notice for a body. The MIME
/// headers are dropped so nothing is parsed as multipart.
fn flatten_to_notice(raw: &[u8]) -> Vec<u8> {
    let header_end = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|at| at + 2)
        .or_else(|| raw.windows(2).position(|window| window == b"\n\n").map(|at| at + 1))
        .unwrap_or(raw.len());
    let mut out = Vec::new();
    let mut dropping = false;
    for line in raw[..header_end].split_inclusive(|byte| *byte == b'\n') {
        let continuation = line.first().is_some_and(|byte| *byte == b' ' || *byte == b'\t');
        if !continuation {
            let lower = line.to_ascii_lowercase();
            dropping = lower.starts_with(b"content-type:")
                || lower.starts_with(b"content-transfer-encoding:")
                || lower.starts_with(b"content-disposition:");
        }
        if !dropping {
            out.extend_from_slice(line);
        }
    }
    if !out.ends_with(b"\n") {
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(
        b"Content-Type: text/plain; charset=utf-8\r\n\r\nThis message was not displayed: its structure is abnormally nested, which is a known way to crash mail programs.\r\n",
    );
    out
}

/// Remove the characters that reorder text on screen (and the invisible marks
/// used with them) from header text, so a name cannot read differently from
/// what it is.
fn strip_direction_overrides(text: &str) -> String {
    text.chars()
        .filter(|c| !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{200e}' | '\u{200f}'))
        .collect()
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
        "application/pkcs7-signature"
            | "application/x-pkcs7-signature"
            | "application/pgp-signature"
    ) {
        return false; // S/MIME or PGP signature — not a user attachment
    }
    if matches!(part.get_content_disposition().disposition, mailparse::DispositionType::Attachment)
    {
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
    use std::cell::Cell;

    #[test]
    fn seen_flag_query_maps_read_and_unread() {
        assert_eq!(seen_flag_query(false), r"+FLAGS (\Seen)");
        assert_eq!(seen_flag_query(true), r"-FLAGS (\Seen)");
    }

    #[test]
    fn message_id_search_quotes_and_refuses_injection() {
        assert_eq!(
            message_id_search(" <abc.123@mail.example> ").as_deref(),
            Some(r#"HEADER MESSAGE-ID "<abc.123@mail.example>""#)
        );
        assert_eq!(
            message_id_search(r#"<a"b\c@x>"#).as_deref(),
            Some(r#"HEADER MESSAGE-ID "<a\"b\\c@x>""#)
        );
        for hostile in [
            "<x@y>\"\r\nA1 DELETE INBOX\r\n",
            "<x@y>\nA1 LOGOUT",
            "<x\0@y>",
            "<x\u{7f}@y>",
            "<ä@y>",
            "",
            "   ",
        ] {
            assert_eq!(message_id_search(hostile), None, "{hostile:?}");
        }
        assert_eq!(message_id_search(&format!("<{}@y>", "a".repeat(1000))), None);
    }

    #[test]
    fn partial_local_failure_blocks_cursor_advance() {
        let cursor_called = Cell::new(false);
        let result = finish_imap_persistence(1, || {
            cursor_called.set(true);
            Ok(())
        });
        assert!(matches!(result, Err(SyncError::Transient(_))));
        assert!(!cursor_called.get());
    }

    #[test]
    fn cursor_write_failure_fails_the_sync() {
        let result = finish_imap_persistence(0, || Err(rusqlite::Error::InvalidQuery));
        assert!(
            matches!(result, Err(SyncError::Transient(message)) if message.contains("IMAP sync cursor"))
        );
    }

    #[test]
    fn malformed_message_is_a_sync_failure_not_a_silent_skip() {
        let raw = b" Subject: invalid-leading-space\r\n\r\nbody";
        assert!(parse_rfc822("imap:me", raw, false, true, "INBOX").is_err());
    }

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

    #[test]
    fn abnormally_nested_message_becomes_a_notice_instead_of_being_parsed() {
        let mut raw = b"Subject: Deep\r\nFrom: A <a@b.c>\r\nMessage-ID: <deep@x>\r\nContent-Type: multipart/mixed;\r\n boundary=\"b0\"\r\n\r\n".to_vec();
        for level in 0..5_000 {
            raw.extend_from_slice(
                format!(
                    "--b{level}\r\nContent-Type: multipart/mixed; boundary=\"b{}\"\r\n\r\n",
                    level + 1
                )
                .as_bytes(),
            );
        }
        assert!(is_abnormally_nested(&raw));
        let t = parse_rfc822("imap:me", &raw, false, true, "INBOX").unwrap();
        assert_eq!(t.subject, "Deep");
        assert_eq!(t.messages[0].from.address, "a@b.c");
        assert!(t.messages[0].body_html.contains("abnormally nested"));
        assert!(t.messages[0].attachments.is_empty());

        let normal =
            b"Subject: Hi\r\nContent-Type: multipart/alternative; boundary=\"alt\"\r\n\r\n--alt--";
        assert!(!is_abnormally_nested(normal));
    }

    #[test]
    fn inline_image_referenced_too_often_is_not_embedded() {
        let image = "A".repeat(40_000);
        let refs = "<img src=\"cid:logo@x\">".repeat(2_000);
        let raw = format!(
            "Subject: Bomb\r\nFrom: A <a@b.c>\r\nContent-Type: multipart/related; boundary=\"rel\"\r\n\r\n--rel\r\nContent-Type: text/html\r\n\r\n<p>{refs}</p>\r\n--rel\r\nContent-Type: image/png\r\nContent-ID: <logo@x>\r\nContent-Transfer-Encoding: base64\r\n\r\n{image}\r\n--rel--"
        );
        let t = parse_rfc822("imap:me", raw.as_bytes(), false, true, "INBOX").unwrap();
        let html = &t.messages[0].body_html;
        assert!(html.len() < 1_000_000, "body grew to {} bytes", html.len());
        assert!(html.contains("cid:logo@x"));

        let once = raw.replace(&refs, "<img src=\"cid:logo@x\">");
        let t = parse_rfc822("imap:me", once.as_bytes(), false, true, "INBOX").unwrap();
        assert!(t.messages[0].body_html.contains("data:image/png;base64,"));
    }

    #[test]
    fn only_the_receiving_servers_authentication_results_are_trusted() {
        let raw = b"Authentication-Results: mx.x.de; spf=fail; dkim=none; dmarc=fail\r\nAuthentication-Results: evil.example; spf=pass; dkim=pass; dmarc=pass\r\nSubject: Hi\r\nFrom: A <a@b.c>\r\nMessage-ID: <m2@x.de>\r\n\r\nhi";
        let t = parse_rfc822("imap:me", raw, false, true, "INBOX").unwrap();
        let meta = t.messages[0].meta.as_ref().unwrap();
        assert_eq!(meta.auth.as_deref(), Some("spf=fail; dkim=none; dmarc=fail"));
    }

    #[test]
    fn direction_overrides_are_removed_from_subject_and_sender_name() {
        let raw = "Subject: invoice\u{202e}fdp.exe\r\nFrom: \"Pay\u{202e}laP\u{2066}\" <a@b.c>\r\nMessage-ID: <m3@x.de>\r\n\r\nhi";
        let t = parse_rfc822("imap:me", raw.as_bytes(), false, true, "INBOX").unwrap();
        assert_eq!(t.subject, "invoicefdp.exe");
        assert_eq!(t.messages[0].from.name, "PaylaP");
    }

    #[test]
    fn messages_without_an_id_get_distinct_stable_ids() {
        let one = b"Subject: Same\r\nFrom: A <a@b.c>\r\n\r\nfirst";
        let two = b"Subject: Same\r\nFrom: A <a@b.c>\r\n\r\nsecond";
        let id = |raw: &[u8]| {
            parse_rfc822("imap:me", raw, false, true, "INBOX").unwrap().messages[0].id.clone()
        };
        assert_ne!(id(one), id(two));
        assert_eq!(id(one), id(one));
    }

    #[test]
    fn a_reused_message_id_from_another_sender_does_not_replace_the_stored_body() {
        let path = std::env::temp_dir().join(format!(
            "bharga-reused-id-{}-{}.db",
            std::process::id(),
            rand::random::<u64>()
        ));
        let store = crate::store::Store::open(path.clone()).unwrap();
        store.upsert_account("imap:me", "me@x.de", "imap", "Me").unwrap();
        let mail = |from: &str, body: &str| {
            let raw = format!(
                "Subject: Invoice\r\nFrom: {from}\r\nMessage-ID: <same@bank.example>\r\nContent-Type: text/html\r\n\r\n<p>{body}</p>"
            );
            parse_rfc822("imap:me", raw.as_bytes(), false, false, "INBOX").unwrap()
        };
        let original = mail("Bank <billing@bank.example>", "original");
        store.upsert_thread(&original).unwrap();
        store.upsert_thread(&mail("Bank <billing@evil.example>", "pay the attacker")).unwrap();
        let stored = store.thread(&original.id).unwrap();
        assert_eq!(stored.messages.len(), 1);
        assert_eq!(stored.messages[0].from.address, "billing@bank.example");
        assert!(stored.messages[0].body_html.contains("original"));

        store.upsert_thread(&mail("Bank <Billing@Bank.example>", "refreshed")).unwrap();
        assert!(store.thread(&original.id).unwrap().messages[0].body_html.contains("refreshed"));
        drop(store);
        std::fs::remove_file(&path).unwrap();
    }
}
