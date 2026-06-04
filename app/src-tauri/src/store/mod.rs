//! Local-first store, backed by SQLite (bundled). The UI's source of truth;
//! the sync engine reconciles it with remote providers in the background.
//!
//! Threads/messages are persisted and full-text indexed (FTS5). Embeddings for
//! semantic search are a Phase 1 add (sqlite-vec). The DB is opened once and
//! lives in app data; encrypt at rest + keys in the OS keychain for production.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

pub mod seed;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Party {
    pub name: String,
    pub address: String,
}

/// Metadata for an attachment on a received message (bytes fetched on demand).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentMeta {
    pub name: String,
    pub mime: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub from: Party,
    pub to: Vec<Party>,
    pub when: String,
    #[serde(rename = "bodyHtml")]
    pub body_html: String,
    #[serde(default)]
    pub attachments: Vec<AttachmentMeta>,
    /// Extended header detail for the "show original / details" panel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<MessageMeta>,
}

/// Provenance/header detail shown in the message Details panel — so the reader
/// can see exactly where a message came from (recipients, originating IP, and
/// SPF/DKIM/DMARC authentication results).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MessageMeta {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cc: Vec<Party>,
    #[serde(rename = "replyTo", default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    #[serde(rename = "messageId", default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(rename = "originIp", default, skip_serializing_if = "Option::is_none")]
    pub origin_ip: Option<String>,
    /// Compact SPF/DKIM/DMARC summary, e.g. "spf=pass; dkim=pass; dmarc=pass".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Thread {
    pub id: String,
    #[serde(rename = "accountId")]
    pub account_id: String,
    pub subject: String,
    pub preview: String,
    pub participants: Vec<String>,
    #[serde(rename = "lastTime")]
    pub last_time: String,
    pub unread: bool,
    pub labels: Vec<String>,
    pub view: Vec<String>,
    /// The mailbox/folder this thread lives in (IMAP folder name; "INBOX" default).
    #[serde(default = "inbox_folder")]
    pub folder: String,
    #[serde(rename = "aiSummary", skip_serializing_if = "Option::is_none")]
    pub ai_summary: Option<String>,
    #[serde(rename = "aiDraft", skip_serializing_if = "Option::is_none")]
    pub ai_draft: Option<String>,
    pub messages: Vec<Message>,
}

fn inbox_folder() -> String {
    "INBOX".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalEvent {
    pub id: String,
    pub title: String,
    pub day: u8,
    pub time: String,
}

/// Transport security for a mail server connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Security {
    /// Implicit TLS (IMAPS 993 / SMTPS 465).
    Ssl,
    /// Upgrade a plaintext connection (IMAP 143 / submission 587).
    Starttls,
    /// No encryption (discouraged).
    None,
}

impl Default for Security {
    fn default() -> Self {
        Security::Ssl
    }
}

impl Security {
    pub fn as_str(self) -> &'static str {
        match self {
            Security::Ssl => "ssl",
            Security::Starttls => "starttls",
            Security::None => "none",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "starttls" => Security::Starttls,
            "none" => Security::None,
            _ => Security::Ssl,
        }
    }
}

/// IMAP/SMTP account configuration (passwords stored separately in the keychain).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImapAccount {
    #[serde(rename = "accountId")]
    pub account_id: String,
    pub email: String,
    #[serde(rename = "displayName", default)]
    pub display_name: String,
    #[serde(rename = "imapHost")]
    pub imap_host: String,
    #[serde(rename = "imapPort")]
    pub imap_port: u16,
    #[serde(rename = "imapSecurity", default)]
    pub imap_security: Security,
    #[serde(rename = "imapUsername")]
    pub imap_username: String,
    #[serde(rename = "smtpHost")]
    pub smtp_host: String,
    #[serde(rename = "smtpPort")]
    pub smtp_port: u16,
    #[serde(rename = "smtpSecurity", default)]
    pub smtp_security: Security,
    #[serde(rename = "smtpUsername")]
    pub smtp_username: String,
}

/// A connected mail account, surfaced to the UI's account switcher.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountInfo {
    pub id: String,
    pub email: String,
    pub provider: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub unread: u32,
}

/// A mailbox/folder for the sidebar folder list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderInfo {
    pub name: String,
    /// Special-use role if known: inbox|sent|drafts|trash|archive|junk.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    pub unread: u32,
    pub total: u32,
}

/// A file attachment, base64-encoded for transport.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    pub name: String,
    pub mime: String,
    #[serde(rename = "dataB64")]
    pub data_b64: String,
}

/// A queued outgoing message. Lives in the DB so it survives restarts/offline
/// and powers Undo Send (a delayed flush).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutboxItem {
    pub id: String,
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "threadId", skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub to: String,
    #[serde(default)]
    pub cc: String,
    #[serde(default)]
    pub bcc: String,
    pub subject: String,
    pub body: String,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    /// epoch seconds; the item is not sent until now >= scheduled_ts.
    #[serde(rename = "scheduledTs")]
    pub scheduled_ts: i64,
    pub status: String, // queued | sending | sent | failed
}

