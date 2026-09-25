//! Provider-neutral synchronization contract for remote calendar services.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::domain::{CalendarEvent, CalendarOperation, EventRange};

pub mod caldav;

#[cfg(test)]
pub mod test_server;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConnectorErrorKind {
    AuthRequired,
    PermissionDenied,
    Conflict,
    RateLimited,
    Transient,
    Permanent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorError {
    pub kind: ConnectorErrorKind,
    pub code: String,
    pub message: String,
    pub retry_after_seconds: Option<u64>,
}

impl ConnectorError {
    pub fn new(
        kind: ConnectorErrorKind,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            code: code.into(),
            message: message.into(),
            retry_after_seconds: None,
        }
    }

    pub fn code(&self) -> &str {
        &self.code
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCalendar {
    pub id: String,
    pub href: String,
    pub name: String,
    pub description: String,
    pub color: String,
    pub timezone: String,
    pub writable: bool,
    pub supports_sync_collection: bool,
    pub supports_scheduling: bool,
    pub ctag: Option<String>,
    pub sync_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RemoteChange {
    Upsert {
        href: String,
        etag: Option<String>,
        event: CalendarEvent,
    },
    Delete {
        href: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncBatch {
    pub changes: Vec<RemoteChange>,
    pub next_cursor: Option<String>,
    pub ctag: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PushOutcome {
    pub href: Option<String>,
    pub provider_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FreeBusyRequest {
    pub range: EventRange,
    pub attendees: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BusyInterval {
    pub start: String,
    pub end: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FreeBusyResult {
    pub intervals: Vec<BusyInterval>,
    pub complete: bool,
}

#[async_trait]
pub trait CalendarConnector: Send + Sync {
    async fn discover(&self) -> Result<Vec<RemoteCalendar>, ConnectorError>;
    async fn pull(&self, cursor: Option<&str>) -> Result<SyncBatch, ConnectorError>;
    async fn push(&self, operation: &CalendarOperation) -> Result<PushOutcome, ConnectorError>;
    async fn free_busy(&self, request: &FreeBusyRequest) -> Result<FreeBusyResult, ConnectorError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::domain::OperationKind;

    struct FakeConnector;

    #[async_trait]
    impl CalendarConnector for FakeConnector {
        async fn discover(&self) -> Result<Vec<RemoteCalendar>, ConnectorError> {
            Ok(Vec::new())
        }
        async fn pull(&self, cursor: Option<&str>) -> Result<SyncBatch, ConnectorError> {
            Ok(SyncBatch {
                changes: vec![RemoteChange::Delete {
                    href: "/calendar/deleted.ics".into(),
                }],
                next_cursor: cursor.map(str::to_string),
                ctag: None,
            })
        }
        async fn push(&self, operation: &CalendarOperation) -> Result<PushOutcome, ConnectorError> {
            if operation.expected_provider_version.as_deref() == Some("stale") {
                return Err(ConnectorError::new(
                    ConnectorErrorKind::Conflict,
                    "precondition-failed",
                    "Remote event changed",
                ));
            }
            Ok(PushOutcome {
                href: None,
                provider_version: None,
            })
        }
        async fn free_busy(
            &self,
            _request: &FreeBusyRequest,
        ) -> Result<FreeBusyResult, ConnectorError> {
            Err(ConnectorError::new(
                ConnectorErrorKind::AuthRequired,
                "auth-required",
                "Reconnect",
            ))
        }
    }

    #[tokio::test]
    async fn connector_contract_preserves_cursor_tombstones_and_error_categories() {
        let connector = FakeConnector;
        let batch = connector.pull(Some("stable-cursor")).await.unwrap();
        assert_eq!(batch.next_cursor.as_deref(), Some("stable-cursor"));
        assert!(matches!(batch.changes[0], RemoteChange::Delete { .. }));
        let conflict = connector
            .push(&CalendarOperation {
                id: "op".into(),
                source_id: "source".into(),
                calendar_id: "calendar".into(),
                event_id: "event".into(),
                kind: OperationKind::Update,
                revision: 2,
                expected_provider_version: Some("stale".into()),
                attempts: 0,
                next_retry_at: 0,
                last_error: None,
            })
            .await
            .unwrap_err();
        assert_eq!(conflict.kind, ConnectorErrorKind::Conflict);
        let auth = connector
            .free_busy(&FreeBusyRequest {
                range: EventRange {
                    start: "2026-01-01T00:00:00Z".into(),
                    end: "2026-01-02T00:00:00Z".into(),
                },
                attendees: Vec::new(),
            })
            .await
            .unwrap_err();
        assert_eq!(auth.kind, ConnectorErrorKind::AuthRequired);
    }
}
