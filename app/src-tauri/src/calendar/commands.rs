//! Validated Tauri command boundary for the provider-neutral calendar domain.

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::domain::{
    Calendar, CalendarEvent, CalendarSource, EventMoment, EventMutation, EventRange,
};
use crate::AppState;

const MAX_RANGE_DAYS: i64 = 400;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarCommandError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl CalendarCommandError {
    fn new(code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::domain::{EventStatus, EventVisibility, Transparency};

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
}
