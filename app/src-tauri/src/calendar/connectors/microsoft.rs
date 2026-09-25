//! Microsoft Graph calendar connector with opaque delta links and isolated OAuth.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{
    Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc,
    Weekday,
};
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
            .bearer_auth(&self.access_token)
            // Normalizing Graph responses to UTC avoids treating a provider-local
            // clock value as an instant. originalStartTimeZone remains available
            // for recurrence and display semantics.
            .header("Prefer", "outlook.timezone=\"UTC\"");
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

fn graph_timezone(value: &str) -> &str {
    match value {
        "Europe/Berlin" => "W. Europe Standard Time",
        "America/Los_Angeles" => "Pacific Standard Time",
        "America/New_York" => "Eastern Standard Time",
        value => value,
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
        let local =
            NaiveDateTime::parse_from_str(raw.trim_end_matches('Z'), "%Y-%m-%dT%H:%M:%S%.f")
                .map_err(|_| {
                    error(
                        ConnectorErrorKind::Permanent,
                        "invalid-event",
                        "Microsoft event time is invalid",
                    )
                })?;
        let timezone = iana_timezone(value["timeZone"].as_str());
        let timezone = timezone.parse::<chrono_tz::Tz>().map_err(|_| {
            error(
                ConnectorErrorKind::Permanent,
                "invalid-event",
                "Microsoft event timezone is invalid",
            )
        })?;
        match timezone.from_local_datetime(&local) {
            LocalResult::Single(value) => value.with_timezone(&Utc),
            LocalResult::Ambiguous(first, _) => first.with_timezone(&Utc),
            LocalResult::None => {
                return Err(error(
                    ConnectorErrorKind::Permanent,
                    "invalid-event",
                    "Microsoft event time falls in a timezone gap",
                ))
            }
        }
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
    let timezone = iana_timezone(
        value["originalStartTimeZone"]
            .as_str()
            .or_else(|| value["start"]["timeZone"].as_str()),
    );
    let recurrence = value["recurrence"]
        .as_object()
        .map(|_| -> Result<RecurrenceSet, ConnectorError> {
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
            } else if let Some(end_date) = value["recurrence"]["range"]["endDate"].as_str() {
                let until = graph_until(end_date, &timezone, all_day)?;
                rule.push_str(&format!(";UNTIL={until}"));
            }
            if let Some(days) = value["recurrence"]["pattern"]["daysOfWeek"].as_array() {
                let days = days
                    .iter()
                    .filter_map(Value::as_str)
                    .filter_map(graph_day_code)
                    .collect::<Vec<_>>();
                if !days.is_empty() {
                    rule.push_str(&format!(";BYDAY={}", days.join(",")));
                }
            }
            if let Some(day) = value["recurrence"]["pattern"]["dayOfMonth"].as_i64() {
                rule.push_str(&format!(";BYMONTHDAY={day}"));
            }
            if let Some(month) = value["recurrence"]["pattern"]["month"].as_i64() {
                rule.push_str(&format!(";BYMONTH={month}"));
            }
            if let Some(index) = value["recurrence"]["pattern"]["index"].as_str() {
                if let Some(position) = graph_index_position(index) {
                    rule.push_str(&format!(";BYSETPOS={position}"));
                }
            }
            Ok(RecurrenceSet {
                rules: vec![rule],
                dates: Vec::new(),
                excluded_dates: Vec::new(),
            })
        })
        .transpose()?;
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
        timezone,
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

fn graph_until(end_date: &str, timezone: &str, all_day: bool) -> Result<String, ConnectorError> {
    let invalid_end = || {
        error(
            ConnectorErrorKind::Permanent,
            "invalid-event",
            "Microsoft recurrence end date is invalid",
        )
    };
    let date = NaiveDate::parse_from_str(end_date, "%Y-%m-%d").map_err(|_| invalid_end())?;
    if all_day {
        return Ok(date.format("%Y%m%d").to_string());
    }
    let local = date.and_hms_opt(23, 59, 59).ok_or_else(invalid_end)?;
    let timezone = timezone
        .parse::<chrono_tz::Tz>()
        .map_err(|_| invalid_end())?;
    let instant = match timezone.from_local_datetime(&local) {
        LocalResult::Single(value) => value,
        LocalResult::Ambiguous(_, latest) => latest,
        LocalResult::None => return Err(invalid_end()),
    };
    Ok(instant
        .with_timezone(&Utc)
        .format("%Y%m%dT%H%M%SZ")
        .to_string())
}

fn graph_day_code(day: &str) -> Option<&'static str> {
    match day {
        "monday" => Some("MO"),
        "tuesday" => Some("TU"),
        "wednesday" => Some("WE"),
        "thursday" => Some("TH"),
        "friday" => Some("FR"),
        "saturday" => Some("SA"),
        "sunday" => Some("SU"),
        _ => None,
    }
}

