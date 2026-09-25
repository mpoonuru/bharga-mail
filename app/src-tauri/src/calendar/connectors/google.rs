//! Google Calendar connector with paged sync tokens isolated from Gmail OAuth.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, SecondsFormat, Utc};
use reqwest::{header, Client, Method, StatusCode, Url};
use serde_json::{json, Value};

use super::{
    BusyInterval, CalendarConnector, ConnectorError, ConnectorErrorKind, FreeBusyRequest,
    FreeBusyResult, PushOutcome, RemoteCalendar, RemoteChange, SyncBatch,
};
use crate::calendar::domain::{
    AttendeeRole, CalendarEvent, CalendarOperation, EventAttendee, EventMoment, EventPerson,
    EventReminder, EventStatus, EventSyncState, EventVisibility, OperationKind,
    ParticipationStatus, RecurrenceSet, ReminderMethod, Transparency,
};
use crate::store::Store;
use crate::sync::oauth::{self, OAuthConfig, OAuthPurpose, TokenSet};

const GOOGLE_API: &str = "https://www.googleapis.com/calendar/v3";
const MAX_PAGES: usize = 100;

fn connector_error(
    kind: ConnectorErrorKind,
    code: &str,
    message: impl Into<String>,
) -> ConnectorError {
    ConnectorError::new(kind, code, message)
}

fn status_error(status: StatusCode) -> ConnectorError {
    match status.as_u16() {
        401 => connector_error(
            ConnectorErrorKind::AuthRequired,
            "auth-required",
            "Google Calendar authorization is no longer valid",
        ),
        403 => connector_error(
            ConnectorErrorKind::PermissionDenied,
            "permission-denied",
            "Google Calendar access was denied",
        ),
        409 | 412 => connector_error(
            ConnectorErrorKind::Conflict,
            "precondition-failed",
            "Google Calendar event changed remotely",
        ),
        429 => connector_error(
            ConnectorErrorKind::RateLimited,
            "rate-limited",
            "Google Calendar is rate limiting requests",
        ),
        500..=599 => connector_error(
            ConnectorErrorKind::Transient,
            "server-error",
            "Google Calendar is temporarily unavailable",
        ),
        _ => connector_error(
            ConnectorErrorKind::Permanent,
            "google-error",
            format!("Google Calendar request failed ({status})"),
        ),
    }
}

pub fn oauth_config() -> OAuthConfig {
    OAuthConfig {
        auth_url: "https://accounts.google.com/o/oauth2/v2/auth".into(),
        token_url: "https://oauth2.googleapis.com/token".into(),
        client_id: std::env::var("BHARGA_GOOGLE_CALENDAR_CLIENT_ID")
            .or_else(|_| std::env::var("BHARGA_GMAIL_CLIENT_ID"))
            .unwrap_or_default(),
        scopes: vec![
            "https://www.googleapis.com/auth/calendar.calendarlist.readonly".into(),
            "https://www.googleapis.com/auth/calendar.events".into(),
            "https://www.googleapis.com/auth/userinfo.email".into(),
            "openid".into(),
        ],
        purpose: OAuthPurpose::Calendar,
        extra_auth_params: vec![("include_granted_scopes".into(), "true".into())],
    }
}

pub async fn authorize() -> Result<TokenSet, ConnectorError> {
    let config = oauth_config();
    if config.client_id.is_empty() {
        return Err(connector_error(
            ConnectorErrorKind::Permanent,
            "client-id-missing",
            "Google Calendar OAuth client ID is not configured",
        ));
    }
    oauth::run_pkce_flow(&config).await.map_err(|_| {
        connector_error(
            ConnectorErrorKind::AuthRequired,
            "authorization-failed",
            "Google Calendar authorization did not complete",
        )
    })
}

pub async fn account_email(access_token: &str) -> Result<String, ConnectorError> {
    let response = Client::new()
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| {
            connector_error(
                ConnectorErrorKind::Transient,
                "network-error",
                "Google identity could not be loaded",
            )
        })?;
    if !response.status().is_success() {
        return Err(status_error(response.status()));
    }
    let value: Value = response.json().await.map_err(|_| {
        connector_error(
            ConnectorErrorKind::Permanent,
            "invalid-response",
            "Google identity response was invalid",
        )
    })?;
    value["email"].as_str().map(str::to_string).ok_or_else(|| {
        connector_error(
            ConnectorErrorKind::Permanent,
            "identity-missing",
            "Google account email was not returned",
        )
    })
}