/// SQLite-backed store. Wrap the connection in a Mutex so it's `Send + Sync`
/// for Tauri managed state.
pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    /// Open (or create) the DB at the given path and run migrations.
    pub fn open(path: PathBuf) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        let store = Store { conn: Mutex::new(conn) };
        store.migrate()?;
        store.seed_if_empty();
        Ok(store)
    }

    /// In-memory store for tests.
    #[cfg(test)]
    pub fn in_memory() -> rusqlite::Result<Self> {
        let conn = Connection::open_in_memory()?;
        let store = Store { conn: Mutex::new(conn) };
        store.migrate()?;
        Ok(store)
    }

    /// Ordered, transactional schema migrations keyed by `PRAGMA user_version`.
    ///
    /// This is the single source of truth for the schema. Each step runs in its
    /// own transaction and only when the DB's version is older than the step's.
    /// Adding a schema change = appending a step here; the runner guarantees it is
    /// applied exactly once, which prevents the "missing column" drift that ad-hoc
    /// `CREATE TABLE IF NOT EXISTS` allowed.
    fn migrate(&self) -> rusqlite::Result<()> {
        let mut guard = self.conn.lock().unwrap();
        let conn: &mut Connection = &mut *guard;
        // Pragmas must run outside a transaction. WAL = concurrent readers + one
        // writer; foreign_keys enforces referential integrity (fresh installs).
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

        type Step = (i64, fn(&rusqlite::Transaction) -> rusqlite::Result<()>);
        let steps: &[Step] = &[
            (1, migrate_v1_baseline),
            (2, migrate_v2_integrity),
            (3, migrate_v3_user_state),
            (4, migrate_v4_message_meta),
            (5, migrate_v5_secrets),
            (6, migrate_v6_thread_folder),
            (7, migrate_v7_settings),
            (8, migrate_v8_reset_cache),
            (9, migrate_v9_outbox_cc_bcc),
            (10, migrate_v10_rebuild_previews),
            (11, migrate_v11_thread_flags),
        ];
        let mut version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        for (v, step) in steps {
            if *v > version {
                let tx = conn.transaction()?;
                step(&tx)?;
                tx.pragma_update(None, "user_version", *v)?;
                tx.commit()?;
                version = *v;
            }
        }
        Ok(())
    }

    fn seed_if_empty(&self) {
        // Demo data only when explicitly requested (BHARGA_DEMO=1). A real build
        // starts empty and prompts the user to connect an account.
        if std::env::var("BHARGA_DEMO").is_err() {
            return;
        }
        let empty = {
            let conn = self.conn.lock().unwrap();
            conn.query_row("SELECT COUNT(*) FROM threads", [], |r| r.get::<_, i64>(0))
                .unwrap_or(0)
                == 0
        };
        if empty {
            seed::seed(self);
        }
    }

    // ---- writes (used by the sync engine) ----

    pub fn upsert_thread(&self, t: &Thread) -> rusqlite::Result<()> {
        let mut guard = self.conn.lock().unwrap();
        let conn: &mut Connection = &mut *guard;
        let now = chrono::Utc::now().timestamp();
        // Canonical ordering key: newest parsed message time, falling back to the
        // thread's display time. Fixes the previous bug where sort_ts was never
        // written and the inbox sorted by insertion order instead of date.
        let sort_ts = t
            .messages
            .iter()
            .filter_map(|m| parse_epoch(&m.when))
            .max()
            .or_else(|| parse_epoch(&t.last_time))
            .unwrap_or(0);
        // One transaction: thread + messages + FTS row commit together or not at all.
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO threads (id, account_id, subject, preview, participants, last_time, unread, labels, views, ai_summary, ai_draft, sort_ts, created_at, updated_at, folder)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13,?14)
             ON CONFLICT(id) DO UPDATE SET
                subject=excluded.subject, preview=excluded.preview, participants=excluded.participants,
                last_time=excluded.last_time, labels=excluded.labels,
                sort_ts=excluded.sort_ts, updated_at=excluded.updated_at, folder=excluded.folder",
            params![
                t.id, t.account_id, t.subject, t.preview,
                json(&t.participants), t.last_time, t.unread as i64,
                json(&t.labels), json(&t.view), t.ai_summary, t.ai_draft,
                sort_ts, now, t.folder,
            ],
        )?;
        for m in &t.messages {
            tx.execute(
                "INSERT INTO messages (id, thread_id, from_name, from_addr, to_json, ts, body_html, attachments, meta, created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
                 ON CONFLICT(id) DO UPDATE SET thread_id=excluded.thread_id, body_html=excluded.body_html, attachments=excluded.attachments, meta=excluded.meta",
                params![m.id, t.id, m.from.name, m.from.address, json(&m.to), m.when, m.body_html, json(&m.attachments), json(&m.meta), now],
            )?;
        }
        // Replace (not append) the FTS row so re-syncing a thread can't duplicate it.
        let body = t.messages.iter().map(|m| strip_html(&m.body_html)).collect::<Vec<_>>().join(" ");
        tx.execute("DELETE FROM search WHERE thread_id=?1", params![t.id])?;
        tx.execute(
            "INSERT INTO search (thread_id, subject, body) VALUES (?1,?2,?3)",
            params![t.id, t.subject, body],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Remove thread rows that have no messages — artifacts left behind when the
    /// id scheme changed and a message was moved to a new thread. Keeps the list
    /// free of empty/duplicate rows.
    pub fn prune_empty_threads(&self) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "DELETE FROM threads WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = threads.id)",
            [],
        );
    }

    /// User "delete": soft-delete tombstone so the thread vanishes from views and
    /// the next sync won't resurrect it (until real two-way trash lands). The row
    /// is kept so we remember it was deleted.
    pub fn tombstone_thread(&self, thread_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp();
        conn.execute("UPDATE threads SET deleted=1, views='[]', updated_at=?2 WHERE id=?1", params![thread_id, now])?;
        let _ = conn.execute("DELETE FROM search WHERE thread_id=?1", params![thread_id]);
        Ok(())
    }

    /// Delete a thread and everything that hangs off it (messages, embedding, FTS
    /// row). Atomic; the AFTER DELETE trigger also covers FTS/embeddings.
    pub fn delete_thread(&self, thread_id: &str) -> rusqlite::Result<()> {
        let mut guard = self.conn.lock().unwrap();
        let conn: &mut Connection = &mut *guard;
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM messages WHERE thread_id=?1", params![thread_id])?;
        tx.execute("DELETE FROM embeddings WHERE thread_id=?1", params![thread_id])?;
        tx.execute("DELETE FROM search WHERE thread_id=?1", params![thread_id])?;
        tx.execute("DELETE FROM threads WHERE id=?1", params![thread_id])?;
        tx.commit()?;
        Ok(())
    }

    /// Remove an account and all of its data. Explicit cleanup (rather than relying
    /// only on FK cascade) so it is correct even on DBs created before FK enforcement.
    pub fn delete_account(&self, account_id: &str) -> rusqlite::Result<()> {
        let mut guard = self.conn.lock().unwrap();
        let conn: &mut Connection = &mut *guard;
        let tx = conn.transaction()?;
        let in_threads = "(SELECT id FROM threads WHERE account_id=?1)";
        tx.execute(&format!("DELETE FROM search WHERE thread_id IN {in_threads}"), params![account_id])?;
        tx.execute(&format!("DELETE FROM embeddings WHERE thread_id IN {in_threads}"), params![account_id])?;
        tx.execute(&format!("DELETE FROM messages WHERE thread_id IN {in_threads}"), params![account_id])?;
        tx.execute("DELETE FROM threads WHERE account_id=?1", params![account_id])?;
        tx.execute("DELETE FROM outbox WHERE account_id=?1", params![account_id])?;
        tx.execute("DELETE FROM folders WHERE account_id=?1", params![account_id])?;
        tx.execute("DELETE FROM account_sync_state WHERE account_id=?1", params![account_id])?;
        tx.execute("DELETE FROM imap_accounts WHERE account_id=?1", params![account_id])?;
        tx.execute("DELETE FROM accounts WHERE id=?1", params![account_id])?;
        tx.commit()?;
        Ok(())
    }

    /// Persist AI-generated artifacts (summary / draft) for a thread.
    pub fn set_ai_artifacts(&self, thread_id: &str, summary: Option<&str>, draft: Option<&str>) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        if let Some(s) = summary {
            conn.execute("UPDATE threads SET ai_summary=?1 WHERE id=?2", params![s, thread_id])?;
        }
        if let Some(d) = draft {
            conn.execute("UPDATE threads SET ai_draft=?1 WHERE id=?2", params![d, thread_id])?;
        }
        Ok(())
    }

    /// Set a thread's labels and (when prioritized) ensure it shows in Priority.
    pub fn set_triage(&self, thread_id: &str, labels: &[String], priority: bool) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        let views: Vec<String> = conn
            .query_row("SELECT views FROM threads WHERE id=?1", [thread_id], |r| r.get::<_, String>(0))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let mut set: Vec<String> = views;
        if priority && !set.iter().any(|v| v == "priority") {
            set.push("priority".into());
        }
        conn.execute(
            "UPDATE threads SET labels=?1, views=?2 WHERE id=?3",
            params![json(labels), json(&set), thread_id],
        )?;
        Ok(())
    }

    /// Persist read/unread for a thread and its messages (so it survives reload
    /// and re-sync, unlike the previous local-only toggle).
    pub fn set_thread_read(&self, thread_id: &str, unread: bool) -> rusqlite::Result<()> {
        let mut guard = self.conn.lock().unwrap();
        let conn: &mut Connection = &mut *guard;
        let now = chrono::Utc::now().timestamp();
        let tx = conn.transaction()?;
        tx.execute("UPDATE threads SET unread=?1, updated_at=?2 WHERE id=?3", params![unread as i64, now, thread_id])?;
        tx.execute("UPDATE messages SET seen=?1 WHERE thread_id=?2", params![(!unread) as i64, thread_id])?;
        tx.commit()?;
        Ok(())
    }

    /// Persist a thread's view membership (Archive = empty, Snooze = ["snoozed"],
    /// etc.). The single source of truth for which mailbox/smart-view a thread is in.
    pub fn set_thread_views(&self, thread_id: &str, views: &[String]) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "UPDATE threads SET views=?1, updated_at=?2 WHERE id=?3",
            params![json(views), now, thread_id],
        )?;
        Ok(())
    }

    /// Move a thread into a different mailbox locally (the source of truth for
    /// the Stream's folder filter). The server move is best-effort on top of this.
    pub fn set_thread_folder(&self, thread_id: &str, folder: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "UPDATE threads SET folder=?1, updated_at=?2 WHERE id=?3",
            params![folder, now, thread_id],
        )?;
        Ok(())
    }

    /// (source_folder, [RFC Message-ID headers]) needed to relocate a thread's
    /// messages on an IMAP server. Source folder is taken from the thread row.
    pub fn thread_move_refs(&self, thread_id: &str) -> Option<(String, Vec<String>)> {
        let conn = self.conn.lock().unwrap();
        let folder: String = conn
            .query_row("SELECT folder FROM threads WHERE id=?1", params![thread_id], |r| r.get(0))
            .ok()?;
        let mut stmt = conn.prepare("SELECT meta FROM messages WHERE thread_id=?1").ok()?;
        let ids = stmt
            .query_map(params![thread_id], |r| r.get::<_, Option<String>>(0))
            .ok()?
            .filter_map(Result::ok)
            .flatten()
            .filter_map(|j| serde_json::from_str::<MessageMeta>(&j).ok())
            .filter_map(|m| m.message_id)
            .collect();
        Some((folder, ids))
    }

    /// Set/clear a thread's flag (star). Local mirror of the IMAP `\Flagged` keyword.
    pub fn set_thread_flag(&self, thread_id: &str, flagged: bool) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        if flagged {
            conn.execute("INSERT OR IGNORE INTO thread_flags (thread_id) VALUES (?1)", params![thread_id])?;
        } else {
            conn.execute("DELETE FROM thread_flags WHERE thread_id=?1", params![thread_id])?;
        }
        Ok(())
    }

    /// All currently-flagged thread ids (drives the frontend's Flagged view, merged
    /// with any optimistic local flags).
    pub fn flagged_thread_ids(&self) -> Vec<String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare("SELECT thread_id FROM thread_flags") {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Total unread (non-deleted) threads across all accounts — a cheap signal the
    /// background poller compares before/after a sync to detect newly-arrived mail.
    pub fn unread_count(&self) -> i64 {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM threads WHERE unread=1 AND deleted=0", [], |r| r.get(0))
            .unwrap_or(0)
    }

    /// Threads that still need an AI summary (for incremental triage).
    pub fn unsummarized_threads(&self) -> Vec<Thread> {
        self.threads().into_iter().filter(|t| t.ai_summary.is_none()).collect()
    }

    pub fn set_sync_token(&self, account_id: &str, token: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE accounts SET sync_token=?1 WHERE id=?2", params![token, account_id])?;
        Ok(())
    }

    /// The stored incremental-sync cursor (Gmail historyId / Graph deltaLink).
    pub fn sync_token(&self, account_id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT sync_token FROM accounts WHERE id=?1", [account_id], |r| {
            r.get::<_, Option<String>>(0)
        })
        .ok()
        .flatten()
    }

    pub fn upsert_account(&self, id: &str, email: &str, provider: &str, name: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO accounts (id,email,provider,display_name) VALUES (?1,?2,?3,?4)
             ON CONFLICT(id) DO UPDATE SET email=excluded.email, display_name=excluded.display_name",
            params![id, email, provider, name],
        )?;
        Ok(())
    }

    // ---- durable user settings (key/value) ----

    pub fn set_setting(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn settings(&self) -> std::collections::HashMap<String, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare("SELECT key, value FROM settings") {
            Ok(s) => s,
            Err(_) => return std::collections::HashMap::new(),
        };
        stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map(|it| it.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    // ---- secret fallback (DB-backed; survives unsigned-app rebuilds) ----

    pub fn set_secret(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO secrets (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_secret(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT value FROM secrets WHERE key=?1", [key], |r| r.get(0)).ok()
    }

    pub fn delete_secret(&self, key: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM secrets WHERE key=?1", [key]);
    }

    // ---- folders (mailboxes) ----

    pub fn upsert_folder(&self, account_id: &str, name: &str, role: Option<&str>) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO folders (id, account_id, name, role) VALUES (?1,?2,?3,?4)
             ON CONFLICT(id) DO UPDATE SET role=excluded.role",
            params![format!("{account_id}:{name}"), account_id, name, role],
        )?;
        Ok(())
    }

    /// IMAP per-folder incremental cursor: the (UIDVALIDITY, UIDNEXT) observed at
    /// the last sync. `None` until the folder has been synced once, or if the
    /// server didn't report them. Used to fetch only UIDs that arrived since.
    pub fn imap_folder_cursor(&self, account_id: &str, folder: &str) -> Option<(u32, u32)> {
        let conn = self.conn.lock().unwrap();
        let row: Option<(Option<i64>, Option<i64>)> = conn
            .query_row(
                "SELECT uid_validity, uid_next FROM folders WHERE id=?1",
                params![format!("{account_id}:{folder}")],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        match row {
            Some((Some(v), Some(n))) => Some((v as u32, n as u32)),
            _ => None,
        }
    }

    /// How many messages we've already cached for an account's folder — used to
    /// compute the next OLDER chunk to backfill (we always hold the most-recent
    /// contiguous block, so `total - count` is the boundary below which is unsynced).
    pub fn message_count_for_folder(&self, account_id: &str, folder: &str) -> usize {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM messages m JOIN threads t ON m.thread_id = t.id WHERE t.account_id=?1 AND t.folder=?2",
            params![account_id, folder],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0)
        .max(0) as usize
    }

    /// Advance the IMAP incremental cursor for a folder (upserts the row so it
    /// works even before the folder list has been enumerated).
    pub fn set_imap_folder_cursor(&self, account_id: &str, folder: &str, uid_validity: u32, uid_next: u32) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO folders (id, account_id, name, uid_validity, uid_next) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(id) DO UPDATE SET uid_validity=excluded.uid_validity, uid_next=excluded.uid_next",
            params![format!("{account_id}:{folder}"), account_id, folder, uid_validity as i64, uid_next as i64],
        )?;
        Ok(())
    }

    /// Folders for an account with per-folder unread/total counts. Special-use
    /// roles sort first (Inbox, Sent, …), then the rest alphabetically.
    pub fn folders(&self, account_id: &str) -> Vec<FolderInfo> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT f.name, COALESCE(f.role,''),
                    (SELECT COUNT(*) FROM threads t WHERE t.account_id=f.account_id AND t.folder=f.name AND t.unread=1 AND t.deleted=0),
                    (SELECT COUNT(*) FROM threads t WHERE t.account_id=f.account_id AND t.folder=f.name AND t.deleted=0)
             FROM folders f WHERE f.account_id=?1
             ORDER BY (f.role IS NULL OR f.role=''), f.name",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([account_id], |r| {
            let role: String = r.get(1)?;
            Ok(FolderInfo {
                name: r.get(0)?,
                role: if role.is_empty() { None } else { Some(role) },
                unread: r.get::<_, i64>(2)? as u32,
                total: r.get::<_, i64>(3)? as u32,
            })
        })
        .map(|it| it.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    /// All connected accounts (for the sidebar account switcher), with an unread
    /// count per account so the UI can badge them.
    pub fn accounts(&self) -> Vec<AccountInfo> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT a.id, a.email, a.provider, COALESCE(a.display_name,''),
                    (SELECT COUNT(*) FROM threads t WHERE t.account_id = a.id AND t.unread = 1 AND t.deleted = 0)
             FROM accounts a ORDER BY a.email",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([], |r| {
            Ok(AccountInfo {
                id: r.get(0)?,
                email: r.get(1)?,
                provider: r.get(2)?,
                display_name: r.get(3)?,
                unread: r.get::<_, i64>(4)? as u32,
            })
        })
        .map(|it| it.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    // ---- reads (used by the UI) ----

    pub fn threads(&self) -> Vec<Thread> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, account_id, subject, preview, participants, last_time, unread, labels, views, ai_summary, ai_draft, folder
             FROM threads WHERE deleted=0 ORDER BY sort_ts DESC, rowid DESC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt
            .query_map([], |r| {
                let id: String = r.get(0)?;
                Ok(Thread {
                    id: id.clone(),
                    account_id: r.get(1)?,
                    subject: r.get(2)?,
                    preview: r.get(3)?,
                    participants: unjson(r.get::<_, String>(4).unwrap_or_default()),
                    last_time: r.get(5)?,
                    unread: r.get::<_, i64>(6)? != 0,
                    labels: unjson(r.get::<_, String>(7).unwrap_or_default()),
                    view: unjson(r.get::<_, String>(8).unwrap_or_default()),
                    ai_summary: r.get(9)?,
                    ai_draft: r.get(10)?,
                    folder: r.get::<_, String>(11).unwrap_or_else(|_| "INBOX".into()),
                    messages: Vec::new(),
                })
            })
            .map(|it| it.filter_map(Result::ok).collect::<Vec<_>>())
            .unwrap_or_default();

        // hydrate messages per thread
        rows.into_iter().map(|mut t| { t.messages = self.messages_for(&conn, &t.id); t }).collect()
    }

    fn messages_for(&self, conn: &Connection, thread_id: &str) -> Vec<Message> {
        let mut stmt = match conn.prepare(
            "SELECT id, from_name, from_addr, to_json, ts, body_html, attachments, meta FROM messages WHERE thread_id=?1 ORDER BY created_at, ts",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([thread_id], |r| {
            Ok(Message {
                id: r.get(0)?,
                from: Party { name: r.get(1)?, address: r.get(2)? },
                to: unjson_parties(r.get::<_, String>(3).unwrap_or_default()),
                when: r.get(4)?,
                body_html: r.get(5)?,
                attachments: serde_json::from_str(&r.get::<_, String>(6).unwrap_or_else(|_| "[]".into())).unwrap_or_default(),
                meta: r.get::<_, Option<String>>(7).ok().flatten().and_then(|s| serde_json::from_str(&s).ok()),
            })
        })
        .map(|it| it.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    pub fn tasks(&self) -> Vec<Task> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare("SELECT id, title, due, done FROM tasks") {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([], |r| {
            Ok(Task { id: r.get(0)?, title: r.get(1)?, due: r.get(2)?, done: r.get::<_, i64>(3)? != 0 })
        })
        .map(|it| it.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    pub fn set_task_done(&self, id: &str, done: bool) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE tasks SET done=?1 WHERE id=?2", params![done as i64, id])?;
        Ok(())
    }

    pub fn add_task(&self, t: &Task, source: Option<&str>) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO tasks (id,title,due,done,source_thread_id) VALUES (?1,?2,?3,?4,?5)",
            params![t.id, t.title, t.due, t.done as i64, source],
        )?;
        Ok(())
    }

    /// Keyword search via FTS5; returns matching thread ids.
    pub fn search(&self, query: &str) -> Vec<String> {
        // Build a forgiving FTS5 query: every alphanumeric run becomes a PREFIX
        // term ("lyca*"), so search-as-you-type works and stray punctuation
        // (@ . / etc.) can never break the FTS5 parser. Ranked by relevance.
        let fts: String = query
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
            .map(|w| format!("{w}*"))
            .collect::<Vec<_>>()
            .join(" ");
        if fts.is_empty() {
            return Vec::new();
        }
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare("SELECT thread_id FROM search WHERE search MATCH ?1 ORDER BY rank LIMIT 50") {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([fts.as_str()], |r| r.get::<_, String>(0))
            .map(|it| it.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Full-text search over subject + body (the FTS5 index holds the whole
    /// message text), hydrated into ranked Threads with their messages. This is
    /// what the search box should call — a client-side subject/preview filter
    /// can't see the body.
    pub fn search_threads(&self, query: &str) -> Vec<Thread> {
        let ids = self.search(query);
        if ids.is_empty() {
            return Vec::new();
        }
        let conn = self.conn.lock().unwrap();
        ids.iter()
            .filter_map(|id| {
                let mut t = conn
                    .query_row(
                        "SELECT id, account_id, subject, preview, participants, last_time, unread, labels, views, ai_summary, ai_draft, folder
                         FROM threads WHERE id=?1 AND deleted=0",
                        params![id],
                        |r| {
                            Ok(Thread {
                                id: r.get(0)?,
                                account_id: r.get(1)?,
                                subject: r.get(2)?,
                                preview: r.get(3)?,
                                participants: unjson(r.get::<_, String>(4).unwrap_or_default()),
                                last_time: r.get(5)?,
                                unread: r.get::<_, i64>(6)? != 0,
                                labels: unjson(r.get::<_, String>(7).unwrap_or_default()),
                                view: unjson(r.get::<_, String>(8).unwrap_or_default()),
                                ai_summary: r.get(9)?,
                                ai_draft: r.get(10)?,
                                folder: r.get::<_, String>(11).unwrap_or_else(|_| "INBOX".into()),
                                messages: Vec::new(),
                            })
                        },
                    )
                    .ok()?;
                t.messages = self.messages_for(&conn, &t.id);
                Some(t)
            })
            .collect()
    }

    pub fn events(&self) -> Vec<CalEvent> {
        // Calendar provider sync is Phase 1; show demo events only in demo mode.
        if std::env::var("BHARGA_DEMO").is_ok() {
            seed::events()
        } else {
            Vec::new()
        }
    }

    // ---- outbox ----

    pub fn enqueue_outbox(&self, item: &OutboxItem) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO outbox (id, account_id, thread_id, recipient, subject, body, attachments, scheduled_ts, status, cc, bcc)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![item.id, item.account_id, item.thread_id, item.to, item.subject, item.body, json(&item.attachments), item.scheduled_ts, item.status, item.cc, item.bcc],
        )?;
        Ok(())
    }

    /// Cancel a still-queued item (the heart of Undo Send). Returns true if removed.
    pub fn cancel_outbox(&self, id: &str) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute("DELETE FROM outbox WHERE id=?1 AND status='queued'", params![id])?;
        Ok(n > 0)
    }

    /// Items that are due to send now (queued and past their scheduled time).
    pub fn due_outbox(&self, now_ts: i64) -> Vec<OutboxItem> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, account_id, thread_id, recipient, subject, body, attachments, scheduled_ts, status, cc, bcc
             FROM outbox WHERE status='queued' AND scheduled_ts <= ?1 AND next_retry_ts <= ?1",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([now_ts], row_to_outbox)
            .map(|it| it.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    pub fn list_outbox(&self) -> Vec<OutboxItem> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, account_id, thread_id, recipient, subject, body, attachments, scheduled_ts, status, cc, bcc FROM outbox ORDER BY scheduled_ts",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([], row_to_outbox)
            .map(|it| it.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Atomically claim a queued item for sending (avoids double-send across
    /// the background loop and a UI-triggered flush). Returns true if claimed.
    pub fn claim_outbox(&self, id: &str) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute("UPDATE outbox SET status='sending' WHERE id=?1 AND status='queued'", params![id])?;
        Ok(n > 0)
    }

    pub fn mark_outbox(&self, id: &str, status: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE outbox SET status=?1 WHERE id=?2", params![status, id])?;
        Ok(())
    }

    /// Record a send failure. Increments the attempt count and either schedules an
    /// exponential-backoff retry (status back to `queued`) or, once the attempt
    /// budget is exhausted, moves the item to the dead-letter queue. Returns true
    /// if the item was dead-lettered.
    pub fn mark_outbox_failure(&self, id: &str, error: &str, max_attempts: i64) -> rusqlite::Result<bool> {
        let mut guard = self.conn.lock().unwrap();
        let conn: &mut Connection = &mut *guard;
        let now = chrono::Utc::now().timestamp();
        let tx = conn.transaction()?;
        let attempts: i64 = tx
            .query_row("SELECT attempts FROM outbox WHERE id=?1", [id], |r| r.get(0))
            .unwrap_or(0)
            + 1;
        if attempts >= max_attempts {
            tx.execute(
                "INSERT OR REPLACE INTO dead_letter (id, account_id, recipient, subject, body, attachments, error, attempts, failed_at)
                 SELECT id, account_id, recipient, subject, body, attachments, ?2, ?3, ?4 FROM outbox WHERE id=?1",
                params![id, error, attempts, now],
            )?;
            tx.execute("DELETE FROM outbox WHERE id=?1", params![id])?;
            tx.commit()?;
            Ok(true)
        } else {
            // 30s, 60s, 120s, … capped at ~32 min.
            let backoff = 30_i64 * (1_i64 << (attempts - 1).clamp(0, 6));
            tx.execute(
                "UPDATE outbox SET status='queued', attempts=?2, last_error=?3, next_retry_ts=?4 WHERE id=?1",
                params![id, attempts, error, now + backoff],
            )?;
            tx.commit()?;
            Ok(false)
        }
    }

    /// Messages that exhausted their retries (operator visibility / manual requeue).
    pub fn dead_letters(&self) -> Vec<OutboxItem> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, account_id, NULL as thread_id, recipient, subject, body, attachments, failed_at, 'dead' as status
             FROM dead_letter ORDER BY failed_at DESC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([], row_to_outbox)
            .map(|it| it.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    // ---- embeddings (semantic search) ----

    pub fn upsert_embedding(&self, thread_id: &str, vec: &[f32]) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO embeddings (thread_id, dim, vec) VALUES (?1,?2,?3)
             ON CONFLICT(thread_id) DO UPDATE SET dim=excluded.dim, vec=excluded.vec",
            params![thread_id, vec.len() as i64, f32_to_blob(vec)],
        )?;
        Ok(())
    }

    pub fn all_embeddings(&self) -> Vec<(String, Vec<f32>)> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare("SELECT thread_id, vec FROM embeddings") {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([], |r| {
            let id: String = r.get(0)?;
            let blob: Vec<u8> = r.get(1)?;
            Ok((id, blob_to_f32(&blob)))
        })
        .map(|it| it.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    pub fn embedding_count(&self) -> i64 {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM embeddings", [], |r| r.get(0)).unwrap_or(0)
    }

    // ---- IMAP/SMTP accounts ----

    pub fn upsert_imap_account(&self, a: &ImapAccount) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO imap_accounts
                (account_id, email, display_name, imap_host, imap_port, imap_security, imap_username, smtp_host, smtp_port, smtp_security, smtp_username)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
             ON CONFLICT(account_id) DO UPDATE SET
                email=excluded.email, display_name=excluded.display_name,
                imap_host=excluded.imap_host, imap_port=excluded.imap_port, imap_security=excluded.imap_security, imap_username=excluded.imap_username,
                smtp_host=excluded.smtp_host, smtp_port=excluded.smtp_port, smtp_security=excluded.smtp_security, smtp_username=excluded.smtp_username",
            params![
                a.account_id, a.email, a.display_name,
                a.imap_host, a.imap_port as i64, a.imap_security.as_str(), a.imap_username,
                a.smtp_host, a.smtp_port as i64, a.smtp_security.as_str(), a.smtp_username,
            ],
        )?;
        Ok(())
    }

    pub fn imap_account(&self, account_id: &str) -> Option<ImapAccount> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT account_id, email, display_name, imap_host, imap_port, imap_security, imap_username, smtp_host, smtp_port, smtp_security, smtp_username
             FROM imap_accounts WHERE account_id=?1",
            [account_id],
            |r| {
                Ok(ImapAccount {
                    account_id: r.get(0)?,
                    email: r.get(1)?,
                    display_name: r.get(2)?,
                    imap_host: r.get(3)?,
                    imap_port: r.get::<_, i64>(4)? as u16,
                    imap_security: Security::parse(&r.get::<_, String>(5)?),
                    imap_username: r.get(6)?,
                    smtp_host: r.get(7)?,
                    smtp_port: r.get::<_, i64>(8)? as u16,
                    smtp_security: Security::parse(&r.get::<_, String>(9)?),
                    smtp_username: r.get(10)?,
                })
            },
        )
        .ok()
    }

    /// Ids of threads that don't yet have an embedding (for incremental indexing).
    pub fn unembedded_thread_ids(&self) -> Vec<String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT t.id FROM threads t LEFT JOIN embeddings e ON e.thread_id = t.id WHERE e.thread_id IS NULL",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([], |r| r.get::<_, String>(0))
            .map(|it| it.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }
}

/// v1 — baseline schema. Uses `CREATE TABLE IF NOT EXISTS` so it is safe on both
/// fresh DBs (which get the full, FK-enforced shape) and pre-versioning DBs (whose
/// existing tables are preserved; new columns are added by later steps). Also
/// retires the incompatible pre-redesign `imap_accounts` table.
fn migrate_v1_baseline(tx: &rusqlite::Transaction) -> rusqlite::Result<()> {
    // Retire a pre-redesign imap_accounts (old `username` shape, missing
    // imap_username). It holds only config — passwords live in the OS keychain.
    let stale = {
        let exists = tx
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='imap_accounts'")
            .and_then(|mut s| s.exists([]))
            .unwrap_or(false);
        let has_new = tx
            .prepare("SELECT 1 FROM pragma_table_info('imap_accounts') WHERE name='imap_username'")
            .and_then(|mut s| s.exists([]))
            .unwrap_or(false);
        exists && !has_new
    };
    if stale {
        let _ = tx.execute("DROP TABLE imap_accounts", []);
    }
    tx.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            provider TEXT NOT NULL,
            display_name TEXT,
            sync_token TEXT
        );
        CREATE TABLE IF NOT EXISTS threads (
            id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            subject TEXT,
            preview TEXT,
            participants TEXT,           -- JSON array
            last_time TEXT,              -- display string (provider Date header)
            unread INTEGER DEFAULT 1,
            labels TEXT,                 -- JSON array
            views TEXT,                  -- JSON array
            ai_summary TEXT,
            ai_draft TEXT,
            sort_ts INTEGER NOT NULL DEFAULT 0,   -- canonical epoch secs for ordering
            created_at INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0,
            deleted INTEGER NOT NULL DEFAULT 0,   -- soft-delete tombstone (user trash)
            folder TEXT NOT NULL DEFAULT 'INBOX'  -- mailbox this thread belongs to
        );
        CREATE INDEX IF NOT EXISTS idx_threads_account ON threads(account_id);
        CREATE INDEX IF NOT EXISTS idx_threads_sort ON threads(sort_ts DESC);
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
            from_name TEXT, from_addr TEXT,
            to_json TEXT,
            ts TEXT,
            body_html TEXT,
            attachments TEXT NOT NULL DEFAULT '[]',
            seen INTEGER NOT NULL DEFAULT 0,
            flagged INTEGER NOT NULL DEFAULT 0,
            answered INTEGER NOT NULL DEFAULT 0,
            draft INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT 0,
            meta TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            due TEXT,
            done INTEGER DEFAULT 0,
            source_thread_id TEXT
        );
        -- Full-text index over subject + body for fast keyword search.
        CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
            thread_id UNINDEXED, subject, body
        );
        -- Keep the FTS index and embeddings in lockstep with thread deletes
        -- (covers account-cascade deletes and DBs created before FK enforcement).
        CREATE TRIGGER IF NOT EXISTS threads_after_delete AFTER DELETE ON threads BEGIN
            DELETE FROM search WHERE thread_id = OLD.id;
            DELETE FROM embeddings WHERE thread_id = OLD.id;
        END;
        CREATE TABLE IF NOT EXISTS outbox (
            id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL,
            thread_id TEXT,
            recipient TEXT NOT NULL,
            cc TEXT NOT NULL DEFAULT '',
            bcc TEXT NOT NULL DEFAULT '',
            subject TEXT,
            body TEXT,
            attachments TEXT NOT NULL DEFAULT '[]',
            scheduled_ts INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued',  -- queued|sending|sent|failed
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            next_retry_ts INTEGER NOT NULL DEFAULT 0
        );
        -- Terminal send failures (exhausted retries) for operator visibility.
        CREATE TABLE IF NOT EXISTS dead_letter (
            id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL,
            recipient TEXT, subject TEXT, body TEXT,
            attachments TEXT NOT NULL DEFAULT '[]',
            error TEXT,
            attempts INTEGER NOT NULL DEFAULT 0,
            failed_at INTEGER NOT NULL DEFAULT 0
        );
        -- Semantic search: one embedding vector per thread (f32 little-endian blob).
        CREATE TABLE IF NOT EXISTS embeddings (
            thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
            dim INTEGER NOT NULL,
            vec BLOB NOT NULL,
            model TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL DEFAULT 0
        );
        -- Mailboxes per account (IMAP folders / Gmail labels / Graph mailFolders).
        CREATE TABLE IF NOT EXISTS folders (
            id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            role TEXT,                   -- inbox|sent|drafts|trash|archive|custom
            uid_validity INTEGER,
            uid_next INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_folders_account ON folders(account_id);
        -- Per-folder incremental-sync cursor (IMAP UIDVALIDITY/UIDNEXT, Gmail
        -- historyId, Graph deltaLink) — the single `accounts.sync_token` is too coarse.
        CREATE TABLE IF NOT EXISTS account_sync_state (
            account_id TEXT NOT NULL,
            folder TEXT NOT NULL,
            cursor TEXT,
            uid_validity INTEGER,
            uid_next INTEGER,
            last_sync_ts INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (account_id, folder)
        );
        -- IMAP/SMTP account config (passwords live in the OS keychain, not here).
        CREATE TABLE IF NOT EXISTS imap_accounts (
            account_id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            display_name TEXT NOT NULL DEFAULT '',
            imap_host TEXT NOT NULL,
            imap_port INTEGER NOT NULL,
            imap_security TEXT NOT NULL DEFAULT 'ssl',
            imap_username TEXT NOT NULL,
            smtp_host TEXT NOT NULL,
            smtp_port INTEGER NOT NULL,
            smtp_security TEXT NOT NULL DEFAULT 'ssl',
            smtp_username TEXT NOT NULL
        );
        -- Credential/token fallback (keychain is primary; see migrate_v5_secrets).
        CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        -- Durable UI/user settings (theme, density, font, locale, …).
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        "#,
    )?;
    // Bridge ALTERs for DBs created between the first release and versioning
    // (guarded: the duplicate-column error is ignored when already present).
    for s in [
        "ALTER TABLE outbox ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'",
        "ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'",
    ] {
        let _ = tx.execute(s, []);
    }
    Ok(())
}

