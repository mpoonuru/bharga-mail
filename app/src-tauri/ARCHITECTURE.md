# Aether Mail — Local Store Architecture (v2)

The desktop core persists everything in a single bundled SQLite database
(`aether.db` in the OS app-data dir). The UI reads from this store; the sync
engine reconciles it with remote providers in the background. This document is
the contract for the schema and how it evolves.

## Migration policy (the rule that was missing before)

Schema is versioned with `PRAGMA user_version` and applied by an **ordered,
transactional runner** in `store::Store::migrate`. Each step is a
`fn(&Transaction) -> Result<()>` that runs exactly once, in its own transaction,
only when the DB's version is older than the step's.

**To change the schema you append a step — never edit an old one.** This is the
single source of truth and is what prevents the "table has no column named X"
drift that `CREATE TABLE IF NOT EXISTS` allowed (it silently does nothing to an
existing table, so new columns never appeared on upgraded DBs).

- Fresh installs get the full, FK-enforced schema from step 1.
- Pre-existing DBs keep their tables (step 1 is `IF NOT EXISTS`) and have missing
  columns added by later guarded `ALTER` steps.
- An incompatible change to a config-only table (e.g. the `imap_accounts`
  redesign) is handled by detect-and-recreate inside a step, because SQLite
  cannot reshape a table with renamed columns via `ALTER`.

Pragmas (`journal_mode=WAL`, `foreign_keys=ON`) are set once, outside any
transaction, before the runner starts.

## Tables

| table | purpose | key relationships |
|---|---|---|
| `accounts` | connected mail accounts | parent of threads/folders |
| `threads` | conversation read-model | `account_id → accounts(id)` ON DELETE CASCADE |
| `messages` | individual messages | `thread_id → threads(id)` ON DELETE CASCADE; flags `seen/flagged/answered/draft` |
| `search` | FTS5 over subject+body | kept in sync by trigger + replace-on-upsert |
| `embeddings` | one vector per thread | `thread_id → threads(id)` ON DELETE CASCADE; `model`, `created_at` |
| `outbox` | queued/sending mail | retry: `attempts`, `last_error`, `next_retry_ts` |
| `dead_letter` | terminal send failures | populated when retries are exhausted |
| `folders` | mailboxes per account | `account_id → accounts(id)` ON DELETE CASCADE; `uid_validity`, `uid_next` |
| `account_sync_state` | per-folder sync cursor | PK `(account_id, folder)` — IMAP UIDVALIDITY/UIDNEXT, Gmail historyId, Graph delta |
| `imap_accounts` | IMAP/SMTP connection config | passwords are **not** here — they live in the OS keychain |
| `tasks` | extracted to-dos | optional `source_thread_id` |

### Integrity guarantees

- **Foreign keys + `ON DELETE CASCADE`** on threads/messages/embeddings/folders
  (fresh installs). `delete_account` / `delete_thread` also do explicit cleanup
  so behaviour is correct on older DBs that predate FK enforcement.
- An **AFTER DELETE trigger on `threads`** removes the matching `search` and
  `embeddings` rows, covering account-cascade deletes and the standalone FTS5
  table (which is not FK-aware).
- **`upsert_thread` is fully transactional**: the thread row, its messages, and
  the FTS row commit together or not at all. The FTS row is **replaced**
  (delete-then-insert) so re-syncing a thread can no longer duplicate it.

### Ordering

`threads.sort_ts` is the canonical ordering key: epoch seconds parsed from the
newest message's `Date`/`receivedDateTime` header (RFC 2822 or RFC 3339), with a
fallback to the thread's display time. `last_time` remains a display string only.
(Previously ordering used `sort_ts` but it was never written, so the inbox sorted
by insertion order.)

### Outbox reliability

Send failures call `mark_outbox_failure(id, error, max_attempts)`, which:

1. increments `attempts` and stores `last_error`;
2. on a non-final failure, re-queues with exponential backoff via `next_retry_ts`
   (30s, 60s, 120s, … capped ~32 min) — `due_outbox` only returns items whose
   `next_retry_ts` has passed;
3. on the final failure, moves the row to `dead_letter` for operator visibility.

`claim_outbox` (status `queued → sending`) keeps the background flusher and a
UI-triggered flush from double-sending.

## Deliberately deferred (and why)

These are known, intentional gaps — not oversights — scoped out of this pass:

- **Connection pooling.** The store uses one `Mutex<Connection>`. WAL is enabled,
  so moving to a read-pool + single-writer (`deadpool-sqlite`) is a drop-in
  improvement; deferred because it touches every method and needs runtime
  profiling to justify.
- **At-rest encryption.** Message bodies/contacts are plaintext in SQLite;
  passwords/tokens are already in the OS keychain. SQLCipher would close this and
  matches the "your machine" positioning.
- **Folders/flags wiring.** The `folders`, `account_sync_state`, and message-flag
  columns exist and are indexed, but the sync engine still syncs inbox-only; the
  per-folder IMAP UIDVALIDITY/UIDNEXT loop (Sent / Drafts / Trash browsing) is the
  remaining sync milestone and needs a live server to validate folder names/flags.
- **Attachment normalization.** Inbound attachment metadata is stored as JSON on
  `messages` (the read model). Download fetches bytes on demand (IMAP: re-fetch by
  Message-ID + extract part). A content-addressed `attachments` table (dedup) is a
  future optimization; Gmail/Graph on-demand download still needs their per-part
  attachment ids captured during sync.

## Implemented since v2 (read/write actions)

- **Mark read/unread, archive, snooze, delete** persist in the store and are
  **local-authoritative**: `upsert_thread` no longer overwrites `unread`/`views`
  on re-sync, and a `deleted` tombstone (migration v3) stops a deleted thread from
  being resurrected by the next sync. Best-effort provider sync-back: Gmail
  (UNREAD/INBOX labels, threads.trash) and Graph (isRead PATCH, message move).
- **Attachment download (IMAP):** `download_attachment` re-fetches the message by
  Message-ID, extracts the named part's transfer-decoded bytes, saves to Downloads,
  and opens it.

## Still genuinely missing (need live accounts or larger work)

- Folder browsing beyond inbox (above).
- IMAP server-side mark-read/trash (needs the UID from folder sync; local persists,
  Gmail/Graph push works).
- At-rest DB encryption (SQLCipher); connection pool.
- POP3 / JMAP; real calendar sync; contacts/address book.