#[derive(Debug, Clone, Copy)]
pub enum NotificationMode {
    None,
    All,
    ExternalOnly,
}

impl NotificationMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::All => "all",
            Self::ExternalOnly => "externalOnly",
        }
    }
}

#[derive(Clone)]
pub struct GoogleConnector {
    api_url: Url,
    access_token: String,
    calendar_id: Option<String>,
    store: Option<Arc<Store>>,
    notification_mode: NotificationMode,
    client: Client,
}

impl GoogleConnector {
    pub fn new(api_url: &str, access_token: impl Into<String>) -> Result<Self, ConnectorError> {
        let api_url = Url::parse(api_url).map_err(|_| {
            connector_error(
                ConnectorErrorKind::Permanent,
                "invalid-url",
                "Google Calendar API URL is invalid",
            )
        })?;
        Ok(Self {
            api_url,
            access_token: access_token.into(),
            calendar_id: None,
            store: None,
            notification_mode: NotificationMode::None,
            client: Client::new(),
        })
    }

    pub fn production(access_token: impl Into<String>) -> Result<Self, ConnectorError> {
        Self::new(GOOGLE_API, access_token)
    }

    pub fn for_calendar(
        mut self,
        calendar_id: impl Into<String>,
        store: Option<Arc<Store>>,
    ) -> Self {
        self.calendar_id = Some(calendar_id.into());
        self.store = store;
        self
    }

    pub fn notification_mode(mut self, mode: NotificationMode) -> Self {
        self.notification_mode = mode;
        self
    }

    async fn request_json(
        &self,
        method: Method,
        url: Url,
        body: Option<&Value>,
        etag: Option<&str>,
    ) -> Result<(StatusCode, Value, header::HeaderMap), ConnectorError> {
        let mut request = self
            .client
            .request(method, url)
            .bearer_auth(&self.access_token);
        if let Some(body) = body {
            request = request.json(body);
        }
        if let Some(etag) = etag {
            request = request.header(header::IF_MATCH, etag);
        }
        let response = request.send().await.map_err(|_| {
            connector_error(
                ConnectorErrorKind::Transient,
                "network-error",
                "Google Calendar could not be reached",
            )
        })?;
        let status = response.status();
        let headers = response.headers().clone();
        if status == StatusCode::GONE {
            return Ok((status, Value::Null, headers));
        }
        if !status.is_success() {
            return Err(status_error(status));
        }
        if status == StatusCode::NO_CONTENT {
            return Ok((status, Value::Null, headers));
        }
        let value = response.json().await.map_err(|_| {
            connector_error(
                ConnectorErrorKind::Permanent,
                "invalid-response",
                "Google Calendar returned invalid JSON",
            )
        })?;
        Ok((status, value, headers))
    }

    fn endpoint(&self, path: &str) -> Result<Url, ConnectorError> {
        self.api_url.join(path).map_err(|_| {
            connector_error(
                ConnectorErrorKind::Permanent,
                "invalid-url",
                "Google Calendar endpoint is invalid",
            )
        })
    }
}

fn participation(value: &str) -> ParticipationStatus {
    match value {
        "accepted" => ParticipationStatus::Accepted,
        "declined" => ParticipationStatus::Declined,
        "tentative" => ParticipationStatus::Tentative,
        _ => ParticipationStatus::NeedsAction,
    }
}