/// v2 — bring pre-versioning tables up to the v1 column set. All guarded so they
/// no-op on fresh DBs that already have these columns from v1.
fn migrate_v2_integrity(tx: &rusqlite::Transaction) -> rusqlite::Result<()> {
    for s in [
        "ALTER TABLE threads ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE threads ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE messages ADD COLUMN seen INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE messages ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE messages ADD COLUMN answered INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE messages ADD COLUMN draft INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE messages ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE outbox ADD COLUMN last_error TEXT",
        "ALTER TABLE outbox ADD COLUMN next_retry_ts INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE embeddings ADD COLUMN model TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE embeddings ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0",
    ] {
        let _ = tx.execute(s, []);
    }
    Ok(())
}

/// v3 — local user-state that must survive re-sync: a soft-delete tombstone so a
/// deleted thread isn't re-created by the next sync (until a real two-way trash
/// lands). `unread`/`views` are made local-authoritative in `upsert_thread`.
fn migrate_v3_user_state(tx: &rusqlite::Transaction) -> rusqlite::Result<()> {
    let _ = tx.execute("ALTER TABLE threads ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0", []);
    let _ = tx.execute("CREATE INDEX IF NOT EXISTS idx_threads_deleted ON threads(deleted)", []);
    Ok(())
}

