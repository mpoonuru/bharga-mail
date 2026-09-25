//! Validated Tauri command boundary for the provider-neutral calendar domain.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use chrono::{DateTime, Duration, SecondsFormat, Timelike, Utc};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use super::connectors::caldav::{CalDavConnector, Credentials};
use super::connectors::{CalendarConnector, ConnectorError, RemoteCalendar};
use super::domain::{
    Calendar, CalendarEvent, CalendarSource, EventMoment, EventMutation, EventRange, EventStatus,
    ParticipationStatus, RecurrenceEditScope, SeriesSplit,
};
use super::ical::{
    build_itip, parse_calendar, write_calendar, ExportOptions, ItipActor, ItipMethod, Limits,
    ParsedEvent, MAX_ICS_BYTES,
};
use crate::store::OutboxItem;
use crate::AppState;

const MAX_RANGE_DAYS: i64 = 400;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarCommandError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl CalendarCommandError {
    fn new(code: impl Into<String>, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InvitationState {
    New,
    Update,
    Current,
    Stale,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InvitationInspection {
    pub state: InvitationState,
    pub method: Option<ItipMethod>,
    pub event: CalendarEvent,
    pub conflicts: Vec<CalendarEvent>,
    pub transport: String,
}

fn same_person(
    left: Option<&super::domain::EventPerson>,
    right: Option<&super::domain::EventPerson>,
) -> bool {
    matches!((left, right), (Some(left), Some(right)) if left.email.eq_ignore_ascii_case(&right.email))
}

fn inspect_invitation(
    existing: Option<&CalendarEvent>,
    incoming: &CalendarEvent,
    method: Option<ItipMethod>,
) -> Result<InvitationInspection, CalendarCommandError> {
    if let Some(existing) = existing {
        if existing.uid != incoming.uid
            || !same_person(existing.organizer.as_ref(), incoming.organizer.as_ref())
        {
            return Err(CalendarCommandError::new(
                "invalid-organizer-or-attendee",
                "Invitation identity does not match the stored event",
                false,
            ));
        }
    }
    let state = if method == Some(ItipMethod::Cancel)
        || incoming.status == super::domain::EventStatus::Cancelled
    {
        InvitationState::Cancelled
    } else if let Some(existing) = existing {
        if incoming.sequence < existing.sequence {
            InvitationState::Stale
        } else if incoming.sequence == existing.sequence {
            InvitationState::Current
        } else {
            InvitationState::Update
        }
    } else {
        InvitationState::New
    };
    Ok(InvitationInspection {
        state,
        method,
        event: incoming.clone(),
        conflicts: Vec::new(),
        transport: "emailAttachment".into(),
    })
}

#[cfg(test)]
fn apply_reply(
    existing: &CalendarEvent,
    incoming: &CalendarEvent,
) -> Result<CalendarEvent, CalendarCommandError> {
    if existing.uid != incoming.uid
        || incoming.sequence < existing.sequence
        || !same_person(existing.organizer.as_ref(), incoming.organizer.as_ref())
    {
        return Err(CalendarCommandError::new(
            "invalid-organizer-or-attendee",
            "Reply does not match the organizer or current event",
            false,
        ));
    }
    let mut updated = existing.clone();
    let mut matched = 0usize;
    for reply in &incoming.attendees {
        let Some(attendee) = updated
            .attendees
            .iter_mut()
            .find(|attendee| attendee.email.eq_ignore_ascii_case(&reply.email))
        else {
            return Err(CalendarCommandError::new(
                "invalid-organizer-or-attendee",
                "Reply sender is not an event attendee",
                false,
            ));
        };
        attendee.status = reply.status;
        attendee.comment = reply.comment.clone();
        matched += 1;
    }
    if matched == 0 {
        return Err(CalendarCommandError::new(
            "invalid-organizer-or-attendee",
            "Reply does not contain an attendee response",
            false,
        ));
    }
    updated.sequence = updated.sequence.max(incoming.sequence);
    updated.revision += 1;
    updated.sync_state = super::domain::EventSyncState::Pending;
    Ok(updated)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRangeInput {
    pub start: String,
    pub end: String,
}

pub type EventMutationInput = EventMutation;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLocalCalendarInput {
    pub name: String,
    pub color: String,
    pub timezone: String,
}

fn parse_range_value(
    value: &str,
    boundary: &'static str,
) -> Result<DateTime<Utc>, CalendarCommandError> {
    DateTime::parse_from_rfc3339(value)
        .map(|parsed| parsed.with_timezone(&Utc))
        .map_err(|_| {
            CalendarCommandError::new(
                "invalid-range",
                format!("Calendar range {boundary} must be an RFC3339 timestamp"),
                false,
            )
        })
}

fn validate_range(input: &EventRangeInput) -> Result<EventRange, CalendarCommandError> {
    let start = parse_range_value(&input.start, "start")?;
    let end = parse_range_value(&input.end, "end")?;
    if end <= start {
        return Err(CalendarCommandError::new(
            "invalid-range",
            "Calendar range end must be after start",
            false,
        ));
    }
    if end.signed_duration_since(start) > Duration::days(MAX_RANGE_DAYS) {
        return Err(CalendarCommandError::new(
            "range-too-large",
            format!("Calendar ranges are limited to {MAX_RANGE_DAYS} days"),
            false,
        ));
    }

    Ok(EventRange {
        start: start.to_rfc3339_opts(SecondsFormat::Secs, true),
        end: end.to_rfc3339_opts(SecondsFormat::Secs, true),
    })
}

fn validate_event(input: EventMutationInput) -> Result<EventMutation, CalendarCommandError> {
    if !matches!(
        (&input.start, &input.end),
        (EventMoment::Timed { .. }, EventMoment::Timed { .. })
            | (EventMoment::AllDay { .. }, EventMoment::AllDay { .. })
    ) {
        return Err(CalendarCommandError::new(
            "invalid-time-shape",
            "Event start and end must both be timed or both be all-day values",
            false,
        ));
    }
    Ok(input)
}

fn store_error(error: rusqlite::Error) -> CalendarCommandError {
    match error {
        rusqlite::Error::InvalidParameterName(message) => {
            let code = if message.contains("does not exist") {
                "not-found"
            } else if message.contains("read-only") {
                "read-only"
            } else if message.contains("same time shape") {
                "invalid-time-shape"
            } else {
                "invalid-input"
            };
            CalendarCommandError::new(code, message, false)
        }
        rusqlite::Error::QueryReturnedNoRows => {
            CalendarCommandError::new("not-found", "Calendar record was not found", false)
        }
        rusqlite::Error::SqliteFailure(ref failure, _)
            if failure.code == rusqlite::ErrorCode::DatabaseBusy
                || failure.code == rusqlite::ErrorCode::DatabaseLocked =>
        {
            CalendarCommandError::new("storage-busy", "Calendar storage is busy; try again", true)
        }
        other => {
            log::error!("calendar storage command failed: {other}");
            CalendarCommandError::new("storage-error", "Calendar storage operation failed", true)
        }
    }
}

fn calendar_error(error: super::recurrence::CalendarError) -> CalendarCommandError {
    CalendarCommandError::new(error.code(), error.message(), false)
}

fn connector_error(error: ConnectorError) -> CalendarCommandError {
    CalendarCommandError::new(
        error.code,
        error.message,
        matches!(
            error.kind,
            super::connectors::ConnectorErrorKind::RateLimited
                | super::connectors::ConnectorErrorKind::Transient
        ),
    )
}

fn io_error(error: std::io::Error) -> CalendarCommandError {
    let retryable = matches!(
        error.kind(),
        std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
    );
    CalendarCommandError::new(
        "file-error",
        "Calendar file could not be read or written",
        retryable,
    )
}

fn read_bounded_calendar_file(path: &str) -> Result<Vec<u8>, CalendarCommandError> {
    let path = Path::new(path);
    let file = File::open(path).map_err(io_error)?;
    if file.metadata().map_err(io_error)?.len() > MAX_ICS_BYTES as u64 {
        return Err(CalendarCommandError::new(
            "ics-too-large",
            format!("Calendar files are limited to {MAX_ICS_BYTES} bytes"),
            false,
        ));
    }
    let mut bytes = Vec::new();
    file.take((MAX_ICS_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() > MAX_ICS_BYTES {
        return Err(CalendarCommandError::new(
            "ics-too-large",
            format!("Calendar files are limited to {MAX_ICS_BYTES} bytes"),
            false,
        ));
    }
    Ok(bytes)
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[tauri::command]
pub fn list_calendar_sources(
    state: State<'_, AppState>,
) -> Result<Vec<CalendarSource>, CalendarCommandError> {
    state.store.calendar_sources().map_err(store_error)
}

#[tauri::command]
pub fn list_calendars(state: State<'_, AppState>) -> Result<Vec<Calendar>, CalendarCommandError> {
    state.store.calendars().map_err(store_error)
}

#[tauri::command]
pub fn list_calendar_events(
    input: EventRangeInput,
    state: State<'_, AppState>,
) -> Result<Vec<CalendarEvent>, CalendarCommandError> {
    let range = validate_range(&input)?;
    state.store.calendar_events(&range).map_err(store_error)
}

#[tauri::command]
pub fn get_calendar_event(
    event_id: String,
    state: State<'_, AppState>,
) -> Result<Option<CalendarEvent>, CalendarCommandError> {
    state.store.calendar_event(&event_id).map_err(store_error)
}

#[tauri::command]
pub fn create_calendar_event(
    input: EventMutationInput,
    state: State<'_, AppState>,
) -> Result<CalendarEvent, CalendarCommandError> {
    state
        .store
        .create_calendar_event(validate_event(input)?)
        .map_err(store_error)
}

#[tauri::command]
pub fn update_calendar_event(
    event_id: String,
    input: EventMutationInput,
    state: State<'_, AppState>,
) -> Result<CalendarEvent, CalendarCommandError> {
    state
        .store
        .update_calendar_event(&event_id, validate_event(input)?)
        .map_err(store_error)
}

#[tauri::command]
pub fn update_recurring_calendar_event(
    event_id: String,
    recurrence_id: String,
    scope: RecurrenceEditScope,
    input: EventMutationInput,
    state: State<'_, AppState>,
) -> Result<SeriesSplit, CalendarCommandError> {
    super::recurrence::edit_recurring_event(
        &state.store,
        &event_id,
        &recurrence_id,
        scope,
        validate_event(input)?,
    )
    .map_err(calendar_error)
}

#[tauri::command]
pub fn delete_calendar_event(
    event_id: String,
    state: State<'_, AppState>,
) -> Result<CalendarEvent, CalendarCommandError> {
    state
        .store
        .delete_calendar_event(&event_id)
        .map_err(store_error)
}

#[tauri::command]
pub fn create_local_calendar(
    input: CreateLocalCalendarInput,
    state: State<'_, AppState>,
) -> Result<Calendar, CalendarCommandError> {
    state
        .store
        .create_local_calendar(&input.name, &input.color, &input.timezone)
        .map_err(store_error)
}

#[tauri::command]
pub fn set_calendar_visibility(
    calendar_id: String,
    visible: bool,
    state: State<'_, AppState>,
) -> Result<(), CalendarCommandError> {
    state
        .store
        .set_calendar_visibility(&calendar_id, visible)
        .map_err(store_error)
}

#[tauri::command]
pub fn import_ics(
    path: String,
    calendar_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<CalendarEvent>, CalendarCommandError> {
    let calendar = state
        .store
        .calendars()
        .map_err(store_error)?
        .into_iter()
        .find(|calendar| calendar.id == calendar_id && calendar.writable)
        .ok_or_else(|| {
            CalendarCommandError::new(
                "read-only",
                "Choose a calendar that allows event creation",
                false,
            )
        })?;
    let parsed = parse_calendar(&read_bounded_calendar_file(&path)?, Limits::default())
        .map_err(calendar_error)?;
    if parsed.events.is_empty() {
        return Err(CalendarCommandError::new(
            "invalid-ics",
            "Calendar file contains no events",
            false,
        ));
    }
    let inputs = parsed
        .events
        .into_iter()
        .map(|parsed| {
            let mut event = parsed.event;
            event.calendar_id = calendar.id.clone();
            event
        })
        .collect();
    state
        .store
        .import_calendar_events(inputs)
        .map_err(store_error)
}

#[tauri::command]
pub fn export_ics(
    path: String,
    event_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<usize, CalendarCommandError> {
    if event_ids.is_empty() || event_ids.len() > Limits::default().max_events {
        return Err(CalendarCommandError::new(
            "invalid-input",
            "Select between one and 2000 events to export",
            false,
        ));
    }
    let mut events = Vec::with_capacity(event_ids.len());
    for event_id in event_ids {
        let event = state
            .store
            .calendar_event(&event_id)
            .map_err(store_error)?
            .filter(|event| !event.deleted)
            .ok_or_else(|| {
                CalendarCommandError::new("not-found", "Calendar event was not found", false)
            })?;
        events.push(ParsedEvent {
            event,
            preserved_properties: Vec::new(),
        });
    }
    let bytes = write_calendar(&events, ExportOptions::default()).map_err(calendar_error)?;
    std::fs::write(path, &bytes).map_err(io_error)?;
    Ok(events.len())
}

#[tauri::command]
pub async fn inspect_calendar_attachment(
    account_id: String,
    message_id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<Vec<InvitationInspection>, CalendarCommandError> {
    let bytes = crate::sync::imap::fetch_attachment_async(
        state.store.clone(),
        account_id,
        message_id,
        name,
    )
    .await
    .map_err(|error| {
        log::warn!("calendar attachment retrieval failed: {error}");
        CalendarCommandError::new(
            "attachment-unavailable",
            "Calendar attachment is not available from this mail provider",
            true,
        )
    })?;
    let parsed = parse_calendar(&bytes, Limits::default()).map_err(calendar_error)?;
    let default_calendar = state
        .store
        .calendars()
        .map_err(store_error)?
        .into_iter()
        .find(|calendar| calendar.writable && calendar.is_default)
        .or_else(|| {
            state
                .store
                .calendars()
                .ok()?
                .into_iter()
                .find(|calendar| calendar.writable)
        });
    parsed
        .events
        .into_iter()
        .map(|parsed_event| {
            let existing = state
                .store
                .calendar_event_by_uid(&parsed_event.event.uid)
                .map_err(store_error)?;
            let mut incoming = parsed_event.event;
            if let Some(existing) = &existing {
                incoming.calendar_id = existing.calendar_id.clone();
            } else if let Some(calendar) = &default_calendar {
                incoming.calendar_id = calendar.id.clone();
            }
            let mut inspection = inspect_invitation(existing.as_ref(), &incoming, parsed.method)?;
            let range = EventRange {
                start: incoming.start.value().to_string(),
                end: incoming.end.value().to_string(),
            };
            if matches!(incoming.start, EventMoment::Timed { .. }) {
                inspection.conflicts = state
                    .store
                    .calendar_events(&range)
                    .map_err(store_error)?
                    .into_iter()
                    .filter(|event| event.uid != incoming.uid)
                    .collect();
            }
            Ok(inspection)
        })
        .collect()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitationResponseInput {
    pub account_id: String,
    pub thread_id: Option<String>,
    pub calendar_id: String,
    pub event: CalendarEvent,
    pub status: ParticipationStatus,
}

#[tauri::command]
pub fn respond_to_invitation(
    input: InvitationResponseInput,
    state: State<'_, AppState>,
) -> Result<CalendarEvent, CalendarCommandError> {
    if !matches!(
        input.status,
        ParticipationStatus::Accepted
            | ParticipationStatus::Tentative
            | ParticipationStatus::Declined
    ) {
        return Err(CalendarCommandError::new(
            "invalid-response",
            "Invitation response must be accepted, tentative, or declined",
            false,
        ));
    }
    let account = state
        .store
        .accounts()
        .into_iter()
        .find(|account| account.id == input.account_id)
        .ok_or_else(|| {
            CalendarCommandError::new("account-not-found", "Mail account was not found", false)
        })?;
    let organizer_email = input
        .event
        .organizer
        .as_ref()
        .map(|organizer| organizer.email.clone())
        .ok_or_else(|| {
            CalendarCommandError::new(
                "invalid-organizer-or-attendee",
                "Invitation does not identify an organizer",
                false,
            )
        })?;
    let existing = state
        .store
        .calendar_event_by_uid(&input.event.uid)
        .map_err(store_error)?;
    let inspection =
        inspect_invitation(existing.as_ref(), &input.event, Some(ItipMethod::Request))?;
    if inspection.state == InvitationState::Stale {
        return Err(CalendarCommandError::new(
            "stale-invitation",
            "A newer version of this invitation is already stored",
            false,
        ));
    }
    let mut event = input.event;
    event.calendar_id = input.calendar_id;
    let attendee = event
        .attendees
        .iter_mut()
        .find(|attendee| attendee.email.eq_ignore_ascii_case(&account.email))
        .ok_or_else(|| {
            CalendarCommandError::new(
                "invalid-organizer-or-attendee",
                "The selected mail account is not an invitation attendee",
                false,
            )
        })?;
    attendee.status = input.status;
    let actor = ItipActor {
        name: (!account.display_name.trim().is_empty()).then_some(account.display_name.clone()),
        email: account.email.clone(),
        participation_status: input.status,
    };
    let ics = build_itip(&event, ItipMethod::Reply, &actor).map_err(calendar_error)?;
    let response = match input.status {
        ParticipationStatus::Accepted => "Accepted",
        ParticipationStatus::Tentative => "Tentative",
        ParticipationStatus::Declined => "Declined",
        _ => unreachable!(),
    };
    let outbox = OutboxItem {
        id: format!("calendar-reply:{}", Uuid::new_v4()),
        account_id: input.account_id,
        thread_id: input.thread_id,
        to: organizer_email,
        cc: String::new(),
        bcc: String::new(),
        subject: format!("{response}: {}", event.title),
        body: format!(
            "<p>{} <strong>{}</strong>.</p>",
            html_escape(&account.display_name),
            html_escape(&format!("{} the invitation", response.to_ascii_lowercase()))
        ),
        attachments: vec![crate::sync::mime::calendar_attachment("REPLY", &ics)],
        scheduled_ts: Utc::now().timestamp(),
        status: "queued".into(),
    };
    let mutation = EventMutation::from(&event);
    state
        .store
        .respond_to_calendar_invitation(
            existing.as_ref().map(|event| event.id.as_str()),
            mutation,
            &event.uid,
            event.sequence,
            &outbox,
        )
        .map_err(store_error)
}

#[tauri::command]
pub fn schedule_from_thread(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<EventMutation, CalendarCommandError> {
    let thread = state
        .store
        .threads()
        .into_iter()
        .find(|thread| thread.id == thread_id)
        .ok_or_else(|| {
            CalendarCommandError::new("not-found", "Mail thread was not found", false)
        })?;
    let calendar = state
        .store
        .calendars()
        .map_err(store_error)?
        .into_iter()
        .find(|calendar| calendar.writable && calendar.is_default)
        .or_else(|| {
            state
                .store
                .calendars()
                .ok()?
                .into_iter()
                .find(|calendar| calendar.writable)
        })
        .ok_or_else(|| {
            CalendarCommandError::new(
                "calendar-not-found",
                "Create or connect a writable calendar first",
                false,
            )
        })?;
    let now = Utc::now();
    let start = (now + Duration::hours(1))
        .with_minute(0)
        .and_then(|value| value.with_second(0))
        .and_then(|value| value.with_nanosecond(0))
        .unwrap_or(now + Duration::hours(1));
    Ok(EventMutation {
        calendar_id: calendar.id,
        title: thread.subject,
        description: thread.preview,
        location: String::new(),
        conference_url: None,
        source_thread_id: Some(thread.id),
        start: EventMoment::Timed {
            utc: start.to_rfc3339_opts(SecondsFormat::Secs, true),
        },
        end: EventMoment::Timed {
            utc: (start + Duration::hours(1)).to_rfc3339_opts(SecondsFormat::Secs, true),
        },
        timezone: calendar.timezone,
        recurrence: None,
        status: EventStatus::Confirmed,
        transparency: super::domain::Transparency::Busy,
        visibility: super::domain::EventVisibility::Default,
        organizer: None,
        attendees: Vec::new(),
        reminders: Vec::new(),
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalDavDiscoveryInput {
    pub url: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCalDavSourceInput {
    pub label: String,
    pub url: String,
    pub username: String,
    pub password: String,
    pub selected_calendar_ids: Vec<String>,
}

fn caldav_credentials(input: &CalDavDiscoveryInput) -> Credentials {
    Credentials::Basic {
        username: input.username.clone(),
        password: input.password.clone(),
    }
}

#[tauri::command]
pub async fn discover_caldav(
    input: CalDavDiscoveryInput,
) -> Result<Vec<RemoteCalendar>, CalendarCommandError> {
    if input.username.trim().is_empty() || input.password.is_empty() {
        return Err(CalendarCommandError::new(
            "credentials-required",
            "CalDAV username and password are required",
            false,
        ));
    }
    CalDavConnector::new(input.url.trim(), caldav_credentials(&input))
        .map_err(connector_error)?
        .discover()
        .await
        .map_err(connector_error)
}

#[tauri::command]
pub async fn save_caldav_source(
    input: SaveCalDavSourceInput,
    state: State<'_, AppState>,
) -> Result<CalendarSource, CalendarCommandError> {
    if input.label.trim().is_empty() || input.label.len() > 256 {
        return Err(CalendarCommandError::new(
            "invalid-label",
            "Connection name is required",
            false,
        ));
    }
    if input.selected_calendar_ids.is_empty() || input.selected_calendar_ids.len() > 500 {
        return Err(CalendarCommandError::new(
            "invalid-selection",
            "Select at least one calendar",
            false,
        ));
    }
    let discovery = CalDavDiscoveryInput {
        url: input.url.clone(),
        username: input.username.clone(),
        password: input.password.clone(),
    };
    let discovered = discover_caldav(discovery).await?;
    let selected = discovered
        .into_iter()
        .filter(|calendar| input.selected_calendar_ids.contains(&calendar.id))
        .collect::<Vec<_>>();
    if selected.len() != input.selected_calendar_ids.len() {
        return Err(CalendarCommandError::new(
            "invalid-selection",
            "A selected calendar is no longer available",
            false,
        ));
    }
    let source_id = format!("caldav:{}", Uuid::new_v4());
    let encrypted = crate::sync::tokens::prepare_secret_updates(&[
        ("username", input.username.as_str()),
        ("password", input.password.as_str()),
    ])
    .map_err(|_| {
        CalendarCommandError::new(
            "credential-storage",
            "CalDAV credentials could not be secured",
            true,
        )
    })?;
    state
        .store
        .save_remote_source_atomic(
            &source_id,
            super::domain::CalendarProvider::CalDav,
            input.label.trim(),
            input.url.trim(),
            &selected,
            &encrypted,
        )
        .map_err(store_error)?;
    let _ = crate::sync::tokens::delete_legacy_secret(&format!("calendar:{source_id}"), "username");
    let _ = crate::sync::tokens::delete_legacy_secret(&format!("calendar:{source_id}"), "password");
    state
        .store
        .calendar_sources()
        .map_err(store_error)?
        .into_iter()
        .find(|source| source.id == source_id)
        .ok_or_else(|| {
            CalendarCommandError::new("storage-error", "Saved calendar source was not found", true)
        })
}

#[tauri::command]
pub async fn connect_google_calendar(
    state: State<'_, AppState>,
) -> Result<CalendarSource, CalendarCommandError> {
    let tokens = super::connectors::google::authorize()
        .await
        .map_err(connector_error)?;
    let email = super::connectors::google::account_email(&tokens.access_token)
        .await
        .map_err(connector_error)?;
    let calendars = super::connectors::google::GoogleConnector::production(&tokens.access_token)
        .map_err(connector_error)?
        .discover()
        .await
        .map_err(connector_error)?;
    if calendars.is_empty() {
        return Err(CalendarCommandError::new(
            "calendar-not-found",
            "Google returned no calendar collections",
            false,
        ));
    }
    let source_id = format!("google-calendar:{}", Uuid::new_v4());
    let mut secrets = vec![("access", tokens.access_token.as_str())];
    if let Some(refresh) = tokens.refresh_token.as_deref() {
        secrets.push(("refresh", refresh));
    }
    let encrypted = crate::sync::tokens::prepare_secret_updates(&secrets).map_err(|_| {
        CalendarCommandError::new(
            "credential-storage",
            "Google Calendar credentials could not be secured",
            true,
        )
    })?;
    state
        .store
        .save_remote_source_atomic(
            &source_id,
            super::domain::CalendarProvider::Google,
            &format!("Google · {email}"),
            &email,
            &calendars,
            &encrypted,
        )
        .map_err(store_error)?;
    state
        .store
        .calendar_sources()
        .map_err(store_error)?
        .into_iter()
        .find(|source| source.id == source_id)
        .ok_or_else(|| {
            CalendarCommandError::new(
                "storage-error",
                "Saved Google Calendar source was not found",
                true,
            )
        })
}

#[tauri::command]
pub async fn connect_microsoft_calendar(
    state: State<'_, AppState>,
) -> Result<CalendarSource, CalendarCommandError> {
    let tokens = super::connectors::microsoft::authorize()
        .await
        .map_err(connector_error)?;
    let email = super::connectors::microsoft::account_email(&tokens.access_token)
        .await
        .map_err(connector_error)?;
    let calendars =
        super::connectors::microsoft::MicrosoftConnector::production(&tokens.access_token)
            .map_err(connector_error)?
            .discover()
            .await
            .map_err(connector_error)?;
    if calendars.is_empty() {
        return Err(CalendarCommandError::new(
            "calendar-not-found",
            "Microsoft returned no calendar collections",
            false,
        ));
    }
    let source_id = format!("microsoft-calendar:{}", Uuid::new_v4());
    let mut secrets = vec![("access", tokens.access_token.as_str())];
    if let Some(refresh) = tokens.refresh_token.as_deref() {
        secrets.push(("refresh", refresh));
    }
    let encrypted = crate::sync::tokens::prepare_secret_updates(&secrets).map_err(|_| {
        CalendarCommandError::new(
            "credential-storage",
            "Microsoft Calendar credentials could not be secured",
            true,
        )
    })?;
    state
        .store
        .save_remote_source_atomic(
            &source_id,
            super::domain::CalendarProvider::Microsoft,
            &format!("Microsoft 365 · {email}"),
            &email,
            &calendars,
            &encrypted,
        )
        .map_err(store_error)?;
    state
        .store
        .calendar_sources()
        .map_err(store_error)?
        .into_iter()
        .find(|source| source.id == source_id)
        .ok_or_else(|| {
            CalendarCommandError::new(
                "storage-error",
                "Saved Microsoft Calendar source was not found",
                true,
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::domain::{
        AttendeeRole, EventAttendee, EventPerson, EventStatus, EventSyncState, EventVisibility,
        ParticipationStatus, Transparency,
    };
    use crate::calendar::ical::ItipMethod;

    fn invitation_event(sequence: i64, attendee: &str) -> CalendarEvent {
        CalendarEvent {
            id: "event-1".into(),
            calendar_id: "calendar-1".into(),
            uid: "meeting@example.test".into(),
            provider_id: None,
            title: "Planning".into(),
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
            recurrence_id: None,
            parent_event_id: None,
            status: EventStatus::Confirmed,
            transparency: Transparency::Busy,
            visibility: EventVisibility::Default,
            organizer: Some(EventPerson {
                name: Some("Organizer".into()),
                email: "organizer@example.test".into(),
            }),
            attendees: vec![EventAttendee {
                name: None,
                email: attendee.into(),
                role: AttendeeRole::Required,
                status: ParticipationStatus::Accepted,
                rsvp: true,
                comment: None,
            }],
            reminders: Vec::new(),
            sequence,
            provider_version: None,
            revision: 1,
            sync_state: EventSyncState::Synced,
            deleted: false,
        }
    }

    #[test]
    fn rejects_unbounded_calendar_range() {
        let result = validate_range(&EventRangeInput {
            start: "2020-01-01T00:00:00Z".into(),
            end: "2040-01-01T00:00:00Z".into(),
        });

        assert_eq!(result.unwrap_err().code, "range-too-large");
    }

    #[test]
    fn rejects_event_with_mixed_all_day_and_timed_moments() {
        let input = EventMutationInput {
            calendar_id: "calendar-1".into(),
            title: "Architecture review".into(),
            description: String::new(),
            location: String::new(),
            conference_url: None,
            source_thread_id: None,
            start: EventMoment::AllDay {
                date: "2026-09-25".into(),
            },
            end: EventMoment::Timed {
                utc: "2026-09-26T00:00:00Z".into(),
            },
            timezone: "Europe/Berlin".into(),
            recurrence: None,
            status: EventStatus::Confirmed,
            transparency: Transparency::Busy,
            visibility: EventVisibility::Default,
            organizer: None,
            attendees: Vec::new(),
            reminders: Vec::new(),
        };

        assert_eq!(
            validate_event(input).unwrap_err().code,
            "invalid-time-shape"
        );
    }

    #[test]
    fn stale_request_cannot_replace_newer_event() {
        let existing = invitation_event(9, "alex@example.test");
        let incoming = invitation_event(8, "alex@example.test");

        assert_eq!(
            inspect_invitation(Some(&existing), &incoming, Some(ItipMethod::Request))
                .unwrap()
                .state,
            InvitationState::Stale
        );
    }

    #[test]
    fn reply_from_non_attendee_is_rejected() {
        let existing = invitation_event(9, "alex@example.test");
        let forged = invitation_event(9, "mallory@example.test");

        assert_eq!(
            apply_reply(&existing, &forged).unwrap_err().code,
            "invalid-organizer-or-attendee"
        );
    }
}
