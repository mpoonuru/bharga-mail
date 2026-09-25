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

pub(crate) fn http_status_error(status: reqwest::StatusCode, operation: &str) -> SyncError {
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        SyncError::AuthRequired
    } else {
        SyncError::Transient(format!("{operation} HTTP {status}"))
    }
}

pub(crate) fn refresh_error(error: impl std::fmt::Display) -> SyncError {
    let message = error.to_string();
    if message.contains("HTTP 400")
        || message.contains("HTTP 401")
        || message.to_ascii_lowercase().contains("invalid_grant")
    {
        SyncError::AuthRequired
    } else {
        SyncError::Transient(message)
    }
}

pub(crate) fn store_write<T>(result: rusqlite::Result<T>, operation: &str) -> Result<T, SyncError> {
    result.map_err(|error| SyncError::Transient(format!("{operation}: {error}")))
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

#[cfg(test)]
mod tests {
    use super::{http_status_error, refresh_error, store_write, SyncError};

    #[test]
    fn authentication_http_statuses_are_not_reported_as_transient() {
        assert!(matches!(http_status_error(reqwest::StatusCode::UNAUTHORIZED, "sync"), SyncError::AuthRequired));
        assert!(matches!(http_status_error(reqwest::StatusCode::FORBIDDEN, "sync"), SyncError::AuthRequired));
        assert!(matches!(http_status_error(reqwest::StatusCode::BAD_GATEWAY, "sync"), SyncError::Transient(_)));
    }

    #[test]
    fn rejected_refresh_requires_reauthentication() {
        assert!(matches!(refresh_error("token exchange failed: HTTP 400 Bad Request"), SyncError::AuthRequired));
    }

    #[test]
    fn failed_local_persistence_fails_the_sync() {
        let result = store_write::<()>(Err(rusqlite::Error::InvalidQuery), "persist message");
        assert!(matches!(result, Err(SyncError::Transient(message)) if message.contains("persist message")));
    }
}
