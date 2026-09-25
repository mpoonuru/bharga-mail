//! Microsoft Graph calendar connector with opaque delta links and isolated OAuth.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{Duration, NaiveDateTime, SecondsFormat, Utc};
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

const GRAPH_API: &str = "https://graph.microsoft.com/v1.0/";
const MAX_PAGES: usize = 100;

fn error(kind: ConnectorErrorKind, code: &str, message: impl Into<String>) -> ConnectorError {
    ConnectorError::new(kind, code, message)
}

fn status_error(status: StatusCode) -> ConnectorError {
    match status.as_u16() {
        401 => error(
            ConnectorErrorKind::AuthRequired,
            "auth-required",
            "Microsoft Calendar authorization is no longer valid",
        ),
        403 => error(
            ConnectorErrorKind::PermissionDenied,
            "permission-denied",
            "Microsoft Calendar access was denied",
        ),
        409 | 412 => error(
            ConnectorErrorKind::Conflict,
            "precondition-failed",
            "Microsoft Calendar event changed remotely",
        ),
        429 => error(
            ConnectorErrorKind::RateLimited,
            "rate-limited",
            "Microsoft Graph is rate limiting requests",
        ),
        500..=599 => error(
            ConnectorErrorKind::Transient,
            "server-error",
            "Microsoft Graph is temporarily unavailable",
        ),
        _ => error(
            ConnectorErrorKind::Permanent,
            "graph-error",
            format!("Microsoft Graph request failed ({status})"),
        ),
    }
}

pub fn oauth_config() -> OAuthConfig {
    OAuthConfig {
        auth_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize".into(),
        token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token".into(),
        client_id: std::env::var("BHARGA_MS_CALENDAR_CLIENT_ID")
            .or_else(|_| std::env::var("BHARGA_MS_CLIENT_ID"))
            .unwrap_or_default(),
        scopes: vec![
            "offline_access".into(),
            "User.Read".into(),
            "Calendars.ReadWrite".into(),
        ],
        purpose: OAuthPurpose::Calendar,
        extra_auth_params: Vec::new(),
    }
}

pub async fn authorize() -> Result<TokenSet, ConnectorError> {
    let config = oauth_config();
    if config.client_id.is_empty() {
        return Err(error(
            ConnectorErrorKind::Permanent,
            "client-id-missing",
            "Microsoft Calendar OAuth client ID is not configured",
        ));
    }
    oauth::run_pkce_flow(&config).await.map_err(|_| {
        error(
            ConnectorErrorKind::AuthRequired,
            "authorization-failed",
            "Microsoft Calendar authorization did not complete",
        )
    })
}

pub async fn account_email(access_token: &str) -> Result<String, ConnectorError> {
    let response = Client::new()
        .get("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| {
            error(
                ConnectorErrorKind::Transient,
                "network-error",
                "Microsoft identity could not be loaded",
            )
        })?;
    if !response.status().is_success() {
        return Err(status_error(response.status()));
    }
    let value: Value = response.json().await.map_err(|_| {
        error(
            ConnectorErrorKind::Permanent,
            "invalid-response",
            "Microsoft identity response was invalid",
        )
    })?;
    value["mail"]
        .as_str()
        .or_else(|| value["userPrincipalName"].as_str())
        .map(str::to_string)
        .ok_or_else(|| {
            error(
                ConnectorErrorKind::Permanent,
                "identity-missing",
                "Microsoft account email was not returned",
            )
        })
}

#[derive(Clone)]
pub struct MicrosoftConnector {
    api_url: Url,
    access_token: String,
    calendar_id: Option<String>,
    store: Option<Arc<Store>>,
    send_updates: bool,
    client: Client,
}