/// v4 — per-message header detail (recipients, originating IP, auth results),
/// stored as JSON so the schema doesn't sprawl.
fn migrate_v4_message_meta(tx: &rusqlite::Transaction) -> rusqlite::Result<()> {
    let _ = tx.execute("ALTER TABLE messages ADD COLUMN meta TEXT", []);
    Ok(())
}

/// v5 — local fallback for credentials/tokens. The OS keychain is primary, but an
/// unsigned app gets a new code signature on every rebuild and loses keychain
/// access, which was wiping the account each build; this table (keyed off the
/// stable app identifier) survives rebuilds.
fn migrate_v5_secrets(tx: &rusqlite::Transaction) -> rusqlite::Result<()> {
    let _ = tx.execute(
        "CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        [],
    );
    Ok(())
}

/// v6 — per-thread folder (mailbox) so the UI can browse Sent/Drafts/Trash/etc.
fn migrate_v6_thread_folder(tx: &rusqlite::Transaction) -> rusqlite::Result<()> {
    let _ = tx.execute("ALTER TABLE threads ADD COLUMN folder TEXT NOT NULL DEFAULT 'INBOX'", []);
    let _ = tx.execute("CREATE INDEX IF NOT EXISTS idx_threads_folder ON threads(account_id, folder)", []);
    Ok(())
}