fn google_event(value: &Value, calendar_id: &str) -> Result<CalendarEvent, ConnectorError> {
    let id = value["id"].as_str().ok_or_else(|| {
        connector_error(
            ConnectorErrorKind::Permanent,
            "invalid-event",
            "Google event has no id",
        )
    })?;
    let start = if let Some(date) = value["start"]["date"].as_str() {
        EventMoment::AllDay { date: date.into() }
    } else {
        let date_time = value["start"]["dateTime"].as_str().ok_or_else(|| {
            connector_error(
                ConnectorErrorKind::Permanent,
                "invalid-event",
                "Google event start is missing",
            )
        })?;
        let utc = DateTime::parse_from_rfc3339(date_time)
            .map_err(|_| {
                connector_error(
                    ConnectorErrorKind::Permanent,
                    "invalid-event",
                    "Google event start is invalid",
                )
            })?
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Secs, true);
        EventMoment::Timed { utc }
    };
    let end = if let Some(date) = value["end"]["date"].as_str() {
        EventMoment::AllDay { date: date.into() }
    } else {
        let date_time = value["end"]["dateTime"].as_str().ok_or_else(|| {
            connector_error(
                ConnectorErrorKind::Permanent,
                "invalid-event",
                "Google event end is missing",
            )
        })?;
        let utc = DateTime::parse_from_rfc3339(date_time)
            .map_err(|_| {
                connector_error(
                    ConnectorErrorKind::Permanent,
                    "invalid-event",
                    "Google event end is invalid",
                )
            })?
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Secs, true);
        EventMoment::Timed { utc }
    };
    let recurrence_rules = value["recurrence"]
        .as_array()
        .map(|rules| {
            rules
                .iter()
                .filter_map(|rule| rule.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let recurrence = (!recurrence_rules.is_empty()).then_some(RecurrenceSet {
        rules: recurrence_rules,
        dates: Vec::new(),
        excluded_dates: Vec::new(),
    });
    let attendees = value["attendees"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|attendee| {
                    Some(EventAttendee {
                        name: attendee["displayName"].as_str().map(str::to_string),
                        email: attendee["email"].as_str()?.to_string(),
                        role: if attendee["optional"].as_bool() == Some(true) {
                            AttendeeRole::Optional
                        } else {
                            AttendeeRole::Required
                        },
                        status: participation(
                            attendee["responseStatus"].as_str().unwrap_or("needsAction"),
                        ),
                        rsvp: true,
                        comment: attendee["comment"].as_str().map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let reminders = value["reminders"]["overrides"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(EventReminder {
                        id: None,
                        method: if item["method"].as_str()? == "email" {
                            ReminderMethod::Email
                        } else {
                            ReminderMethod::Display
                        },
                        minutes_before: item["minutes"].as_i64()?,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(CalendarEvent {
        id: format!("google:{id}"),
        calendar_id: calendar_id.into(),
        uid: value["iCalUID"].as_str().unwrap_or(id).into(),
        provider_id: Some(id.into()),
        title: value["summary"].as_str().unwrap_or("(untitled)").into(),
        description: value["description"].as_str().unwrap_or("").into(),
        location: value["location"].as_str().unwrap_or("").into(),
        conference_url: value["hangoutLink"].as_str().map(str::to_string),
        source_thread_id: value["extendedProperties"]["private"]["bhargaThreadId"]
            .as_str()
            .map(str::to_string),
        start,
        end,
        timezone: value["start"]["timeZone"]
            .as_str()
            .or_else(|| value["end"]["timeZone"].as_str())
            .unwrap_or("UTC")
            .into(),
        recurrence,
        recurrence_id: value["originalStartTime"]["dateTime"]
            .as_str()
            .map(str::to_string)
            .or_else(|| {
                value["originalStartTime"]["date"]
                    .as_str()
                    .map(str::to_string)
            }),
        parent_event_id: value["recurringEventId"]
            .as_str()
            .map(|id| format!("google:{id}")),
        status: match value["status"].as_str() {
            Some("cancelled") => EventStatus::Cancelled,
            Some("tentative") => EventStatus::Tentative,
            _ => EventStatus::Confirmed,
        },
        transparency: if value["transparency"].as_str() == Some("transparent") {
            Transparency::Free
        } else {
            Transparency::Busy
        },
        visibility: match value["visibility"].as_str() {
            Some("public") => EventVisibility::Public,
            Some("private") => EventVisibility::Private,
            Some("confidential") => EventVisibility::Confidential,
            _ => EventVisibility::Default,
        },
        organizer: value["organizer"]["email"]
            .as_str()
            .map(|email| EventPerson {
                name: value["organizer"]["displayName"]
                    .as_str()
                    .map(str::to_string),
                email: email.into(),
            }),
        attendees,
        reminders,
        sequence: value["sequence"].as_i64().unwrap_or(0),
        provider_version: value["etag"].as_str().map(str::to_string),
        revision: 1,
        sync_state: EventSyncState::Synced,
        deleted: false,
    })
}

fn event_json(event: &CalendarEvent, client_id: Option<&str>) -> Value {
    let moment = |moment: &EventMoment, timezone: &str| match moment {
        EventMoment::Timed { utc } => json!({ "dateTime": utc, "timeZone": timezone }),
        EventMoment::AllDay { date } => json!({ "date": date }),
    };
    let recurrence = event
        .recurrence
        .as_ref()
        .map(|set| set.rules.clone())
        .unwrap_or_default();
    json!({
        "id": client_id,
        "iCalUID": event.uid,
        "summary": event.title,
        "description": event.description,
        "location": event.location,
        "start": moment(&event.start, &event.timezone),
        "end": moment(&event.end, &event.timezone),
        "recurrence": recurrence,
        "visibility": match event.visibility { EventVisibility::Public => "public", EventVisibility::Private => "private", EventVisibility::Confidential => "confidential", EventVisibility::Default => "default" },
        "transparency": if event.transparency == Transparency::Free { "transparent" } else { "opaque" },
        "attendees": event.attendees.iter().map(|attendee| json!({ "email": attendee.email, "displayName": attendee.name, "optional": attendee.role == AttendeeRole::Optional, "responseStatus": match attendee.status { ParticipationStatus::Accepted => "accepted", ParticipationStatus::Declined => "declined", ParticipationStatus::Tentative => "tentative", _ => "needsAction" } })).collect::<Vec<_>>(),
        "reminders": { "useDefault": event.reminders.is_empty(), "overrides": event.reminders.iter().map(|reminder| json!({ "method": if reminder.method == ReminderMethod::Email { "email" } else { "popup" }, "minutes": reminder.minutes_before })).collect::<Vec<_>>() },
        "extendedProperties": { "private": { "bhargaThreadId": event.source_thread_id } },
    })
}

#[async_trait]
impl CalendarConnector for GoogleConnector {
    async fn discover(&self) -> Result<Vec<RemoteCalendar>, ConnectorError> {
        let mut url = self.endpoint("users/me/calendarList?maxResults=250")?;
        let mut calendars = Vec::new();
        for _ in 0..MAX_PAGES {
            let (_, value, _) = self
                .request_json(Method::GET, url.clone(), None, None)
                .await?;
            if let Some(items) = value["items"].as_array() {
                calendars.extend(items.iter().filter_map(|item| {
                    let id = item["id"].as_str()?;
                    let role = item["accessRole"].as_str().unwrap_or("reader");
                    Some(RemoteCalendar {
                        id: id.into(),
                        href: id.into(),
                        name: item["summaryOverride"]
                            .as_str()
                            .or_else(|| item["summary"].as_str())
                            .unwrap_or("Calendar")
                            .into(),
                        description: item["description"].as_str().unwrap_or("").into(),
                        color: item["backgroundColor"].as_str().unwrap_or("#6f8df6").into(),
                        timezone: item["timeZone"].as_str().unwrap_or("UTC").into(),
                        writable: matches!(role, "owner" | "writer"),
                        supports_sync_collection: true,
                        supports_scheduling: true,
                        ctag: None,
                        sync_token: None,
                    })
                }));
            }
            let Some(token) = value["nextPageToken"].as_str() else {
                return Ok(calendars);
            };
            url.query_pairs_mut().append_pair("pageToken", token);
        }
        Err(connector_error(
            ConnectorErrorKind::Permanent,
            "too-many-pages",
            "Google Calendar returned too many pages",
        ))
    }

    async fn pull(&self, cursor: Option<&str>) -> Result<SyncBatch, ConnectorError> {
        let calendar_id = self.calendar_id.as_deref().ok_or_else(|| {
            connector_error(
                ConnectorErrorKind::Permanent,
                "calendar-not-selected",
                "No Google calendar is selected",
            )
        })?;
        let mut active_cursor = cursor.map(str::to_string);
        let mut restarted = false;
        loop {
            let mut url = self.endpoint(&format!(
                "calendars/{}/events",
                urlencoding::encode(calendar_id)
            ))?;
            {
                let mut query = url.query_pairs_mut();
                query
                    .append_pair("maxResults", "2500")
                    .append_pair("showDeleted", "true")
                    .append_pair("singleEvents", "false");
                if let Some(cursor) = &active_cursor {
                    query.append_pair("syncToken", cursor);
                }
            }
            let mut changes = Vec::new();
            for _ in 0..MAX_PAGES {
                let (status, value, _) = self
                    .request_json(Method::GET, url.clone(), None, None)
                    .await?;
                if status == StatusCode::GONE && active_cursor.is_some() && !restarted {
                    active_cursor = None;
                    restarted = true;
                    break;
                }
                if status == StatusCode::GONE {
                    return Err(connector_error(
                        ConnectorErrorKind::Permanent,
                        "sync-token-expired",
                        "Google Calendar sync token could not be renewed",
                    ));
                }
                if let Some(items) = value["items"].as_array() {
                    for item in items {
                        if item["status"].as_str() == Some("cancelled") {
                            if let Some(id) = item["id"].as_str() {
                                changes.push(RemoteChange::Delete { href: id.into() });
                            }
                        } else {
                            let event = google_event(item, calendar_id)?;
                            changes.push(RemoteChange::Upsert {
                                href: event.provider_id.clone().unwrap_or_default(),
                                etag: event.provider_version.clone(),
                                event,
                            });
                        }
                    }
                }
                if let Some(token) = value["nextPageToken"].as_str() {
                    url.query_pairs_mut().append_pair("pageToken", token);
                    continue;
                }
                return Ok(SyncBatch {
                    changes,
                    next_cursor: value["nextSyncToken"].as_str().map(str::to_string),
                    ctag: None,
                });
            }
            if active_cursor.is_none() && restarted {
                continue;
            }
            return Err(connector_error(
                ConnectorErrorKind::Permanent,
                "too-many-pages",
                "Google Calendar returned too many pages",
            ));
        }
    }

    async fn push(&self, operation: &CalendarOperation) -> Result<PushOutcome, ConnectorError> {
        let calendar_id = self.calendar_id.as_deref().ok_or_else(|| {
            connector_error(
                ConnectorErrorKind::Permanent,
                "calendar-not-selected",
                "No Google calendar is selected",
            )
        })?;
        let store = self.store.as_ref().ok_or_else(|| {
            connector_error(
                ConnectorErrorKind::Permanent,
                "store-unavailable",
                "Calendar store is unavailable",
            )
        })?;
        let event = store
            .calendar_event(&operation.event_id)
            .map_err(|_| {
                connector_error(
                    ConnectorErrorKind::Transient,
                    "storage-error",
                    "Calendar event could not be loaded",
                )
            })?
            .ok_or_else(|| {
                connector_error(
                    ConnectorErrorKind::Permanent,
                    "event-not-found",
                    "Calendar event was not found",
                )
            })?;
        let base = format!("calendars/{}/events", urlencoding::encode(calendar_id));
        let (method, path, body) = match operation.kind {
            OperationKind::Create => {
                let stable_id = operation
                    .id
                    .chars()
                    .filter(|character| character.is_ascii_hexdigit())
                    .collect::<String>()
                    .to_ascii_lowercase();
                (
                    Method::POST,
                    base,
                    Some(event_json(&event, Some(&stable_id))),
                )
            }
            OperationKind::Update => (
                Method::PUT,
                format!(
                    "{base}/{}",
                    urlencoding::encode(event.provider_id.as_deref().unwrap_or(&event.uid))
                ),
                Some(event_json(&event, None)),
            ),
            OperationKind::Delete => (
                Method::DELETE,
                format!(
                    "{base}/{}",
                    urlencoding::encode(event.provider_id.as_deref().unwrap_or(&event.uid))
                ),
                None,
            ),
            OperationKind::SendInvitation => {
                return Err(connector_error(
                    ConnectorErrorKind::Permanent,
                    "unsupported-operation",
                    "Invitation delivery uses explicit event writes",
                ))
            }
        };
        let mut url = self.endpoint(&path)?;
        url.query_pairs_mut()
            .append_pair("sendUpdates", self.notification_mode.as_str());
        let (_, value, headers) = self
            .request_json(
                method,
                url,
                body.as_ref(),
                operation.expected_provider_version.as_deref(),
            )
            .await?;
        Ok(PushOutcome {
            href: value["id"]
                .as_str()
                .map(str::to_string)
                .or_else(|| event.provider_id.clone()),
            provider_version: value["etag"].as_str().map(str::to_string).or_else(|| {
                headers
                    .get(header::ETAG)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string)
            }),
        })
    }

    async fn free_busy(&self, request: &FreeBusyRequest) -> Result<FreeBusyResult, ConnectorError> {
        let body = json!({ "timeMin": request.range.start, "timeMax": request.range.end, "items": request.attendees.iter().map(|id| json!({ "id": id })).collect::<Vec<_>>() });
        let (_, value, _) = self
            .request_json(Method::POST, self.endpoint("freeBusy")?, Some(&body), None)
            .await?;
        let mut intervals = Vec::new();
        let mut complete = true;
        if let Some(calendars) = value["calendars"].as_object() {
            for calendar in calendars.values() {
                if calendar["errors"]
                    .as_array()
                    .is_some_and(|errors| !errors.is_empty())
                {
                    complete = false;
                }
                if let Some(busy) = calendar["busy"].as_array() {
                    intervals.extend(busy.iter().filter_map(|item| {
                        Some(BusyInterval {
                            start: item["start"].as_str()?.into(),
                            end: item["end"].as_str()?.into(),
                        })
                    }));
                }
            }
        }
        Ok(FreeBusyResult {
            intervals,
            complete,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::connectors::test_server::{ResponseSpec, ScriptedServer};

    fn response(status: u16, body: &str) -> ResponseSpec {
        ResponseSpec {
            status,
            headers: vec![("Content-Type", "application/json".into())],
            body: body.into(),
        }
    }

    #[tokio::test]
    async fn follows_every_page_and_returns_only_terminal_sync_token() {
        let server = ScriptedServer::new(vec![
            response(200, r#"{"items":[],"nextPageToken":"page-2"}"#),
            response(200, r#"{"items":[],"nextSyncToken":"terminal-token"}"#),
        ]);
        let connector = GoogleConnector::new(server.url(), "calendar-token")
            .unwrap()
            .for_calendar("primary", None);
        let batch = connector.pull(Some("old-token")).await.unwrap();
        assert_eq!(batch.next_cursor.as_deref(), Some("terminal-token"));
        assert_eq!(server.paths().len(), 2);
        assert!(server.paths()[1].contains("pageToken=page-2"));
    }

    #[tokio::test]
    async fn failed_later_page_never_returns_a_partial_cursor() {
        let server = ScriptedServer::new(vec![
            response(200, r#"{"items":[],"nextPageToken":"page-2"}"#),
            response(500, r#"{}"#),
        ]);
        let connector = GoogleConnector::new(server.url(), "calendar-token")
            .unwrap()
            .for_calendar("primary", None);
        let error = connector.pull(Some("old-token")).await.unwrap_err();
        assert_eq!(error.kind, ConnectorErrorKind::Transient);
    }

    #[tokio::test]
    async fn gone_sync_token_reconciles_from_a_fresh_snapshot() {
        let server = ScriptedServer::new(vec![
            response(410, "{}"),
            response(200, r#"{"items":[],"nextSyncToken":"fresh-token"}"#),
        ]);
        let connector = GoogleConnector::new(server.url(), "calendar-token")
            .unwrap()
            .for_calendar("primary", None);
        let batch = connector.pull(Some("expired")).await.unwrap();
        assert_eq!(batch.next_cursor.as_deref(), Some("fresh-token"));
        assert!(!server.paths()[1].contains("syncToken"));
    }

    #[test]
    fn google_calendar_oauth_never_uses_mail_scopes() {
        let config = oauth_config();
        assert_eq!(config.purpose, OAuthPurpose::Calendar);
        assert!(config.scopes.iter().all(|scope| !scope.contains("gmail.")));
        assert!(config
            .scopes
            .iter()
            .any(|scope| scope.contains("calendar.events")));
    }
}
