//! Serialized calendar synchronization with durable retries and atomic cursors.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use chrono::Utc;
use tokio::sync::{Mutex as AsyncMutex, Notify};

use super::connectors::caldav::{CalDavConnector, Credentials};
use super::connectors::google::GoogleConnector;
use super::connectors::microsoft::MicrosoftConnector;
use super::connectors::{CalendarConnector, ConnectorError, ConnectorErrorKind};
use super::domain::{CalendarProvider, CalendarSource, CalendarSyncHealth};
use super::store::CalendarSyncTarget;
use crate::store::Store;

#[derive(Default)]
struct GateState {
    running: bool,
    generation: u64,
    result: Option<Result<CalendarSyncHealth, ConnectorError>>,
}

#[derive(Default)]
struct SourceGate {
    state: AsyncMutex<GateState>,
    notify: Notify,
}

#[derive(Clone)]
pub struct CalendarSyncCoordinator {
    store: Arc<Store>,
    gates: Arc<Mutex<HashMap<String, Arc<SourceGate>>>>,
}

impl CalendarSyncCoordinator {
    pub fn new(store: Arc<Store>) -> Self {
        Self {
            store,
            gates: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn gate(&self, source_id: &str) -> Arc<SourceGate> {
        self.gates
            .lock()
            .expect("calendar sync gate lock poisoned")
            .entry(source_id.to_string())
            .or_default()
            .clone()
    }

    async fn serialized<F, Fut>(
        &self,
        source_id: &str,
        operation: F,
    ) -> Result<CalendarSyncHealth, ConnectorError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<CalendarSyncHealth, ConnectorError>>,
    {
        let gate = self.gate(source_id);
        let generation = {
            let mut state = gate.state.lock().await;
            if state.running {
                Some(state.generation)
            } else {
                state.running = true;
                None
            }
        };
        if let Some(generation) = generation {
            loop {
                gate.notify.notified().await;
                let state = gate.state.lock().await;
                if state.generation != generation {
                    return state.result.clone().unwrap_or_else(|| {
                        Err(error(
                            ConnectorErrorKind::Transient,
                            "sync-result-missing",
                            "Calendar synchronization result was unavailable",
                        ))
                    });
                }
            }
        }

        let result = operation().await;
        {
            let mut state = gate.state.lock().await;
            state.running = false;
            state.generation = state.generation.wrapping_add(1);
            state.result = Some(result.clone());
        }
        gate.notify.notify_waiters();
        result
    }

    pub async fn sync_source(&self, source_id: &str) -> Result<CalendarSyncHealth, ConnectorError> {
        let source_id = source_id.to_string();
        self.serialized(&source_id.clone(), || async move {
            self.sync_source_inner(&source_id).await
        })
        .await
    }

    async fn sync_source_inner(
        &self,
        source_id: &str,
    ) -> Result<CalendarSyncHealth, ConnectorError> {
        let source = self
            .store
            .calendar_sources()
            .map_err(storage_error)?
            .into_iter()
            .find(|candidate| candidate.id == source_id)
            .ok_or_else(|| {
                error(
                    ConnectorErrorKind::Permanent,
                    "source-not-found",
                    "Calendar source was not found",
                )
            })?;
        if source.disabled || source.provider == CalendarProvider::Local {
            return self
                .store
                .calendar_sync_health(source_id)
                .map_err(storage_error);
        }
        let targets = self
            .store
            .calendar_sync_targets(source_id)
            .map_err(storage_error)?;
        if targets.is_empty() {
            return Err(error(
                ConnectorErrorKind::Permanent,
                "calendar-not-found",
                "Calendar source has no selected calendars",
            ));
        }

        for target in targets {
            let connector = self.connector(&source, &target)?;
            if let Err(failure) = self.flush(&source, &target, connector.as_ref()).await {
                if failure.kind != ConnectorErrorKind::Conflict {
                    self.record_failure(source_id, &failure, None)?;
                    return Err(failure);
                }
            }
            match connector.pull(target.cursor.as_deref()).await {
                Ok(batch) => self
                    .store
                    .commit_calendar_sync_batch(&target.calendar.id, &batch)
                    .map_err(storage_error)?,
                Err(failure) => {
                    self.record_failure(source_id, &failure, None)?;
                    return Err(failure);
                }
            }
        }
        self.store
            .calendar_sync_health(source_id)
            .map_err(storage_error)
    }

    fn connector(
        &self,
        source: &CalendarSource,
        target: &CalendarSyncTarget,
    ) -> Result<Box<dyn CalendarConnector>, ConnectorError> {
        let remote_id = target.calendar.provider_id.as_deref().ok_or_else(|| {
            error(
                ConnectorErrorKind::Permanent,
                "remote-calendar-missing",
                "Remote calendar identifier is missing",
            )
        })?;
        match source.provider {
            CalendarProvider::CalDav => {
                let username = crate::sync::tokens::calendar_secret(&source.id, "username")
                    .ok_or_else(auth_error)?;
                let password = crate::sync::tokens::calendar_secret(&source.id, "password")
                    .ok_or_else(auth_error)?;
                let base = source.address.as_deref().ok_or_else(|| {
                    error(
                        ConnectorErrorKind::Permanent,
                        "source-url-missing",
                        "CalDAV source URL is missing",
                    )
                })?;
                let href = target.remote_url.as_deref().unwrap_or(remote_id);
                Ok(Box::new(
                    CalDavConnector::new(base, Credentials::Basic { username, password })?
                        .for_collection(href, self.store.clone())?,
                ))
            }
            CalendarProvider::Google => {
                let token = crate::sync::tokens::calendar_access_token(&source.id)
                    .ok_or_else(auth_error)?;
                Ok(Box::new(
                    GoogleConnector::production(token)?
                        .for_calendar(remote_id, Some(self.store.clone())),
                ))
            }
            CalendarProvider::Microsoft => {
                let token = crate::sync::tokens::calendar_access_token(&source.id)
                    .ok_or_else(auth_error)?;
                Ok(Box::new(
                    MicrosoftConnector::production(token)?
                        .for_calendar(remote_id, Some(self.store.clone())),
                ))
            }
            CalendarProvider::Local => Err(error(
                ConnectorErrorKind::Permanent,
                "local-source",
                "Local calendars do not require synchronization",
            )),
        }
    }

    async fn flush(
        &self,
        source: &CalendarSource,
        target: &CalendarSyncTarget,
        connector: &dyn CalendarConnector,
    ) -> Result<(), ConnectorError> {
        let now = Utc::now().timestamp();
        let operations = self
            .store
            .due_calendar_operations(&source.id, now)
            .map_err(storage_error)?;
        for operation in operations
            .into_iter()
            .filter(|operation| operation.calendar_id == target.calendar.id)
        {
            match connector.push(&operation).await {
                Ok(outcome) => self
                    .store
                    .complete_calendar_operation(&operation, &outcome)
                    .map_err(storage_error)?,
                Err(failure) => {
                    let retry_at = retry_at(&operation.id, operation.attempts, &failure);
                    self.store
                        .retry_calendar_operation(&operation.id, failure.code(), retry_at)
                        .map_err(storage_error)?;
                    self.record_failure(&source.id, &failure, Some(retry_at))?;
                    return Err(failure);
                }
            }
        }
        Ok(())
    }

    fn record_failure(
        &self,
        source_id: &str,
        failure: &ConnectorError,
        retry_at: Option<i64>,
    ) -> Result<(), ConnectorError> {
        self.store
            .record_calendar_sync_error(
                source_id,
                failure.code(),
                matches!(
                    failure.kind,
                    ConnectorErrorKind::AuthRequired | ConnectorErrorKind::PermissionDenied
                ),
                retry_at,
            )
            .map_err(storage_error)
    }

    #[cfg(test)]
    async fn sync_test_connector(
        &self,
        source_id: &str,
        calendar_id: &str,
        connector: Arc<dyn CalendarConnector>,
    ) -> Result<CalendarSyncHealth, ConnectorError> {
        let source_id = source_id.to_string();
        let calendar_id = calendar_id.to_string();
        self.serialized(&source_id.clone(), || async move {
            let batch = connector.pull(None).await?;
            self.store
                .commit_calendar_sync_batch(&calendar_id, &batch)
                .map_err(storage_error)?;
            self.store
                .calendar_sync_health(&source_id)
                .map_err(storage_error)
        })
        .await
    }
}

fn auth_error() -> ConnectorError {
    error(
        ConnectorErrorKind::AuthRequired,
        "credentials-unavailable",
        "Calendar authorization is unavailable; reconnect this source",
    )
}

fn storage_error(_: rusqlite::Error) -> ConnectorError {
    error(
        ConnectorErrorKind::Transient,
        "storage-error",
        "Calendar synchronization could not update local storage",
    )
}

fn error(kind: ConnectorErrorKind, code: &str, message: impl Into<String>) -> ConnectorError {
    ConnectorError::new(kind, code, message)
}

fn retry_at(operation_id: &str, attempts: i64, failure: &ConnectorError) -> i64 {
    if matches!(
        failure.kind,
        ConnectorErrorKind::Conflict
            | ConnectorErrorKind::AuthRequired
            | ConnectorErrorKind::PermissionDenied
            | ConnectorErrorKind::Permanent
    ) {
        return i64::MAX / 4;
    }
    let exponential = 5_i64.saturating_mul(2_i64.saturating_pow(attempts.clamp(0, 8) as u32));
    let jitter = operation_id
        .bytes()
        .fold(0_u64, |value, byte| value.wrapping_add(byte as u64))
        % 6;
    let provider_delay = failure.retry_after_seconds.unwrap_or(0).min(3_600) as i64;
    Utc::now().timestamp() + exponential.min(900).max(provider_delay) + jitter as i64
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;

    use super::*;
    use crate::calendar::connectors::{
        FreeBusyRequest, FreeBusyResult, PushOutcome, RemoteCalendar, RemoteChange, SyncBatch,
    };
    use crate::calendar::domain::{
        CalendarOperation, EventMoment, EventMutation, EventStatus, EventVisibility, Transparency,
    };

    struct CountingConnector {
        pulls: AtomicUsize,
    }

    #[async_trait]
    impl CalendarConnector for CountingConnector {
        async fn discover(&self) -> Result<Vec<RemoteCalendar>, ConnectorError> {
            Ok(Vec::new())
        }

        async fn pull(&self, _cursor: Option<&str>) -> Result<SyncBatch, ConnectorError> {
            self.pulls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Ok(SyncBatch {
                changes: Vec::new(),
                next_cursor: Some("cursor".into()),
                ctag: None,
            })
        }

        async fn push(
            &self,
            _operation: &CalendarOperation,
        ) -> Result<PushOutcome, ConnectorError> {
            unreachable!()
        }

        async fn free_busy(
            &self,
            _request: &FreeBusyRequest,
        ) -> Result<FreeBusyResult, ConnectorError> {
            unreachable!()
        }
    }

    fn remote_calendar() -> RemoteCalendar {
        RemoteCalendar {
            id: "remote".into(),
            href: "/remote/".into(),
            name: "Work".into(),
            description: String::new(),
            color: "#6f8df6".into(),
            timezone: "UTC".into(),
            writable: true,
            supports_sync_collection: true,
            supports_scheduling: false,
            ctag: None,
            sync_token: None,
        }
    }

    fn event_input(calendar_id: &str, title: &str) -> EventMutation {
        EventMutation {
            calendar_id: calendar_id.into(),
            title: title.into(),
            description: String::new(),
            location: String::new(),
            conference_url: None,
            source_thread_id: None,
            start: EventMoment::Timed {
                utc: "2026-09-25T10:00:00Z".into(),
            },
            end: EventMoment::Timed {
                utc: "2026-09-25T11:00:00Z".into(),
            },
            timezone: "UTC".into(),
            recurrence: None,
            status: EventStatus::Confirmed,
            transparency: Transparency::Busy,
            visibility: EventVisibility::Default,
            organizer: None,
            attendees: Vec::new(),
            reminders: Vec::new(),
        }
    }

    #[tokio::test]
    async fn concurrent_sync_requests_share_one_source_run() {
        let store = Arc::new(Store::in_memory().unwrap());
        store
            .save_remote_source_atomic(
                "s1",
                CalendarProvider::CalDav,
                "Test",
                "https://calendar.example.test",
                &[remote_calendar()],
                &[],
            )
            .unwrap();
        let calendar_id = store.calendars().unwrap()[0].id.clone();
        let coordinator = CalendarSyncCoordinator::new(store);
        let connector = Arc::new(CountingConnector {
            pulls: AtomicUsize::new(0),
        });
        let (a, b) = tokio::join!(
            coordinator.sync_test_connector("s1", &calendar_id, connector.clone()),
            coordinator.sync_test_connector("s1", &calendar_id, connector.clone()),
        );
        assert!(a.is_ok() && b.is_ok());
        assert_eq!(connector.pulls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn stale_etag_preserves_local_and_remote_snapshots() {
        let store = Store::in_memory().unwrap();
        store
            .save_remote_source_atomic(
                "s1",
                CalendarProvider::CalDav,
                "Test",
                "https://calendar.example.test",
                &[remote_calendar()],
                &[],
            )
            .unwrap();
        let calendar_id = store.calendars().unwrap()[0].id.clone();
        let local = store
            .create_calendar_event(event_input(&calendar_id, "Local"))
            .unwrap();
        let mut remote = local.clone();
        remote.title = "Remote".into();
        remote.provider_id = Some("remote-event".into());
        let batch = SyncBatch {
            changes: vec![RemoteChange::Upsert {
                href: "remote-event".into(),
                etag: Some("new".into()),
                event: remote,
            }],
            next_cursor: Some("cursor".into()),
            ctag: None,
        };
        store
            .commit_calendar_sync_batch(&calendar_id, &batch)
            .unwrap();
        let conflict = store.calendar_conflicts().unwrap().remove(0);
        assert_eq!(conflict.local.title, "Local");
        assert_eq!(conflict.remote.title, "Remote");
    }
}
