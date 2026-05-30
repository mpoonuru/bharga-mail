//! Outbox flush: sends due queued messages. Runs both on a background timer and
//! on demand from the UI; `claim_outbox` makes it idempotent so a message is
//! never sent twice. This is what makes "Undo Send" safe — nothing leaves until
//! its scheduled time, and a cancel before then simply removes the row.

use crate::store::Store;

use super::{gmail, microsoft, smtp};

/// Send everything that's due now. Returns how many were sent.
pub async fn flush(store: &Store) -> usize {
    let now = chrono::Utc::now().timestamp();
    let due = store.due_outbox(now);
    let mut sent = 0;
    for item in due {
        // claim atomically; skip if another flusher already grabbed it
        if !store.claim_outbox(&item.id).unwrap_or(false) {
            continue;
        }
        let result = if item.account_id.starts_with("gmail:") {
            gmail::send(&item.account_id, &item.to, &item.subject, &item.body, &item.attachments).await
        } else if item.account_id.starts_with("ms:") {
            microsoft::send(&item.account_id, &item.to, &item.subject, &item.body, &item.attachments).await
        } else {
            // Plain IMAP/SMTP accounts.
            smtp::send_for(store, &item.account_id, &item.to, &item.subject, &item.body, &item.attachments).await
        };
        match result {
            Ok(()) => {
                let _ = store.mark_outbox(&item.id, "sent");
                sent += 1;
            }
            Err(e) => {
                // Up to 5 attempts with exponential backoff; then dead-lettered.
                match store.mark_outbox_failure(&item.id, &e.to_string(), 5) {
                    Ok(true) => log::error!("outbox: {} dead-lettered: {e}", item.id),
                    Ok(false) => log::warn!("outbox: {} send failed, will retry: {e}", item.id),
                    Err(db) => log::error!("outbox: failed to record failure for {}: {db}", item.id),
                }
            }
        }
    }
    sent
}