/// v7 — durable user settings (theme, density, font, locale, …) so UI prefs live
/// in the app's data model rather than only the webview's localStorage.
fn migrate_v7_settings(tx: &rusqlite::Transaction) -> rusqlite::Result<()> {
    let _ = tx.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)", []);
    Ok(())
}

/// v8 — one-time reset of the mail cache. Earlier builds keyed threads/messages by
/// schemes that changed over time (message-id → conversation-root → account+folder),
/// which left duplicate/empty rows and leftover demo data. Accounts, credentials,
/// settings and folders are preserved; the next sync rebuilds the cache cleanly.
fn migrate_v8_reset_cache(tx: &rusqlite::Transaction) -> rusqlite::Result<()> {
    for stmt in [
        "DELETE FROM messages",
        "DELETE FROM threads",
        "DELETE FROM embeddings",
        "DELETE FROM search",
    ] {
        let _ = tx.execute(stmt, []);
    }
    Ok(())
}

/// v9: carry Cc/Bcc on outgoing mail so the composer can address multiple
/// recipient classes (existing rows default to empty).
fn migrate_v9_outbox_cc_bcc(tx: &rusqlite::Transaction) -> rusqlite::Result<()> {
    // ALTER may fail if a fresh DB already created the columns; ignore that.
    let _ = tx.execute("ALTER TABLE outbox ADD COLUMN cc TEXT NOT NULL DEFAULT ''", []);
    let _ = tx.execute("ALTER TABLE outbox ADD COLUMN bcc TEXT NOT NULL DEFAULT ''", []);
    Ok(())
}

