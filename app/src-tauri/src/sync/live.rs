//! Background live-sync engine. Periodically polls every connected account's
//! inbox and emits Tauri events so the UI updates without a manual Sync:
//!   • `mail:sync` — fired after any successful poll (the UI reloads threads)
//!   • `mail:new`  — fired with `{ count }` when the unread total grew
//!
//! This is a frequent poll rather than IMAP IDLE: Gmail and Microsoft Graph have
//! no push without server-side webhooks, so a uniform poll is the portable
//! mechanism for every provider. (IMAP IDLE can layer on later for instant push.)

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::store::Store;

/// How often to poll in the background.
const POLL_INTERVAL: Duration = Duration::from_secs(60);
/// Cap messages pulled per inbox per poll (keeps each cycle quick).
const INBOX_LIMIT: u32 = 40;

#[derive(serde::Serialize, Clone)]
pub struct NewMail {
    pub count: i64,
}

/// Run the live-sync engine forever (spawned at startup):
///   • one IMAP IDLE watcher per IMAP account for instant push, and
///   • a periodic poll that covers Gmail/Graph (no server push without webhooks),
///     newly-added accounts, and acts as a safety net behind IDLE.
pub async fn run(app: AppHandle, store: Arc<Store>) {
    let mut idling: HashSet<String> = HashSet::new();
    loop {
        for acct in store.accounts() {
            // `insert` returns true the first time we see this IMAP account.
            if acct.id.starts_with("imap:") && idling.insert(acct.id.clone()) {
                let a = app.clone();
                let s = store.clone();
                let id = acct.id.clone();
                tokio::spawn(async move { run_idle(a, s, id).await });
            }
        }
        tokio::time::sleep(POLL_INTERVAL).await;
        poll_once(&app, &store).await;
    }
}

/// Per-account IMAP IDLE watcher: blocks until the server pushes a change, then
/// triggers a poll (which is itself an incremental delta). Backs off on errors
/// and gives up after repeated failures (a non-IDLE or flaky server falls back
/// to the periodic poll).
async fn run_idle(app: AppHandle, store: Arc<Store>, account_id: String) {
    let mut failures = 0u32;
    loop {
        let s = store.clone();
        let aid = account_id.clone();
        match tokio::task::spawn_blocking(move || crate::sync::imap::idle_wait_inbox(&s, &aid)).await {
            Ok(Ok(changed)) => {
                failures = 0;
                if changed {
                    poll_once(&app, &store).await;
                }
            }
            Ok(Err(e)) => {
                failures += 1;
                log::warn!("idle watcher {account_id}: {e} (failure {failures})");
                if failures >= 5 {
                    log::warn!("idle watcher {account_id}: giving up; periodic poll will cover it");
                    return;
                }
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
            Err(join) => {
                log::warn!("idle watcher {account_id} task error: {join}");
                return;
            }
        }
    }
}

/// One poll pass across all accounts. Emits `mail:sync` if anything synced and
/// `mail:new` if the unread total increased. Errors per account are swallowed
/// (logged) so one bad account never stalls the loop.
pub async fn poll_once(app: &AppHandle, store: &Arc<Store>) {
    let before = store.unread_count();
    let mut synced = false;

    for acct in store.accounts() {
        let id = acct.id;
        let result = if id.starts_with("ms:") {
            crate::sync::microsoft::incremental(store, &id).await.map(|_| 0usize)
        } else if id.starts_with("imap:") {
            crate::sync::imap::fetch_folder_async(store.clone(), id.clone(), "INBOX".into(), INBOX_LIMIT, true).await
        } else {
            crate::sync::gmail::incremental(store, &id).await.map(|_| 0usize)
        };
        match result {
            Ok(_) => synced = true,
            Err(e) => log::warn!("live-sync: {id} poll failed: {e}"),
        }
    }

    if synced {
        let _ = app.emit("mail:sync", ());
    }
    let after = store.unread_count();
    if after > before {
        let count = after - before;
        log::info!("live-sync: {count} new message(s)");
        let _ = app.emit("mail:new", NewMail { count });
    }
}