impl MicrosoftConnector {
    pub fn new(api_url: &str, access_token: impl Into<String>) -> Result<Self, ConnectorError> {
        Ok(Self {
            api_url: Url::parse(api_url).map_err(|_| {
                error(
                    ConnectorErrorKind::Permanent,
                    "invalid-url",
                    "Microsoft Graph URL is invalid",
                )
            })?,
            access_token: access_token.into(),
            calendar_id: None,
            store: None,
            send_updates: false,
            client: Client::new(),
        })
    }
    pub fn production(access_token: impl Into<String>) -> Result<Self, ConnectorError> {
        Self::new(GRAPH_API, access_token)
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
    pub fn send_updates(mut self, value: bool) -> Self {
        self.send_updates = value;
        self
    }
    fn endpoint(&self, path: &str) -> Result<Url, ConnectorError> {
        self.api_url.join(path).map_err(|_| {
            error(
                ConnectorErrorKind::Permanent,
                "invalid-url",
                "Microsoft Graph endpoint is invalid",
            )
        })
    }
    fn opaque_link(&self, value: &str) -> Result<Url, ConnectorError> {
        Url::parse(value)
            .or_else(|_| self.api_url.join(value))
            .map_err(|_| {
                error(
                    ConnectorErrorKind::Permanent,
                    "invalid-delta-link",
                    "Microsoft Graph returned an invalid delta link",
                )
            })
    }
    async fn request(
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
            error(
                ConnectorErrorKind::Transient,
                "network-error",
                "Microsoft Graph could not be reached",
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
            error(
                ConnectorErrorKind::Permanent,
                "invalid-response",
                "Microsoft Graph returned invalid JSON",
            )
        })?;
        Ok((status, value, headers))
    }
}

fn iana_timezone(value: Option<&str>) -> String {
    match value.unwrap_or("UTC") {
        "W. Europe Standard Time" => "Europe/Berlin".into(),
        "Pacific Standard Time" => "America/Los_Angeles".into(),
        "Eastern Standard Time" => "America/New_York".into(),
        value if value.contains('/') => value.into(),
        _ => "UTC".into(),
    }
}

fn graph_moment(value: &Value, all_day: bool) -> Result<EventMoment, ConnectorError> {
    let raw = value["dateTime"].as_str().ok_or_else(|| {
        error(
            ConnectorErrorKind::Permanent,
            "invalid-event",
            "Microsoft event time is missing",
        )
    })?;
    if all_day {
        return Ok(EventMoment::AllDay {
            date: raw.get(..10).unwrap_or(raw).into(),
        });
    }
    let utc = if let Ok(value) = chrono::DateTime::parse_from_rfc3339(raw) {
        value.with_timezone(&Utc)
    } else {
        NaiveDateTime::parse_from_str(raw.trim_end_matches('Z'), "%Y-%m-%dT%H:%M:%S%.f")
            .map(|value| value.and_utc())
            .map_err(|_| {
                error(
                    ConnectorErrorKind::Permanent,
                    "invalid-event",
                    "Microsoft event time is invalid",
                )
            })?
    };
    Ok(EventMoment::Timed {
        utc: utc.to_rfc3339_opts(SecondsFormat::Secs, true),
    })
}