/// v10: rebuild previews for already-synced threads with the new HTML5-parser
/// extraction, so old rows that captured Outlook VML / raw entities are cleaned
/// up in place (the incremental sync won't re-fetch them). Derived from each
/// thread's most recent stored message body.
fn migrate_v10_rebuild_previews(tx: &rusqlite::Transaction) -> rusqlite::Result<()> {
    let rows: Vec<(String, String)> = {
        let mut stmt = tx.prepare(
            "SELECT t.id, COALESCE(
                 (SELECT m.body_html FROM messages m WHERE m.thread_id = t.id ORDER BY m.rowid DESC LIMIT 1), '')
             FROM threads t",
        )?;
        let mapped = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        mapped.filter_map(Result::ok).collect()
    };
    for (id, body) in rows {
        if body.trim().is_empty() {
            continue;
        }
        let preview: String = strip_html(&body).chars().take(140).collect();
        tx.execute("UPDATE threads SET preview = ?1 WHERE id = ?2", params![preview, id])?;
    }
    Ok(())
}

/// v11: per-thread flag (star). Stored separately from the thread row so the
/// existing Thread shape is untouched; presence of the id means flagged. Synced
/// to/from the IMAP `\Flagged` keyword by the sync layer.
fn migrate_v11_thread_flags(tx: &rusqlite::Transaction) -> rusqlite::Result<()> {
    tx.execute("CREATE TABLE IF NOT EXISTS thread_flags (thread_id TEXT PRIMARY KEY)", [])?;
    Ok(())
}