fn rrule_day(day: &str) -> Option<&'static str> {
    match day
        .trim()
        .trim_start_matches(['+', '-'])
        .trim_start_matches(char::is_numeric)
    {
        "MO" => Some("monday"),
        "TU" => Some("tuesday"),
        "WE" => Some("wednesday"),
        "TH" => Some("thursday"),
        "FR" => Some("friday"),
        "SA" => Some("saturday"),
        "SU" => Some("sunday"),
        _ => None,
    }
}

fn graph_index_position(index: &str) -> Option<i64> {
    match index {
        "first" => Some(1),
        "second" => Some(2),
        "third" => Some(3),
        "fourth" => Some(4),
        "last" => Some(-1),
        _ => None,
    }
}

fn graph_index(position: &str) -> Option<&'static str> {
    match position {
        "1" => Some("first"),
        "2" => Some("second"),
        "3" => Some("third"),
        "4" => Some("fourth"),
        "-1" => Some("last"),
        _ => None,
    }
}

fn weekday_name(day: Weekday) -> &'static str {
    match day {
        Weekday::Mon => "monday",
        Weekday::Tue => "tuesday",
        Weekday::Wed => "wednesday",
        Weekday::Thu => "thursday",
        Weekday::Fri => "friday",
        Weekday::Sat => "saturday",
        Weekday::Sun => "sunday",
    }
}

fn event_start_date(event: &CalendarEvent) -> Result<NaiveDate, ConnectorError> {
    match &event.start {
        EventMoment::AllDay { date } => NaiveDate::parse_from_str(date, "%Y-%m-%d"),
        EventMoment::Timed { utc } => {
            chrono::DateTime::parse_from_rfc3339(utc).map(|value| value.date_naive())
        }
    }
    .map_err(|_| {
        error(
            ConnectorErrorKind::Permanent,
            "invalid-recurrence",
            "Microsoft recurrence start date is invalid",
        )
    })
}

