//! Sync engine. Per-account state machine reconciling the local store with a
//! remote provider. Preference order: Gmail API → Microsoft Graph → JMAP → IMAP.
//!
//! Phase 1: implement one provider end-to-end (Gmail API), then add the rest
//! behind the `Provider` trait. Incremental sync via each provider's change
//! token; optimistic local writes with server-wins + undo on conflict.

use async_trait::async_trait;

pub mod gmail;
pub mod imap;
pub mod live;
pub mod microsoft;
pub mod mime;
pub mod oauth;
pub mod outbox;
pub mod smtp;
pub mod tokens;

#[derive(Debug, Clone, Copy)]
pub enum ProviderProtocol {
    GmailApi,
    MicrosoftGraph,
    Jmap,
    Imap,
}

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("auth required")]
    AuthRequired,
    #[error("transient: {0}")]
    Transient(String),
}

/// Each mail backend implements this. The engine drives it on a schedule and on push.
#[async_trait]
pub trait MailProvider: Send + Sync {
    fn protocol(&self) -> ProviderProtocol;

    /// Full backfill on first connect.
    async fn initial_sync(&self) -> Result<(), SyncError>;

    /// Incremental sync from the stored change token (historyId / deltaLink / JMAP state).
    async fn incremental(&self, since_token: &str) -> Result<String, SyncError>;

    /// Queue a send (outbox pattern → survives restart/offline; powers Undo Send).
    async fn enqueue_send(&self, thread_id: &str, body: &str) -> Result<(), SyncError>;
}

/// Drives all accounts. Backoff + circuit breaker per provider (Phase 1).
pub struct SyncEngine;

impl SyncEngine {
    pub fn new() -> Self {
        SyncEngine
    }
    pub async fn run(&self) {
        // spawn per-account loops; respect mobile background limits on iPad.
    }
}

impl Default for SyncEngine {
    fn default() -> Self {
        Self::new()
    }
}