fn graph_event(value: &Value, calendar_id: &str) -> Result<CalendarEvent, ConnectorError> {
    let id = value["id"].as_str().ok_or_else(|| {
        error(
            ConnectorErrorKind::Permanent,
            "invalid-event",
            "Microsoft event has no id",
        )
    })?;
    let all_day = value["isAllDay"].as_bool().unwrap_or(false);
    let attendees = value["attendees"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|attendee| {
                    Some(EventAttendee {
                        name: attendee["emailAddress"]["name"]
                            .as_str()
                            .map(str::to_string),
                        email: attendee["emailAddress"]["address"].as_str()?.into(),
                        role: if attendee["type"].as_str() == Some("optional") {
                            AttendeeRole::Optional
                        } else {
                            AttendeeRole::Required
                        },
                        status: match attendee["status"]["response"].as_str() {
                            Some("accepted") => ParticipationStatus::Accepted,
                            Some("declined") => ParticipationStatus::Declined,
                            Some("tentativelyAccepted") => ParticipationStatus::Tentative,
                            _ => ParticipationStatus::NeedsAction,
                        },
                        rsvp: true,
                        comment: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let recurrence = value["recurrence"].as_object().map(|_| {
        let frequency = match value["recurrence"]["pattern"]["type"]
            .as_str()
            .unwrap_or("daily")
        {
            "weekly" => "WEEKLY",
            "absoluteMonthly" | "relativeMonthly" => "MONTHLY",
            "absoluteYearly" | "relativeYearly" => "YEARLY",
            _ => "DAILY",
        };
        let mut rule = format!(
            "FREQ={frequency};INTERVAL={}",
            value["recurrence"]["pattern"]["interval"]
                .as_i64()
                .unwrap_or(1)
        );
        if let Some(count) = value["recurrence"]["range"]["numberOfOccurrences"].as_i64() {
            rule.push_str(&format!(";COUNT={count}"));
        }
        RecurrenceSet {
            rules: vec![rule],
            dates: Vec::new(),
            excluded_dates: Vec::new(),
        }
    });
    Ok(CalendarEvent {
        id: format!("microsoft:{id}"),
        calendar_id: calendar_id.into(),
        uid: value["iCalUId"].as_str().unwrap_or(id).into(),
        provider_id: Some(id.into()),
        title: value["subject"].as_str().unwrap_or("(untitled)").into(),
        description: value["body"]["content"].as_str().unwrap_or("").into(),
        location: value["location"]["displayName"]
            .as_str()
            .unwrap_or("")
            .into(),
        conference_url: value["onlineMeeting"]["joinUrl"]
            .as_str()
            .map(str::to_string),
        source_thread_id: None,
        start: graph_moment(&value["start"], all_day)?,
        end: graph_moment(&value["end"], all_day)?,
        timezone: iana_timezone(
            value["originalStartTimeZone"]
                .as_str()
                .or_else(|| value["start"]["timeZone"].as_str()),
        ),
        recurrence,
        recurrence_id: value["originalStart"].as_str().map(str::to_string),
        parent_event_id: value["seriesMasterId"]
            .as_str()
            .map(|id| format!("microsoft:{id}")),
        status: if value["isCancelled"].as_bool() == Some(true) {
            EventStatus::Cancelled
        } else {
            EventStatus::Confirmed
        },
        transparency: if value["showAs"].as_str() == Some("free") {
            Transparency::Free
        } else {
            Transparency::Busy
        },
        visibility: match value["sensitivity"].as_str() {
            Some("private") => EventVisibility::Private,
            Some("confidential") => EventVisibility::Confidential,
            _ => EventVisibility::Default,
        },
        organizer: value["organizer"]["emailAddress"]["address"]
            .as_str()
            .map(|email| EventPerson {
                name: value["organizer"]["emailAddress"]["name"]
                    .as_str()
                    .map(str::to_string),
                email: email.into(),
            }),
        attendees,
        reminders: value["reminderMinutesBeforeStart"]
            .as_i64()
            .map(|minutes_before| {
                vec![EventReminder {
                    id: None,
                    method: ReminderMethod::Display,
                    minutes_before,
                }]
            })
            .unwrap_or_default(),
        sequence: 0,
        provider_version: value["@odata.etag"].as_str().map(str::to_string),
        revision: 1,
        sync_state: EventSyncState::Synced,
        deleted: false,
    })
}

fn graph_json(
    event: &CalendarEvent,
    transaction_id: Option<&str>,
    include_attendees: bool,
) -> Value {
    let moment = |moment: &EventMoment, timezone: &str| match moment {
        EventMoment::Timed { utc } => json!({ "dateTime": utc, "timeZone": timezone }),
        EventMoment::AllDay { date } => {
            json!({ "dateTime": format!("{date}T00:00:00"), "timeZone": timezone })
        }
    };
    let mut value = json!({
        "subject": event.title, "body": { "contentType": "html", "content": event.description }, "location": { "displayName": event.location },
        "start": moment(&event.start, &event.timezone), "end": moment(&event.end, &event.timezone), "isAllDay": matches!(event.start, EventMoment::AllDay { .. }),
        "showAs": if event.transparency == Transparency::Free { "free" } else { "busy" },
        "sensitivity": match event.visibility { EventVisibility::Private => "private", EventVisibility::Confidential => "confidential", _ => "normal" },
        "isReminderOn": !event.reminders.is_empty(), "reminderMinutesBeforeStart": event.reminders.first().map(|reminder| reminder.minutes_before),
        "transactionId": transaction_id,
    });
    if include_attendees {
        value["attendees"] = Value::Array(event.attendees.iter().map(|attendee| json!({ "emailAddress": { "address": attendee.email, "name": attendee.name }, "type": if attendee.role == AttendeeRole::Optional { "optional" } else { "required" } })).collect());
    }
    value
}

#[async_trait]
impl CalendarConnector for MicrosoftConnector {
    async fn discover(&self) -> Result<Vec<RemoteCalendar>, ConnectorError> {
        let mut url = self.endpoint("me/calendars?$top=100")?;
        let mut calendars = Vec::new();
        for _ in 0..MAX_PAGES {
            let (_, value, _) = self.request(Method::GET, url, None, None).await?;
            if let Some(items) = value["value"].as_array() {
                calendars.extend(items.iter().filter_map(|item| {
                    Some(RemoteCalendar {
                        id: item["id"].as_str()?.into(),
                        href: item["id"].as_str()?.into(),
                        name: item["name"].as_str().unwrap_or("Calendar").into(),
                        description: String::new(),
                        color: item["hexColor"].as_str().unwrap_or("#6f8df6").into(),
                        timezone: "UTC".into(),
                        writable: item["canEdit"].as_bool().unwrap_or(true),
                        supports_sync_collection: true,
                        supports_scheduling: true,
                        ctag: None,
                        sync_token: None,
                    })
                }));
            }
            let Some(next) = value["@odata.nextLink"].as_str() else {
                return Ok(calendars);
            };
            url = self.opaque_link(next)?;
        }
        Err(error(
            ConnectorErrorKind::Permanent,
            "too-many-pages",
            "Microsoft Graph returned too many pages",
        ))
    }

    async fn pull(&self, cursor: Option<&str>) -> Result<SyncBatch, ConnectorError> {
        let calendar_id = self.calendar_id.as_deref().ok_or_else(|| {
            error(
                ConnectorErrorKind::Permanent,
                "calendar-not-selected",
                "No Microsoft calendar is selected",
            )
        })?;
        let mut active_cursor = cursor.map(str::to_string);
        let mut restarted = false;
        loop {
            let mut url = if let Some(cursor) = &active_cursor {
                self.opaque_link(cursor)?
            } else {
                let start =
                    (Utc::now() - Duration::days(365)).to_rfc3339_opts(SecondsFormat::Secs, true);
                let end =
                    (Utc::now() + Duration::days(730)).to_rfc3339_opts(SecondsFormat::Secs, true);
                let mut url = self.endpoint(&format!(
                    "me/calendars/{}/calendarView/delta",
                    urlencoding::encode(calendar_id)
                ))?;
                url.query_pairs_mut()
                    .append_pair("startDateTime", &start)
                    .append_pair("endDateTime", &end);
                url
            };
            let mut changes = Vec::new();
            for _ in 0..MAX_PAGES {
                let (status, value, _) = self.request(Method::GET, url, None, None).await?;
                if status == StatusCode::GONE && active_cursor.is_some() && !restarted {
                    active_cursor = None;
                    restarted = true;
                    break;
                }
                if status == StatusCode::GONE {
                    return Err(error(
                        ConnectorErrorKind::Permanent,
                        "delta-expired",
                        "Microsoft Calendar delta scope could not be renewed",
                    ));
                }
                if let Some(items) = value["value"].as_array() {
                    for item in items {
                        if item.get("@removed").is_some() {
                            if let Some(id) = item["id"].as_str() {
                                changes.push(RemoteChange::Delete { href: id.into() });
                            }
                        } else {
                            let event = graph_event(item, calendar_id)?;
                            changes.push(RemoteChange::Upsert {
                                href: event.provider_id.clone().unwrap_or_default(),
                                etag: event.provider_version.clone(),
                                event,
                            });
                        }
                    }
                }
                if let Some(next) = value["@odata.nextLink"].as_str() {
                    url = self.opaque_link(next)?;
                    continue;
                }
                let terminal = value["@odata.deltaLink"]
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| {
                        error(
                            ConnectorErrorKind::Permanent,
                            "delta-link-missing",
                            "Microsoft Graph did not return a terminal delta link",
                        )
                    })?;
                return Ok(SyncBatch {
                    changes,
                    next_cursor: Some(terminal),
                    ctag: None,
                });
            }
            if active_cursor.is_none() && restarted {
                continue;
            }
            return Err(error(
                ConnectorErrorKind::Permanent,
                "too-many-pages",
                "Microsoft Graph returned too many pages",
            ));
        }
    }

    async fn push(&self, operation: &CalendarOperation) -> Result<PushOutcome, ConnectorError> {
        let calendar_id = self.calendar_id.as_deref().ok_or_else(|| {
            error(
                ConnectorErrorKind::Permanent,
                "calendar-not-selected",
                "No Microsoft calendar is selected",
            )
        })?;
        let store = self.store.as_ref().ok_or_else(|| {
            error(
                ConnectorErrorKind::Permanent,
                "store-unavailable",
                "Calendar store is unavailable",
            )
        })?;
        let event = store
            .calendar_event(&operation.event_id)
            .map_err(|_| {
                error(
                    ConnectorErrorKind::Transient,
                    "storage-error",
                    "Calendar event could not be loaded",
                )
            })?
            .ok_or_else(|| {
                error(
                    ConnectorErrorKind::Permanent,
                    "event-not-found",
                    "Calendar event was not found",
                )
            })?;
        let base = format!("me/calendars/{}/events", urlencoding::encode(calendar_id));
        let (method, path, body) = match operation.kind {
            OperationKind::Create => (
                Method::POST,
                base,
                Some(graph_json(&event, Some(&operation.id), self.send_updates)),
            ),
            OperationKind::Update => (
                Method::PATCH,
                format!(
                    "{base}/{}",
                    urlencoding::encode(event.provider_id.as_deref().unwrap_or(&event.uid))
                ),
                Some(graph_json(&event, None, self.send_updates)),
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
                return Err(error(
                    ConnectorErrorKind::Permanent,
                    "unsupported-operation",
                    "Invitation delivery uses explicit event writes",
                ))
            }
        };
        let (_, value, headers) = self
            .request(
                method,
                self.endpoint(&path)?,
                body.as_ref(),
                operation.expected_provider_version.as_deref(),
            )
            .await?;
        Ok(PushOutcome {
            href: value["id"]
                .as_str()
                .map(str::to_string)
                .or_else(|| event.provider_id.clone()),
            provider_version: value["@odata.etag"]
                .as_str()
                .map(str::to_string)
                .or_else(|| {
                    headers
                        .get(header::ETAG)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_string)
                }),
        })
    }

    async fn free_busy(&self, request: &FreeBusyRequest) -> Result<FreeBusyResult, ConnectorError> {
        let body = json!({ "schedules": request.attendees, "startTime": { "dateTime": request.range.start, "timeZone": "UTC" }, "endTime": { "dateTime": request.range.end, "timeZone": "UTC" }, "availabilityViewInterval": 30 });
        let (_, value, _) = self
            .request(
                Method::POST,
                self.endpoint("me/calendar/getSchedule")?,
                Some(&body),
                None,
            )
            .await?;
        let mut intervals = Vec::new();
        let mut complete = true;
        if let Some(items) = value["value"].as_array() {
            for item in items {
                if item["error"].is_object() {
                    complete = false;
                }
                if let Some(schedule) = item["scheduleItems"].as_array() {
                    intervals.extend(schedule.iter().filter_map(|slot| {
                        Some(BusyInterval {
                            start: slot["start"]["dateTime"].as_str()?.into(),
                            end: slot["end"]["dateTime"].as_str()?.into(),
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
    async fn follows_next_links_and_commits_only_terminal_delta_link() {
        let server = ScriptedServer::new(vec![
            response(200, r#"{"value":[],"@odata.nextLink":"/page-2"}"#),
            response(
                200,
                r#"{"value":[{"id":"deleted","@removed":{"reason":"deleted"}}],"@odata.deltaLink":"/terminal-delta"}"#,
            ),
        ]);
        let connector = MicrosoftConnector::new(server.url(), "calendar-token")
            .unwrap()
            .for_calendar("primary", None);
        let batch = connector.pull(None).await.unwrap();
        assert_eq!(batch.next_cursor.as_deref(), Some("/terminal-delta"));
        assert!(batch
            .changes
            .iter()
            .any(|change| matches!(change, RemoteChange::Delete { .. })));
        assert_eq!(server.paths().len(), 2);
    }

    #[tokio::test]
    async fn revoked_calendar_grant_is_an_isolated_auth_error() {
        let server = ScriptedServer::new(vec![response(401, "{}")]);
        let connector = MicrosoftConnector::new(server.url(), "revoked-calendar-token").unwrap();
        let error = connector.discover().await.unwrap_err();
        assert_eq!(error.kind, ConnectorErrorKind::AuthRequired);
        assert_eq!(oauth_config().purpose, OAuthPurpose::Calendar);
        assert!(oauth_config()
            .scopes
            .iter()
            .all(|scope| !scope.starts_with("Mail.")));
    }
}