fn recurrence_json(event: &CalendarEvent) -> Result<Option<Value>, ConnectorError> {
    let Some(recurrence) = &event.recurrence else {
        return Ok(None);
    };
    if recurrence.rules.len() != 1
        || !recurrence.dates.is_empty()
        || !recurrence.excluded_dates.is_empty()
    {
        return Err(error(
            ConnectorErrorKind::Permanent,
            "unsupported-recurrence",
            "This recurrence set cannot be represented safely by Microsoft Calendar",
        ));
    }
    let properties = recurrence.rules[0]
        .split(';')
        .filter_map(|part| part.split_once('='))
        .map(|(key, value)| (key.to_ascii_uppercase(), value.to_ascii_uppercase()))
        .collect::<std::collections::HashMap<_, _>>();
    let supported = [
        "FREQ",
        "INTERVAL",
        "COUNT",
        "UNTIL",
        "BYDAY",
        "BYSETPOS",
        "BYMONTHDAY",
        "BYMONTH",
    ];
    if properties
        .keys()
        .any(|key| !supported.contains(&key.as_str()))
        || (properties.contains_key("COUNT") && properties.contains_key("UNTIL"))
    {
        return Err(error(
            ConnectorErrorKind::Permanent,
            "unsupported-recurrence",
            "This recurrence rule contains fields Microsoft Calendar cannot preserve safely",
        ));
    }
    let start_date = event_start_date(event)?;
    let interval = properties
        .get("INTERVAL")
        .map(|value| value.parse::<u32>())
        .transpose()
        .map_err(|_| {
            error(
                ConnectorErrorKind::Permanent,
                "invalid-recurrence",
                "Microsoft recurrence interval is invalid",
            )
        })?
        .unwrap_or(1);
    let mut pattern = json!({ "interval": interval });
    match properties.get("FREQ").map(String::as_str) {
        Some("DAILY") => {
            if ["BYDAY", "BYSETPOS", "BYMONTHDAY", "BYMONTH"]
                .iter()
                .any(|key| properties.contains_key(*key))
            {
                return Err(error(
                    ConnectorErrorKind::Permanent,
                    "unsupported-recurrence",
                    "Microsoft daily recurrence cannot preserve these rule fields",
                ));
            }
            pattern["type"] = json!("daily");
        }
        Some("WEEKLY") => {
            if ["BYSETPOS", "BYMONTHDAY", "BYMONTH"]
                .iter()
                .any(|key| properties.contains_key(*key))
            {
                return Err(error(
                    ConnectorErrorKind::Permanent,
                    "unsupported-recurrence",
                    "Microsoft weekly recurrence cannot preserve these rule fields",
                ));
            }
            pattern["type"] = json!("weekly");
            let days = if let Some(value) = properties.get("BYDAY") {
                let raw = value.split(',').collect::<Vec<_>>();
                let days = raw
                    .iter()
                    .filter_map(|day| rrule_day(day))
                    .collect::<Vec<_>>();
                if days.len() != raw.len() || raw.iter().any(|day| day.len() != 2) {
                    return Err(error(
                        ConnectorErrorKind::Permanent,
                        "unsupported-recurrence",
                        "Microsoft weekly recurrence requires plain weekday values",
                    ));
                }
                days
            } else {
                vec![weekday_name(start_date.weekday())]
            };
            pattern["daysOfWeek"] = json!(days);
            pattern["firstDayOfWeek"] = json!("monday");
        }
        Some("MONTHLY") => {
            if properties.contains_key("BYMONTH")
                || (properties.contains_key("BYDAY") != properties.contains_key("BYSETPOS"))
                || (properties.contains_key("BYMONTHDAY") && properties.contains_key("BYDAY"))
            {
                return Err(error(
                    ConnectorErrorKind::Permanent,
                    "unsupported-recurrence",
                    "Microsoft monthly recurrence cannot preserve this rule combination",
                ));
            }
            if let (Some(days), Some(position)) =
                (properties.get("BYDAY"), properties.get("BYSETPOS"))
            {
                let index = graph_index(position).ok_or_else(|| {
                    error(
                        ConnectorErrorKind::Permanent,
                        "unsupported-recurrence",
                        "Microsoft Calendar supports only first through fourth or last relative recurrences",
                    )
                })?;
                let days = days.split(',').filter_map(rrule_day).collect::<Vec<_>>();
                if days.is_empty() {
                    return Err(error(
                        ConnectorErrorKind::Permanent,
                        "unsupported-recurrence",
                        "Microsoft relative recurrence requires a weekday",
                    ));
                }
                pattern["type"] = json!("relativeMonthly");
                pattern["daysOfWeek"] = json!(days);
                pattern["index"] = json!(index);
            } else {
                pattern["type"] = json!("absoluteMonthly");
                let day = properties
                    .get("BYMONTHDAY")
                    .map(String::as_str)
                    .unwrap_or_else(|| {
                        // The provider requires an explicit day even when RFC 5545
                        // implies the DTSTART day.
                        ""
                    });
                let day = if day.is_empty() {
                    start_date.day()
                } else {
                    day.parse::<u32>().map_err(|_| {
                        error(
                            ConnectorErrorKind::Permanent,
                            "invalid-recurrence",
                            "Microsoft monthly recurrence day is invalid",
                        )
                    })?
                };
                pattern["dayOfMonth"] = json!(day);
            }
        }
        Some("YEARLY") => {
            if ["BYDAY", "BYSETPOS"]
                .iter()
                .any(|key| properties.contains_key(*key))
            {
                return Err(error(
                    ConnectorErrorKind::Permanent,
                    "unsupported-recurrence",
                    "Microsoft relative yearly recurrence is not supported safely",
                ));
            }
            pattern["type"] = json!("absoluteYearly");
            let month = properties
                .get("BYMONTH")
                .map(|value| value.parse::<u32>())
                .transpose()
                .map_err(|_| {
                    error(
                        ConnectorErrorKind::Permanent,
                        "invalid-recurrence",
                        "Microsoft yearly recurrence month is invalid",
                    )
                })?
                .unwrap_or(start_date.month());
            let day = properties
                .get("BYMONTHDAY")
                .map(|value| value.parse::<u32>())
                .transpose()
                .map_err(|_| {
                    error(
                        ConnectorErrorKind::Permanent,
                        "invalid-recurrence",
                        "Microsoft yearly recurrence day is invalid",
                    )
                })?
                .unwrap_or(start_date.day());
            pattern["month"] = json!(month);
            pattern["dayOfMonth"] = json!(day);
        }
        _ => {
            return Err(error(
                ConnectorErrorKind::Permanent,
                "unsupported-recurrence",
                "Microsoft Calendar does not support this recurrence frequency",
            ))
        }
    }
    let mut range = json!({
        "type": "noEnd",
        "startDate": start_date.format("%Y-%m-%d").to_string(),
    });
    if let Some(count) = properties.get("COUNT") {
        let count = count.parse::<u32>().map_err(|_| {
            error(
                ConnectorErrorKind::Permanent,
                "invalid-recurrence",
                "Microsoft recurrence count is invalid",
            )
        })?;
        range["type"] = json!("numbered");
        range["numberOfOccurrences"] = json!(count);
    } else if let Some(until) = properties.get("UNTIL") {
        let digits = until
            .chars()
            .filter(char::is_ascii_digit)
            .collect::<String>();
        if digits.len() < 8 {
            return Err(error(
                ConnectorErrorKind::Permanent,
                "invalid-recurrence",
                "Microsoft recurrence end date is invalid",
            ));
        }
        range["type"] = json!("endDate");
        range["endDate"] = json!(format!(
            "{}-{}-{}",
            &digits[..4],
            &digits[4..6],
            &digits[6..8]
        ));
    }
    Ok(Some(json!({ "pattern": pattern, "range": range })))
}