/// Parse a provider date header (RFC 2822 from IMAP/Gmail, RFC 3339 from Graph)
/// into epoch seconds for canonical ordering. Returns None if unparseable.
fn parse_epoch(s: &str) -> Option<i64> {
    use chrono::DateTime;
    DateTime::parse_from_rfc2822(s)
        .or_else(|_| DateTime::parse_from_rfc3339(s))
        .ok()
        .map(|dt| dt.timestamp())
}

fn f32_to_blob(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

fn blob_to_f32(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

fn row_to_outbox(r: &rusqlite::Row) -> rusqlite::Result<OutboxItem> {
    Ok(OutboxItem {
        id: r.get(0)?,
        account_id: r.get(1)?,
        thread_id: r.get(2)?,
        to: r.get(3)?,
        subject: r.get(4)?,
        body: r.get(5)?,
        attachments: serde_json::from_str(&r.get::<_, String>(6).unwrap_or_else(|_| "[]".into())).unwrap_or_default(),
        scheduled_ts: r.get(7)?,
        status: r.get(8)?,
        // cc/bcc are appended columns; SELECTs that omit them (e.g. dead_letters) default to empty.
        cc: r.get(9).unwrap_or_default(),
        bcc: r.get(10).unwrap_or_default(),
    })
}

// ---- small JSON helpers (avoid pulling serde_json types into the row code) ----
fn json<T: Serialize + ?Sized>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[]".into())
}
fn unjson(s: String) -> Vec<String> {
    serde_json::from_str(&s).unwrap_or_default()
}
fn unjson_parties(s: String) -> Vec<Party> {
    serde_json::from_str(&s).unwrap_or_default()
}
/// Convert an HTML body into a clean one-line text snippet for previews, search,
/// and AI input. Delegates to a real HTML5 parser (html2text/html5ever) so
/// malformed Outlook/Word markup, `<style>`/`<script>` blocks, MSO conditional
/// comments and HTML entities are all handled correctly — then collapses
/// whitespace. (For IMAP we prefer the message's text/plain part upstream; this
/// is the fallback for HTML-only mail, and the path used for search/AI text.)
/// HTML → plain text, keeping line structure (so quoted-history can be detected).
pub fn html_to_text(s: &str) -> String {
    use html2text::render::text_renderer::TrivialDecorator;
    html2text::config::with_decorator(TrivialDecorator::new())
        .string_from_read(s.as_bytes(), 10_000)
        .unwrap_or_default()
}

pub fn strip_html(s: &str) -> String {
    html_to_text(s).split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Trim quoted reply history off a plain-text body so a preview/snippet shows the
/// NEW content, not the chain below it. Returns the leading new content, collapsed
/// to a single line; falls back to the whole text if there's nothing above the
/// quote (a pure forward).
pub fn strip_quoted(text: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for line in text.lines() {
        let l = line.trim();
        let ll = l.to_lowercase();
        let is_divider = l.chars().count() >= 8 && l.chars().all(|c| matches!(c, '_' | '-' | '–' | '—' | ' '));
        if ll.starts_with('>')
            || ll.starts_with("from:") || ll.starts_with("von:") || ll.starts_with("da:")
            || ll.starts_with("-----original") || ll.starts_with("________")
            || (ll.starts_with("on ") && ll.ends_with("wrote:"))
            || ll.ends_with("schrieb:") || ll.ends_with("ha scritto:") || ll.ends_with("a écrit :")
            || is_divider
        {
            break;
        }
        out.push(line);
    }
    let collapsed = out.join(" ").split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        text.split_whitespace().collect::<Vec<_>>().join(" ")
    } else {
        collapsed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_html_works() {
        assert_eq!(strip_html("<p>Hello <b>world</b></p>"), "Hello world");
    }

    #[test]
    fn strip_quoted_trims_reply_history() {
        let outlook = "Sounds good, see you then.\n________________________________\nFrom: Bob <b@x.com>\nSent: Monday\nSubject: Hi\nOriginal body.";
        assert_eq!(strip_quoted(outlook), "Sounds good, see you then.");

        let gmail = "Thanks!\nOn Mon, May 28, 2026 Bob wrote:\n> earlier text";
        assert_eq!(strip_quoted(gmail), "Thanks!");

        // Pure forward (quote first) → keep the whole thing rather than return empty.
        let fwd = "From: Bob\nSubject: Hi\nbody";
        assert!(!strip_quoted(fwd).is_empty());

        // No quote → unchanged (collapsed).
        assert_eq!(strip_quoted("Just a normal line."), "Just a normal line.");
    }

    #[test]
    fn strip_html_drops_style_blocks_and_decodes_entities() {
        // Outlook/Word VML inside <style> and MSO conditional comments must not
        // leak into the preview, and entities must be decoded.
        let html = "<html><head><style>v\\:* {behavior:url(#default#VML);} o\\:* {}</style></head>\
                    <body><!--[if gte mso 9]><xml><o:shapedefaults/></xml><![endif]-->\
                    <p>Dear Arjun, Hope you&#39;re well &amp; ready.</p></body></html>";
        let out = strip_html(html);
        assert!(!out.contains("VML"), "style block leaked: {out}");
        assert!(!out.contains("behavior"), "css leaked: {out}");
        assert!(out.contains("Dear Arjun"));
        assert!(out.contains("you're well & ready"));
    }

    #[test]
    fn embedding_blob_roundtrip() {
        let v = vec![0.1f32, -0.25, 3.5, 42.0];
        assert_eq!(blob_to_f32(&f32_to_blob(&v)), v);
    }

    #[test]
    fn embedding_store_roundtrip() {
        let s = Store::in_memory().unwrap();
        // FK: the embedding's thread must exist first.
        s.upsert_account("a1", "x@y.z", "gmail", "X").unwrap();
        s.upsert_thread(&Thread {
            id: "t1".into(), account_id: "a1".into(), subject: "s".into(), preview: "p".into(),
            participants: vec![], last_time: "".into(), unread: false, labels: vec![],
            view: vec![], folder: "INBOX".into(), ai_summary: None, ai_draft: None, messages: vec![],
        }).unwrap();
        s.upsert_embedding("t1", &[1.0, 2.0, 3.0]).unwrap();
        assert_eq!(s.embedding_count(), 1);
        let all = s.all_embeddings();
        assert_eq!(all[0].1, vec![1.0, 2.0, 3.0]);
    }

    #[test]
    fn upsert_and_read_roundtrip() {
        let s = Store::in_memory().unwrap();
        s.upsert_account("a1", "x@y.z", "gmail", "X").unwrap();
        s.upsert_thread(&Thread {
            id: "t1".into(), account_id: "a1".into(), subject: "Hi".into(), preview: "p".into(),
            participants: vec!["A".into()], last_time: "now".into(), unread: true,
            labels: vec![], view: vec!["inbox".into()], folder: "INBOX".into(), ai_summary: None, ai_draft: None,
            messages: vec![Message { id: "m1".into(), from: Party { name: "A".into(), address: "a@b.c".into() }, to: vec![], when: "t".into(), body_html: "<p>hey</p>".into(), attachments: vec![], meta: None }],
        }).unwrap();
        let got = s.threads();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].messages.len(), 1);
        assert!(!s.search("hey").is_empty());
    }

    #[test]
    fn imap_account_roundtrip() {
        let s = Store::in_memory().unwrap();
        let acct = ImapAccount {
            account_id: "imap1".into(), email: "me@host.de".into(), display_name: "Me".into(),
            imap_host: "imap.host.de".into(), imap_port: 993, imap_security: Security::Ssl, imap_username: "me@host.de".into(),
            smtp_host: "smtp.host.de".into(), smtp_port: 587, smtp_security: Security::Starttls, smtp_username: "me@host.de".into(),
        };
        s.upsert_imap_account(&acct).unwrap();
        let got = s.imap_account("imap1").unwrap();
        assert_eq!(got.display_name, "Me");
        assert_eq!(got.imap_port, 993);
        assert_eq!(got.smtp_security.as_str(), "starttls");
    }

    /// Regression: a DB created by a pre-redesign build (old `imap_accounts`
    /// shape with a `username` column and no per-server columns) must migrate so
    /// new accounts save. This is the "table imap_accounts has no column named
    /// display_name" bug.
    #[test]
    fn migrates_stale_imap_accounts_schema() {
        let conn = Connection::open_in_memory().unwrap();
        // Recreate the legacy table shape *before* migrate runs.
        conn.execute_batch(
            "CREATE TABLE imap_accounts (
                account_id TEXT PRIMARY KEY, email TEXT NOT NULL,
                smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL, username TEXT NOT NULL,
                imap_host TEXT, imap_port INTEGER
            );
            INSERT INTO imap_accounts (account_id,email,smtp_host,smtp_port,username,imap_host,imap_port)
            VALUES ('old','o@x.de','smtp.x.de',587,'o@x.de','imap.x.de',993);",
        ).unwrap();
        let s = Store { conn: Mutex::new(conn) };
        s.migrate().unwrap(); // drops the stale table and recreates the new shape
        // A fresh account now saves and reads back with the new columns.
        let acct = ImapAccount {
            account_id: "new".into(), email: "n@x.de".into(), display_name: "New".into(),
            imap_host: "imap.x.de".into(), imap_port: 993, imap_security: Security::Ssl, imap_username: "n@x.de".into(),
            smtp_host: "smtp.x.de".into(), smtp_port: 465, smtp_security: Security::Ssl, smtp_username: "n@x.de".into(),
        };
        s.upsert_imap_account(&acct).unwrap();
        assert_eq!(s.imap_account("new").unwrap().display_name, "New");
    }

    fn thread_with(id: &str, date: &str, body: &str) -> Thread {
        Thread {
            id: id.into(), account_id: "a1".into(), subject: format!("subj {id}"), preview: "p".into(),
            participants: vec!["A".into()], last_time: date.into(), unread: true, labels: vec![],
            view: vec!["inbox".into()], folder: "INBOX".into(), ai_summary: None, ai_draft: None,
            messages: vec![Message {
                id: format!("m-{id}"), from: Party { name: "A".into(), address: "a@b.c".into() },
                to: vec![], when: date.into(), body_html: format!("<p>{body}</p>"), attachments: vec![], meta: None,
            }],
        }
    }

    #[test]
    fn fts_has_no_duplicates_after_resync() {
        let s = Store::in_memory().unwrap();
        s.upsert_account("a1", "x@y.z", "gmail", "X").unwrap();
        let t = thread_with("t1", "Fri, 29 May 2026 10:00:00 +0000", "hello world");
        s.upsert_thread(&t).unwrap();
        s.upsert_thread(&t).unwrap(); // re-sync must not duplicate the FTS row
        s.upsert_thread(&t).unwrap();
        assert_eq!(s.search("hello").len(), 1);
    }

    #[test]
    fn threads_sorted_by_message_date_not_insertion() {
        let s = Store::in_memory().unwrap();
        s.upsert_account("a1", "x@y.z", "gmail", "X").unwrap();
        // Insert older first, newer second; ordering must be by date, not rowid.
        s.upsert_thread(&thread_with("old", "Fri, 01 May 2026 10:00:00 +0000", "a")).unwrap();
        s.upsert_thread(&thread_with("new", "Wed, 20 May 2026 10:00:00 +0000", "b")).unwrap();
        let ordered = s.threads();
        assert_eq!(ordered[0].id, "new");
        assert_eq!(ordered[1].id, "old");
    }

    #[test]
    fn delete_account_cascades_everything() {
        let s = Store::in_memory().unwrap();
        s.upsert_account("a1", "x@y.z", "gmail", "X").unwrap();
        s.upsert_thread(&thread_with("t1", "Fri, 29 May 2026 10:00:00 +0000", "hi")).unwrap();
        s.upsert_embedding("t1", &[1.0, 2.0]).unwrap();
        assert_eq!(s.threads().len(), 1);
        s.delete_account("a1").unwrap();
        assert!(s.threads().is_empty());
        assert_eq!(s.embedding_count(), 0);
        assert!(s.search("hi").is_empty());
    }

    #[test]
    fn outbox_retries_then_dead_letters() {
        let s = Store::in_memory().unwrap();
        let item = OutboxItem {
            id: "o1".into(), account_id: "a1".into(), thread_id: None,
            to: "x@y.z".into(), cc: String::new(), bcc: String::new(),
            subject: "hi".into(), body: "b".into(),
            attachments: vec![], scheduled_ts: 0, status: "queued".into(),
        };
        s.enqueue_outbox(&item).unwrap();
        // 4 failures stay in the queue (retry); the 5th exhausts the budget.
        for _ in 0..4 {
            assert_eq!(s.mark_outbox_failure("o1", "smtp timeout", 5).unwrap(), false);
        }
        assert_eq!(s.mark_outbox_failure("o1", "smtp timeout", 5).unwrap(), true);
        assert!(s.list_outbox().is_empty());
        assert_eq!(s.dead_letters().len(), 1);
    }

    #[test]
    fn user_state_survives_resync() {
        let s = Store::in_memory().unwrap();
        s.upsert_account("a1", "x@y.z", "gmail", "X").unwrap();
        let mut t = thread_with("t1", "Fri, 29 May 2026 10:00:00 +0000", "hi");
        t.unread = true;
        s.upsert_thread(&t).unwrap();
        // User marks it read and archives it.
        s.set_thread_read("t1", false).unwrap();
        s.set_thread_views("t1", &[]).unwrap();
        // A re-sync arrives still flagged unread/in-inbox — local state must win.
        s.upsert_thread(&t).unwrap();
        let got = &s.threads()[0];
        assert!(!got.unread, "read state should survive re-sync");
        assert!(got.view.is_empty(), "archive should survive re-sync");
    }

    #[test]
    fn secret_roundtrip() {
        let s = Store::in_memory().unwrap();
        assert_eq!(s.get_secret("imap:me:imap-pass"), None);
        s.set_secret("imap:me:imap-pass", "hunter2").unwrap();
        assert_eq!(s.get_secret("imap:me:imap-pass").as_deref(), Some("hunter2"));
        s.set_secret("imap:me:imap-pass", "newpass").unwrap(); // upsert
        assert_eq!(s.get_secret("imap:me:imap-pass").as_deref(), Some("newpass"));
        s.delete_secret("imap:me:imap-pass");
        assert_eq!(s.get_secret("imap:me:imap-pass"), None);
    }

    #[test]
    fn tombstone_hides_thread_and_survives_resync() {
        let s = Store::in_memory().unwrap();
        s.upsert_account("a1", "x@y.z", "gmail", "X").unwrap();
        let t = thread_with("t1", "Fri, 29 May 2026 10:00:00 +0000", "hi");
        s.upsert_thread(&t).unwrap();
        s.tombstone_thread("t1").unwrap();
        assert!(s.threads().is_empty(), "deleted thread should be hidden");
        s.upsert_thread(&t).unwrap(); // re-sync must not resurrect it
        assert!(s.threads().is_empty(), "tombstone should survive re-sync");
    }
}