fn graph_json(
    event: &CalendarEvent,
    transaction_id: Option<&str>,
    include_attendees: bool,
) -> Result<Value, ConnectorError> {
    let moment = |moment: &EventMoment, timezone: &str| -> Result<Value, ConnectorError> {
        let provider_timezone = graph_timezone(timezone);
        match moment {
            EventMoment::Timed { utc } => {
                let utc = chrono::DateTime::parse_from_rfc3339(utc).map_err(|_| {
                    error(
                        ConnectorErrorKind::Permanent,
                        "invalid-event",
                        "Microsoft event time is invalid",
                    )
                })?;
                let timezone = timezone.parse::<chrono_tz::Tz>().map_err(|_| {
                    error(
                        ConnectorErrorKind::Permanent,
                        "invalid-event",
                        "Microsoft event timezone is invalid",
                    )
                })?;
                let local = utc.with_timezone(&timezone);
                Ok(json!({
                    "dateTime": local.format("%Y-%m-%dT%H:%M:%S").to_string(),
                    "timeZone": provider_timezone,
                }))
            }
            EventMoment::AllDay { date } => Ok(json!({
                "dateTime": format!("{date}T00:00:00"),
                "timeZone": provider_timezone,
            })),
        }
    };
    let mut value = json!({
        "subject": event.title, "body": { "contentType": "html", "content": event.description }, "location": { "displayName": event.location },
        "start": moment(&event.start, &event.timezone)?, "end": moment(&event.end, &event.timezone)?, "isAllDay": matches!(event.start, EventMoment::AllDay { .. }),
        "showAs": if event.transparency == Transparency::Free { "free" } else { "busy" },
        "sensitivity": match event.visibility { EventVisibility::Private => "private", EventVisibility::Confidential => "confidential", _ => "normal" },
        "isReminderOn": !event.reminders.is_empty(), "reminderMinutesBeforeStart": event.reminders.first().map(|reminder| reminder.minutes_before),
        "transactionId": transaction_id,
    });
    if include_attendees {
        value["attendees"] = Value::Array(event.attendees.iter().map(|attendee| json!({ "emailAddress": { "address": attendee.email, "name": attendee.name }, "type": if attendee.role == AttendeeRole::Optional { "optional" } else { "required" } })).collect());
    }
    if let Some(recurrence) = recurrence_json(event)? {
        value["recurrence"] = recurrence;
    }
    Ok(value)
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
                Some(graph_json(&event, Some(&operation.id), true)?),
            ),
            OperationKind::Update => (
                Method::PATCH,
                format!(
                    "{base}/{}",
                    urlencoding::encode(event.provider_id.as_deref().unwrap_or(&event.uid))
                ),
                Some(graph_json(&event, None, true)?),
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

    fn recurring_graph_event() -> Value {
        json!({
            "id": "event-1",
            "iCalUId": "series@example.test",
            "subject": "Operations review",
            "body": { "content": "Agenda" },
            "location": { "displayName": "Board room" },
            "start": { "dateTime": "2026-09-28T09:00:00Z", "timeZone": "UTC" },
            "end": { "dateTime": "2026-09-28T10:00:00Z", "timeZone": "UTC" },
            "originalStartTimeZone": "UTC",
            "isAllDay": false,
            "recurrence": {
                "pattern": {
                    "type": "weekly",
                    "interval": 2,
                    "daysOfWeek": ["monday", "wednesday"]
                },
                "range": {
                    "type": "endDate",
                    "startDate": "2026-09-28",
                    "endDate": "2026-12-31"
                }
            }
        })
    }

    #[test]
    fn preserves_graph_weekdays_and_end_date_as_an_rrule() {
        let event = graph_event(&recurring_graph_event(), "primary").unwrap();
        let rule = &event.recurrence.unwrap().rules[0];
        assert!(rule.contains("FREQ=WEEKLY"));
        assert!(rule.contains("INTERVAL=2"));
        assert!(rule.contains("BYDAY=MO,WE"));
        assert!(rule.contains("UNTIL=20261231T235959Z"));
    }

    #[test]
    fn writes_a_supported_rrule_as_graph_recurrence() {
        let event = graph_event(&recurring_graph_event(), "primary").unwrap();
        let value = graph_json(&event, None, false).unwrap();
        assert_eq!(value["recurrence"]["pattern"]["type"], "weekly");
        assert_eq!(value["recurrence"]["pattern"]["interval"], 2);
        assert_eq!(
            value["recurrence"]["pattern"]["daysOfWeek"],
            json!(["monday", "wednesday"])
        );
        assert_eq!(value["recurrence"]["range"]["type"], "endDate");
        assert_eq!(value["recurrence"]["range"]["endDate"], "2026-12-31");
    }

    #[test]
    fn converts_between_graph_local_clocks_and_stored_utc_instants() {
        let incoming = graph_moment(
            &json!({
                "dateTime": "2026-09-28T09:00:00.0000000",
                "timeZone": "W. Europe Standard Time"
            }),
            false,
        )
        .unwrap();
        assert_eq!(
            incoming,
            EventMoment::Timed {
                utc: "2026-09-28T07:00:00Z".into()
            }
        );

        let mut event = graph_event(&recurring_graph_event(), "primary").unwrap();
        event.start = EventMoment::Timed {
            utc: "2026-09-28T07:00:00Z".into(),
        };
        event.end = EventMoment::Timed {
            utc: "2026-09-28T08:00:00Z".into(),
        };
        event.timezone = "Europe/Berlin".into();
        let outgoing = graph_json(&event, None, false).unwrap();
        assert_eq!(outgoing["start"]["dateTime"], "2026-09-28T09:00:00");
        assert_eq!(outgoing["start"]["timeZone"], "W. Europe Standard Time");
    }

    #[test]
    fn rejects_recurrence_exceptions_graph_cannot_represent_without_loss() {
        let mut event = graph_event(&recurring_graph_event(), "primary").unwrap();
        event
            .recurrence
            .as_mut()
            .unwrap()
            .excluded_dates
            .push("2026-10-12T09:00:00Z".into());
        let error = graph_json(&event, None, false).unwrap_err();
        assert_eq!(error.code, "unsupported-recurrence");
    }

    #[test]
    fn rejects_rrule_fields_graph_cannot_preserve() {
        let mut event = graph_event(&recurring_graph_event(), "primary").unwrap();
        event.recurrence.as_mut().unwrap().rules = vec!["FREQ=WEEKLY;BYDAY=MO;BYHOUR=9".into()];
        let error = graph_json(&event, None, false).unwrap_err();
        assert_eq!(error.code, "unsupported-recurrence");
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
