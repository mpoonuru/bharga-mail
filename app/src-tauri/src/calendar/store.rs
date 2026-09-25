//! Calendar persistence and atomic offline mutation queue.

use std::collections::HashMap;

use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use uuid::Uuid;

use super::connectors::{PushOutcome, RemoteCalendar, RemoteChange, SyncBatch};
use super::domain::{
    AttendeeRole, Calendar, CalendarAccessRole, CalendarAuthState, CalendarConflict, CalendarEvent,
    CalendarOperation, CalendarProvider, CalendarSource, CalendarSyncHealth, ConflictResolution,
    EventAttendee, EventMoment, EventMutation, EventRange, EventReminder, EventStatus,
    EventSyncState, EventVisibility, OperationKind, ParticipationStatus, ReminderMethod,
    SeriesSplit, Transparency,
};
use super::reminders::ReminderCandidate;
use crate::store::{OutboxItem, Store};

const MAX_TITLE_BYTES: usize = 512;
const MAX_DESCRIPTION_BYTES: usize = 100_000;
const MAX_LOCATION_BYTES: usize = 4_096;
const MAX_URL_BYTES: usize = 8_192;
const MAX_ATTENDEES: usize = 500;
const MAX_REMINDERS: usize = 20;
const MAX_RECURRENCE_VALUES: usize = 128;

#[derive(Debug, Clone)]
pub struct CalendarSyncTarget {
    pub calendar: Calendar,
    pub remote_url: Option<String>,
    pub cursor: Option<String>,
}

fn invalid(message: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::InvalidParameterName(message.into())
}

fn encode<T: serde::Serialize>(value: &T) -> rusqlite::Result<String> {
    serde_json::to_string(value)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}

fn decode<T: serde::de::DeserializeOwned>(value: Option<String>) -> Option<T> {
    value.and_then(|raw| serde_json::from_str(&raw).ok())
}

fn attendee_role(value: &str) -> AttendeeRole {
    match value {
        "optional" => AttendeeRole::Optional,
        "chair" => AttendeeRole::Chair,
        "nonParticipant" => AttendeeRole::NonParticipant,
        _ => AttendeeRole::Required,
    }
}

fn attendee_role_text(value: AttendeeRole) -> &'static str {
    match value {
        AttendeeRole::Required => "required",
        AttendeeRole::Optional => "optional",
        AttendeeRole::Chair => "chair",
        AttendeeRole::NonParticipant => "nonParticipant",
    }
}

fn participation(value: &str) -> ParticipationStatus {
    match value {
        "accepted" => ParticipationStatus::Accepted,
        "declined" => ParticipationStatus::Declined,
        "tentative" => ParticipationStatus::Tentative,
        "delegated" => ParticipationStatus::Delegated,
        _ => ParticipationStatus::NeedsAction,
    }
}

fn participation_text(value: ParticipationStatus) -> &'static str {
    match value {
        ParticipationStatus::NeedsAction => "needsAction",
        ParticipationStatus::Accepted => "accepted",
        ParticipationStatus::Declined => "declined",
        ParticipationStatus::Tentative => "tentative",
        ParticipationStatus::Delegated => "delegated",
    }
}

fn reminder_method(value: &str) -> ReminderMethod {
    if value == "email" {
        ReminderMethod::Email
    } else {
        ReminderMethod::Display
    }
}

fn normalize_moment(moment: &EventMoment) -> rusqlite::Result<EventMoment> {
    match moment {
        EventMoment::Timed { utc } => {
            let parsed = DateTime::parse_from_rfc3339(utc)
                .map_err(|_| invalid("timed event values must be RFC3339 timestamps"))?;
            Ok(EventMoment::Timed {
                utc: parsed
                    .with_timezone(&Utc)
                    .to_rfc3339_opts(SecondsFormat::Secs, true),
            })
        }
        EventMoment::AllDay { date } => {
            NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .map_err(|_| invalid("all-day event values must be ISO dates"))?;
            Ok(EventMoment::AllDay { date: date.clone() })
        }
    }
}

fn validate_mutation(input: &EventMutation) -> rusqlite::Result<EventMutation> {
    let title = input.title.trim();
    if title.is_empty() || title.len() > MAX_TITLE_BYTES {
        return Err(invalid(
            "event title is required and must be at most 512 bytes",
        ));
    }
    if input.description.len() > MAX_DESCRIPTION_BYTES
        || input.location.len() > MAX_LOCATION_BYTES
        || input
            .conference_url
            .as_ref()
            .is_some_and(|value| value.len() > MAX_URL_BYTES)
    {
        return Err(invalid("event text exceeds the supported size"));
    }
    if input.attendees.len() > MAX_ATTENDEES || input.reminders.len() > MAX_REMINDERS {
        return Err(invalid("event attendee or reminder limit exceeded"));
    }
    input
        .timezone
        .parse::<chrono_tz::Tz>()
        .map_err(|_| invalid("event timezone must be an IANA timezone"))?;
    for attendee in &input.attendees {
        let email = attendee.email.trim();
        if email.len() > 320 || !email.contains('@') {
            return Err(invalid("event attendee email is invalid"));
        }
    }
    for reminder in &input.reminders {
        if !(0..=40_320).contains(&reminder.minutes_before) {
            return Err(invalid(
                "event reminder must be between 0 and 40320 minutes",
            ));
        }
    }
    if let Some(recurrence) = &input.recurrence {
        let count =
            recurrence.rules.len() + recurrence.dates.len() + recurrence.excluded_dates.len();
        if count > MAX_RECURRENCE_VALUES
            || recurrence
                .rules
                .iter()
                .chain(&recurrence.dates)
                .chain(&recurrence.excluded_dates)
                .any(|value| value.len() > 4_096)
        {
            return Err(invalid("event recurrence set exceeds the supported size"));
        }
    }

    let start = normalize_moment(&input.start)?;
    let end = normalize_moment(&input.end)?;
    match (&start, &end) {
        (EventMoment::Timed { utc: start }, EventMoment::Timed { utc: end }) => {
            if DateTime::parse_from_rfc3339(start).unwrap()
                >= DateTime::parse_from_rfc3339(end).unwrap()
            {
                return Err(invalid("event end must be after start"));
            }
        }
        (EventMoment::AllDay { date: start }, EventMoment::AllDay { date: end }) => {
            if start >= end {
                return Err(invalid(
                    "all-day event end date must be exclusive and after start",
                ));
            }
        }
        _ => return Err(invalid("event start and end must use the same time shape")),
    }

    let mut normalized = input.clone();
    normalized.title = title.to_string();
    normalized.description = input.description.trim().to_string();
    normalized.location = input.location.trim().to_string();
    normalized.conference_url = input
        .conference_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    normalized.start = start;
    normalized.end = end;
    Ok(normalized)
}

fn replace_people_and_reminders(
    tx: &Transaction<'_>,
    event_id: &str,
    attendees: &[EventAttendee],
    reminders: &[EventReminder],
) -> rusqlite::Result<()> {
    tx.execute(
        "DELETE FROM calendar_event_attendees WHERE event_id=?1",
        [event_id],
    )?;
    tx.execute(
        "DELETE FROM calendar_event_reminders WHERE event_id=?1",
        [event_id],
    )?;
    for attendee in attendees {
        tx.execute(
            "INSERT INTO calendar_event_attendees
             (event_id, email, name, role, status, rsvp, comment)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                event_id,
                attendee.email.trim().to_ascii_lowercase(),
                attendee.name,
                attendee_role_text(attendee.role),
                participation_text(attendee.status),
                attendee.rsvp,
                attendee.comment,
            ],
        )?;
    }
    for reminder in reminders {
        tx.execute(
            "INSERT INTO calendar_event_reminders
             (id, event_id, method, minutes_before, delivered_at)
             VALUES (?1, ?2, ?3, ?4, NULL)",
            params![
                reminder
                    .id
                    .clone()
                    .unwrap_or_else(|| format!("reminder:{}", Uuid::new_v4())),
                event_id,
                reminder.method.as_str(),
                reminder.minutes_before,
            ],
        )?;
    }
    Ok(())
}

fn queue_operation(
    tx: &Transaction<'_>,
    source_id: &str,
    event: &CalendarEvent,
    kind: OperationKind,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO calendar_operations
         (id, source_id, calendar_id, event_id, kind, local_revision,
          expected_provider_version, attempts, next_retry_at, last_error, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, NULL, ?8)",
        params![
            format!("calendar-op:{}", Uuid::new_v4()),
            source_id,
            event.calendar_id,
            event.id,
            kind.as_str(),
            event.revision,
            event.provider_version,
            Utc::now().timestamp(),
        ],
    )?;
    Ok(())
}

fn event_moment(kind: String, value: String) -> EventMoment {
    if kind == "allDay" {
        EventMoment::AllDay { date: value }
    } else {
        EventMoment::Timed { utc: value }
    }
}

fn event_from_row(row: &Row<'_>) -> rusqlite::Result<CalendarEvent> {
    Ok(CalendarEvent {
        id: row.get(0)?,
        calendar_id: row.get(1)?,
        uid: row.get(2)?,
        provider_id: row.get(3)?,
        title: row.get(4)?,
        description: row.get(5)?,
        location: row.get(6)?,
        conference_url: row.get(7)?,
        source_thread_id: row.get(8)?,
        start: event_moment(row.get(9)?, row.get(10)?),
        end: event_moment(row.get(11)?, row.get(12)?),
        timezone: row.get(13)?,
        recurrence: decode(row.get(14)?),
        recurrence_id: row.get(15)?,
        parent_event_id: row.get(16)?,
        status: EventStatus::parse(&row.get::<_, String>(17)?),
        transparency: Transparency::parse(&row.get::<_, String>(18)?),
        visibility: EventVisibility::parse(&row.get::<_, String>(19)?),
        organizer: decode(row.get(20)?),
        attendees: Vec::new(),
        reminders: Vec::new(),
        sequence: row.get(21)?,
        provider_version: row.get(22)?,
        revision: row.get(23)?,
        sync_state: EventSyncState::parse(&row.get::<_, String>(24)?),
        deleted: row.get::<_, i64>(25)? != 0,
    })
}

const EVENT_COLUMNS: &str = "id, calendar_id, uid, provider_id, title, description, location,
     conference_url, source_thread_id, start_kind, start_value, end_kind,
     end_value, timezone, recurrence_json, recurrence_id, parent_event_id,
     status, transparency, visibility, organizer_json, sequence,
     provider_version, local_revision, sync_state, deleted";

fn hydrate_event(
    connection: &Connection,
    mut event: CalendarEvent,
) -> rusqlite::Result<CalendarEvent> {
    if event.recurrence.is_some() {
        let exception_ids = {
            let mut statement = connection.prepare(
                "SELECT recurrence_id FROM calendar_event_exceptions
                 WHERE series_event_id=?1 ORDER BY recurrence_id",
            )?;
            let values = statement
                .query_map([&event.id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            values
        };
        if let Some(recurrence) = event.recurrence.as_mut() {
            recurrence.excluded_dates.extend(exception_ids);
            recurrence.excluded_dates.sort();
            recurrence.excluded_dates.dedup();
        }
    }

    let mut attendee_statement = connection.prepare(
        "SELECT email, name, role, status, rsvp, comment
         FROM calendar_event_attendees WHERE event_id=?1 ORDER BY email",
    )?;
    event.attendees = attendee_statement
        .query_map([&event.id], |row| {
            Ok(EventAttendee {
                email: row.get(0)?,
                name: row.get(1)?,
                role: attendee_role(&row.get::<_, String>(2)?),
                status: participation(&row.get::<_, String>(3)?),
                rsvp: row.get::<_, i64>(4)? != 0,
                comment: row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(attendee_statement);

    let mut reminder_statement = connection.prepare(
        "SELECT id, method, minutes_before
         FROM calendar_event_reminders WHERE event_id=?1 ORDER BY minutes_before DESC, id",
    )?;
    event.reminders = reminder_statement
        .query_map([&event.id], |row| {
            Ok(EventReminder {
                id: row.get(0)?,
                method: reminder_method(&row.get::<_, String>(1)?),
                minutes_before: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(event)
}

fn read_event(connection: &Connection, id: &str) -> rusqlite::Result<Option<CalendarEvent>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {EVENT_COLUMNS} FROM calendar_events WHERE id=?1"
    ))?;
    let event = statement.query_row([id], event_from_row).optional()?;
    drop(statement);
    event
        .map(|value| hydrate_event(connection, value))
        .transpose()
}

fn insert_event(
    tx: &Transaction<'_>,
    input: &EventMutation,
    uid: Option<&str>,
    recurrence_id: Option<&str>,
    parent_event_id: Option<&str>,
) -> rusqlite::Result<(String, CalendarEvent)> {
    let (source_id, writable): (String, bool) = tx
        .query_row(
            "SELECT source_id, writable FROM calendar_calendars
             WHERE id=?1 AND deleted=0",
            [&input.calendar_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| invalid("calendar does not exist"))?;
    if !writable {
        return Err(invalid("calendar is read-only"));
    }

    let id = format!("event:{}", Uuid::new_v4());
    let uid = uid
        .map(str::to_string)
        .unwrap_or_else(|| format!("{}@bharga.local", Uuid::new_v4()));
    let now = Utc::now().timestamp();
    tx.execute(
        "INSERT INTO calendar_events
         (id, calendar_id, uid, provider_id, resource_url, title, description,
          location, conference_url, source_thread_id, start_kind, start_value,
          end_kind, end_value, timezone, recurrence_json, recurrence_id,
          parent_event_id, status, transparency, visibility, organizer_json,
          sequence, provider_version, local_revision, sync_state, deleted,
          created_at, updated_at)
         VALUES (?1, ?2, ?3, NULL, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                 ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                 0, NULL, 1, 'pending', 0, ?21, ?21)",
        params![
            id,
            input.calendar_id,
            uid,
            input.title,
            input.description,
            input.location,
            input.conference_url,
            input.source_thread_id,
            input.start.kind(),
            input.start.value(),
            input.end.kind(),
            input.end.value(),
            input.timezone,
            input.recurrence.as_ref().map(encode).transpose()?,
            recurrence_id,
            parent_event_id,
            input.status.as_str(),
            input.transparency.as_str(),
            input.visibility.as_str(),
            input.organizer.as_ref().map(encode).transpose()?,
            now,
        ],
    )?;
    replace_people_and_reminders(tx, &id, &input.attendees, &input.reminders)?;
    let event = read_event(tx, &id)?.ok_or_else(|| invalid("created event was not found"))?;
    Ok((source_id, event))
}

fn update_event(
    tx: &Transaction<'_>,
    id: &str,
    input: &EventMutation,
) -> rusqlite::Result<(String, CalendarEvent)> {
    let existing = read_event(tx, id)?.ok_or_else(|| invalid("event does not exist"))?;
    let (source_id, writable): (String, bool) = tx.query_row(
        "SELECT source_id, writable FROM calendar_calendars
         WHERE id=?1 AND deleted=0",
        [&input.calendar_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if !writable {
        return Err(invalid("calendar is read-only"));
    }
    let revision = existing.revision + 1;
    tx.execute(
        "UPDATE calendar_events SET calendar_id=?2, title=?3, description=?4,
         location=?5, conference_url=?6, source_thread_id=?7, start_kind=?8,
         start_value=?9, end_kind=?10, end_value=?11, timezone=?12,
         recurrence_json=?13, status=?14, transparency=?15, visibility=?16,
         organizer_json=?17, local_revision=?18, sync_state='pending',
         updated_at=?19 WHERE id=?1",
        params![
            id,
            input.calendar_id,
            input.title,
            input.description,
            input.location,
            input.conference_url,
            input.source_thread_id,
            input.start.kind(),
            input.start.value(),
            input.end.kind(),
            input.end.value(),
            input.timezone,
            input.recurrence.as_ref().map(encode).transpose()?,
            input.status.as_str(),
            input.transparency.as_str(),
            input.visibility.as_str(),
            input.organizer.as_ref().map(encode).transpose()?,
            revision,
            Utc::now().timestamp(),
        ],
    )?;
    replace_people_and_reminders(tx, id, &input.attendees, &input.reminders)?;
    let event = read_event(tx, id)?.ok_or_else(|| invalid("updated event was not found"))?;
    Ok((source_id, event))
}

fn write_remote_event(
    tx: &Transaction<'_>,
    id: &str,
    calendar_id: &str,
    href: &str,
    etag: &Option<String>,
    event: &CalendarEvent,
    now: i64,
) -> rusqlite::Result<()> {
    let provider_id = event.provider_id.as_deref().unwrap_or(href);
    let provider_version = etag.as_ref().or(event.provider_version.as_ref());
    let parent_event_id = event.parent_event_id.as_deref().and_then(|parent| {
        tx.query_row(
            "SELECT id FROM calendar_events WHERE calendar_id=?1 AND provider_id=?2 LIMIT 1",
            params![calendar_id, parent.trim_start_matches("microsoft:")],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
    });
    tx.execute(
        "INSERT INTO calendar_events
         (id, calendar_id, uid, provider_id, resource_url, title, description,
          location, conference_url, source_thread_id, start_kind, start_value,
          end_kind, end_value, timezone, recurrence_json, recurrence_id,
          parent_event_id, status, transparency, visibility, organizer_json,
          sequence, provider_version, local_revision, sync_state, deleted,
          created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                 ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22,
                 ?23, ?24, 1, 'synced', ?25, ?26, ?26)
         ON CONFLICT(id) DO UPDATE SET
           calendar_id=excluded.calendar_id, uid=excluded.uid,
           provider_id=excluded.provider_id, resource_url=excluded.resource_url,
           title=excluded.title, description=excluded.description,
           location=excluded.location, conference_url=excluded.conference_url,
           start_kind=excluded.start_kind, start_value=excluded.start_value,
           end_kind=excluded.end_kind, end_value=excluded.end_value,
           timezone=excluded.timezone, recurrence_json=excluded.recurrence_json,
           recurrence_id=excluded.recurrence_id,
           parent_event_id=excluded.parent_event_id, status=excluded.status,
           transparency=excluded.transparency, visibility=excluded.visibility,
           organizer_json=excluded.organizer_json, sequence=excluded.sequence,
           provider_version=excluded.provider_version, sync_state='synced',
           deleted=excluded.deleted, updated_at=excluded.updated_at",
        params![
            id,
            calendar_id,
            event.uid,
            provider_id,
            href,
            event.title,
            event.description,
            event.location,
            event.conference_url,
            event.source_thread_id,
            event.start.kind(),
            event.start.value(),
            event.end.kind(),
            event.end.value(),
            event.timezone,
            event.recurrence.as_ref().map(encode).transpose()?,
            event.recurrence_id,
            parent_event_id,
            event.status.as_str(),
            event.transparency.as_str(),
            event.visibility.as_str(),
            event.organizer.as_ref().map(encode).transpose()?,
            event.sequence,
            provider_version,
            event.deleted,
            now,
        ],
    )?;
    replace_people_and_reminders(tx, id, &event.attendees, &event.reminders)
}

impl Store {
    pub fn save_remote_source_atomic(
        &self,
        source_id: &str,
        provider: CalendarProvider,
        label: &str,
        address: &str,
        calendars: &[RemoteCalendar],
        encrypted_secrets: &[(String, String)],
    ) -> rusqlite::Result<()> {
        if calendars.is_empty() {
            return Err(invalid("select at least one calendar"));
        }
        let credential_ref = format!("calendar:{source_id}");
        self.with_calendar_transaction(|tx| {
            let now = Utc::now().timestamp();
            let capabilities = calendars
                .iter()
                .flat_map(|calendar| {
                    [
                        calendar
                            .supports_sync_collection
                            .then_some("syncCollection"),
                        calendar.supports_scheduling.then_some("scheduling"),
                    ]
                    .into_iter()
                    .flatten()
                })
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            tx.execute(
                "INSERT INTO calendar_sources
                 (id, linked_account_id, provider, label, address, credential_ref,
                  auth_state, capabilities, disabled, created_at, updated_at)
                 VALUES (?1, NULL, ?2, ?3, ?4, ?5, 'ready', ?6, 0, ?7, ?7)",
                params![
                    source_id,
                    provider.as_str(),
                    label,
                    address,
                    credential_ref,
                    encode(&capabilities)?,
                    now
                ],
            )?;
            let has_default: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM calendar_calendars WHERE deleted=0)",
                [],
                |row| row.get(0),
            )?;
            for (index, calendar) in calendars.iter().enumerate() {
                let id = format!("calendar:{}", Uuid::new_v4());
                tx.execute(
                    "INSERT INTO calendar_calendars
                     (id, source_id, provider_id, remote_url, name, description, color,
                      timezone, access_role, writable, visible, is_default, sort_order,
                      ctag, sync_token, deleted, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11,
                             (SELECT COUNT(*) FROM calendar_calendars), ?12, ?13, 0, ?14, ?14)",
                    params![
                        id,
                        source_id,
                        calendar.id,
                        calendar.href,
                        calendar.name,
                        calendar.description,
                        calendar.color,
                        calendar.timezone,
                        if calendar.writable { "owner" } else { "reader" },
                        calendar.writable,
                        !has_default && index == 0,
                        calendar.ctag,
                        calendar.sync_token,
                        now,
                    ],
                )?;
            }
            for (kind, encrypted) in encrypted_secrets {
                tx.execute(
                    "INSERT INTO secrets (key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    params![format!("{credential_ref}:{kind}"), encrypted],
                )?;
            }
            Ok(())
        })
    }

    pub fn create_local_calendar(
        &self,
        name: &str,
        color: &str,
        timezone: &str,
    ) -> rusqlite::Result<Calendar> {
        let name = name.trim();
        if name.is_empty() || name.len() > 256 {
            return Err(invalid(
                "calendar name is required and must be at most 256 bytes",
            ));
        }
        timezone
            .parse::<chrono_tz::Tz>()
            .map_err(|_| invalid("calendar timezone must be an IANA timezone"))?;
        let color = color.trim();
        if color.len() != 7
            || !color.starts_with('#')
            || !color[1..]
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        {
            return Err(invalid("calendar color must be a six-digit hex color"));
        }

        self.with_calendar_transaction(|tx| {
            let source_id = format!("local:{}", Uuid::new_v4());
            let calendar_id = format!("calendar:{}", Uuid::new_v4());
            let now = Utc::now().timestamp();
            let is_default: bool = tx.query_row(
                "SELECT NOT EXISTS(SELECT 1 FROM calendar_calendars WHERE deleted=0)",
                [],
                |row| row.get(0),
            )?;
            tx.execute(
                "INSERT INTO calendar_sources
                 (id, linked_account_id, provider, label, address, credential_ref,
                  auth_state, capabilities, disabled, created_at, updated_at)
                 VALUES (?1, NULL, 'local', ?2, NULL, NULL, 'ready', '[]', 0, ?3, ?3)",
                params![source_id, name, now],
            )?;
            tx.execute(
                "INSERT INTO calendar_calendars
                 (id, source_id, provider_id, name, description, color, timezone,
                  access_role, writable, visible, is_default, sort_order, deleted,
                  created_at, updated_at)
                 VALUES (?1, ?2, NULL, ?3, '', ?4, ?5, 'owner', 1, 1, ?6,
                         (SELECT COUNT(*) FROM calendar_calendars), 0, ?7, ?7)",
                params![
                    calendar_id,
                    source_id,
                    name,
                    color,
                    timezone,
                    is_default,
                    now
                ],
            )?;
            Ok(Calendar {
                id: calendar_id,
                source_id,
                provider_id: None,
                name: name.to_string(),
                description: String::new(),
                color: color.to_string(),
                timezone: timezone.to_string(),
                access_role: CalendarAccessRole::Owner,
                writable: true,
                visible: true,
                is_default,
                sort_order: 0,
            })
        })
    }

    pub fn calendar_sources(&self) -> rusqlite::Result<Vec<CalendarSource>> {
        self.with_calendar_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, linked_account_id, provider, label, address, auth_state,
                        capabilities, last_sync_at, sync_error, disabled
                 FROM calendar_sources ORDER BY created_at, id",
            )?;
            let sources = statement
                .query_map([], |row| {
                    Ok(CalendarSource {
                        id: row.get(0)?,
                        linked_account_id: row.get(1)?,
                        provider: CalendarProvider::parse(&row.get::<_, String>(2)?),
                        label: row.get(3)?,
                        address: row.get(4)?,
                        auth_state: CalendarAuthState::parse(&row.get::<_, String>(5)?),
                        capabilities: decode(row.get(6)?).unwrap_or_default(),
                        last_sync_at: row.get(7)?,
                        sync_error: row.get(8)?,
                        disabled: row.get::<_, i64>(9)? != 0,
                    })
                })?
                .collect();
            sources
        })
    }

    pub fn calendars(&self) -> rusqlite::Result<Vec<Calendar>> {
        self.with_calendar_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, source_id, provider_id, name, description, color,
                        timezone, access_role, writable, visible, is_default, sort_order
                 FROM calendar_calendars WHERE deleted=0 ORDER BY sort_order, id",
            )?;
            let calendars = statement
                .query_map([], |row| {
                    Ok(Calendar {
                        id: row.get(0)?,
                        source_id: row.get(1)?,
                        provider_id: row.get(2)?,
                        name: row.get(3)?,
                        description: row.get(4)?,
                        color: row.get(5)?,
                        timezone: row.get(6)?,
                        access_role: CalendarAccessRole::parse(&row.get::<_, String>(7)?),
                        writable: row.get::<_, i64>(8)? != 0,
                        visible: row.get::<_, i64>(9)? != 0,
                        is_default: row.get::<_, i64>(10)? != 0,
                        sort_order: row.get(11)?,
                    })
                })?
                .collect();
            calendars
        })
    }

    pub fn set_calendar_visibility(&self, id: &str, visible: bool) -> rusqlite::Result<()> {
        self.with_calendar_connection(|connection| {
            let changed = connection.execute(
                "UPDATE calendar_calendars SET visible=?2, updated_at=?3
                 WHERE id=?1 AND deleted=0",
                params![id, visible, Utc::now().timestamp()],
            )?;
            if changed == 0 {
                return Err(invalid("calendar does not exist"));
            }
            Ok(())
        })
    }

    pub fn calendar_events(&self, range: &EventRange) -> rusqlite::Result<Vec<CalendarEvent>> {
        let start = DateTime::parse_from_rfc3339(&range.start)
            .map_err(|_| invalid("calendar range start must be RFC3339"))?
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Secs, true);
        let end = DateTime::parse_from_rfc3339(&range.end)
            .map_err(|_| invalid("calendar range end must be RFC3339"))?
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Secs, true);
        if start >= end {
            return Err(invalid("calendar range end must be after start"));
        }
        let start_date = &start[..10];
        let end_date = &end[..10];
        self.with_calendar_connection(|connection| {
            let ids = {
                let mut statement = connection.prepare(
                    "SELECT id FROM calendar_events
                     WHERE deleted=0 AND (
                       (start_kind='timed' AND start_value < ?2 AND end_value > ?1) OR
                       (start_kind='allDay' AND start_value < ?4 AND end_value > ?3)
                     ) ORDER BY start_value, end_value, id",
                )?;
                let ids = statement
                    .query_map(params![start, end, start_date, end_date], |row| {
                        row.get::<_, String>(0)
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                ids
            };
            ids.into_iter()
                .filter_map(|id| read_event(connection, &id).transpose())
                .collect()
        })
    }

    pub fn calendar_event(&self, id: &str) -> rusqlite::Result<Option<CalendarEvent>> {
        self.with_calendar_connection(|connection| read_event(connection, id))
    }

    pub fn calendar_event_by_uid(&self, uid: &str) -> rusqlite::Result<Option<CalendarEvent>> {
        self.with_calendar_connection(|connection| {
            let id = connection
                .query_row(
                    "SELECT id FROM calendar_events WHERE uid=?1 AND deleted=0 ORDER BY local_revision DESC LIMIT 1",
                    [uid],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            id.map(|id| read_event(connection, &id)).transpose().map(Option::flatten)
        })
    }

    pub fn import_calendar_events(
        &self,
        mut inputs: Vec<CalendarEvent>,
    ) -> rusqlite::Result<Vec<CalendarEvent>> {
        inputs.sort_by_key(|event| event.recurrence_id.is_some());
        let inputs = inputs
            .into_iter()
            .map(|event| {
                let input = validate_mutation(&EventMutation::from(&event))?;
                Ok((input, event))
            })
            .collect::<rusqlite::Result<Vec<_>>>()?;
        self.with_calendar_transaction(|tx| {
            let mut events = Vec::with_capacity(inputs.len());
            let mut masters = HashMap::<String, String>::new();
            for (input, source) in &inputs {
                let parent_id = source
                    .recurrence_id
                    .as_ref()
                    .and_then(|_| masters.get(&source.uid))
                    .map(String::as_str);
                let (source_id, inserted) = insert_event(
                    tx,
                    input,
                    Some(&source.uid),
                    source.recurrence_id.as_deref(),
                    parent_id,
                )?;
                tx.execute(
                    "UPDATE calendar_events SET sequence=?2 WHERE id=?1",
                    params![inserted.id, source.sequence],
                )?;
                if let (Some(recurrence_id), Some(parent_id)) =
                    (source.recurrence_id.as_deref(), parent_id)
                {
                    tx.execute(
                        "INSERT INTO calendar_event_exceptions
                         (series_event_id, recurrence_id, event_id, cancelled)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![
                            parent_id,
                            recurrence_id,
                            inserted.id,
                            source.status == EventStatus::Cancelled,
                        ],
                    )?;
                }
                let event = read_event(tx, &inserted.id)?
                    .ok_or_else(|| invalid("imported event was not found"))?;
                if source.recurrence_id.is_none() {
                    masters.insert(source.uid.clone(), event.id.clone());
                }
                queue_operation(tx, &source_id, &event, OperationKind::Create)?;
                events.push(event);
            }
            Ok(events)
        })
    }

    /// Persist an RSVP and its outgoing iTIP reply in one SQLite transaction.
    /// This prevents the local attendance state from diverging from the durable
    /// outbox when the process exits between the two operations.
    pub fn respond_to_calendar_invitation(
        &self,
        existing_id: Option<&str>,
        input: EventMutation,
        uid: &str,
        sequence: i64,
        outbox: &OutboxItem,
    ) -> rusqlite::Result<CalendarEvent> {
        let input = validate_mutation(&input)?;
        self.with_calendar_transaction(|tx| {
            let (source_id, event, operation) = if let Some(event_id) = existing_id {
                let (source_id, event) = update_event(tx, event_id, &input)?;
                (source_id, event, OperationKind::Update)
            } else {
                let (source_id, event) = insert_event(tx, &input, Some(uid), None, None)?;
                (source_id, event, OperationKind::Create)
            };
            tx.execute(
                "UPDATE calendar_events SET sequence=?2 WHERE id=?1",
                params![event.id, sequence],
            )?;
            let event = read_event(tx, &event.id)?
                .ok_or_else(|| invalid("responded event was not found"))?;
            queue_operation(tx, &source_id, &event, operation)?;
            tx.execute(
                "INSERT INTO outbox
                 (id, account_id, thread_id, recipient, subject, body, attachments,
                  scheduled_ts, status, cc, bcc)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                params![
                    outbox.id,
                    outbox.account_id,
                    outbox.thread_id,
                    outbox.to,
                    outbox.subject,
                    outbox.body,
                    encode(&outbox.attachments)?,
                    outbox.scheduled_ts,
                    outbox.status,
                    outbox.cc,
                    outbox.bcc,
                ],
            )?;
            Ok(event)
        })
    }

    pub fn create_calendar_event(&self, input: EventMutation) -> rusqlite::Result<CalendarEvent> {
        let input = validate_mutation(&input)?;
        self.with_calendar_transaction(|tx| {
            let (source_id, event) = insert_event(tx, &input, None, None, None)?;
            queue_operation(tx, &source_id, &event, OperationKind::Create)?;
            Ok(event)
        })
    }

    pub fn update_calendar_event(
        &self,
        id: &str,
        input: EventMutation,
    ) -> rusqlite::Result<CalendarEvent> {
        let input = validate_mutation(&input)?;
        self.with_calendar_transaction(|tx| {
            let (source_id, event) = update_event(tx, id, &input)?;
            queue_operation(tx, &source_id, &event, OperationKind::Update)?;
            Ok(event)
        })
    }

    pub(crate) fn create_calendar_exception(
        &self,
        master_id: &str,
        recurrence_id: &str,
        mut input: EventMutation,
    ) -> rusqlite::Result<SeriesSplit> {
        input.recurrence = None;
        let input = validate_mutation(&input)?;
        self.with_calendar_transaction(|tx| {
            let master = read_event(tx, master_id)?
                .filter(|event| event.recurrence.is_some() && event.parent_event_id.is_none())
                .ok_or_else(|| invalid("recurring series does not exist"))?;
            if input.calendar_id != master.calendar_id {
                return Err(invalid(
                    "a recurrence exception must remain in its series calendar",
                ));
            }
            let existing_id = tx
                .query_row(
                    "SELECT event_id FROM calendar_event_exceptions
                     WHERE series_event_id=?1 AND recurrence_id=?2",
                    params![master_id, recurrence_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten();
            let (source_id, exception, operation) = if let Some(existing_id) = existing_id {
                let (source_id, exception) = update_event(tx, &existing_id, &input)?;
                (source_id, exception, OperationKind::Update)
            } else {
                let (source_id, exception) = insert_event(
                    tx,
                    &input,
                    Some(&master.uid),
                    Some(recurrence_id),
                    Some(master_id),
                )?;
                (source_id, exception, OperationKind::Create)
            };
            tx.execute(
                "INSERT INTO calendar_event_exceptions
                 (series_event_id, recurrence_id, event_id, cancelled)
                 VALUES (?1, ?2, ?3, 0)
                 ON CONFLICT(series_event_id, recurrence_id) DO UPDATE SET
                   event_id=excluded.event_id, cancelled=0",
                params![master_id, recurrence_id, exception.id],
            )?;
            queue_operation(tx, &source_id, &exception, operation)?;
            Ok(SeriesSplit {
                original: master,
                following: None,
                exception: Some(exception),
            })
        })
    }

    pub(crate) fn calendar_exception(
        &self,
        master_id: &str,
        recurrence_id: &str,
    ) -> rusqlite::Result<Option<CalendarEvent>> {
        self.with_calendar_connection(|connection| {
            let event_id = connection
                .query_row(
                    "SELECT event_id FROM calendar_event_exceptions
                     WHERE series_event_id=?1 AND recurrence_id=?2",
                    params![master_id, recurrence_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten();
            event_id
                .map(|event_id| read_event(connection, &event_id))
                .transpose()
                .map(Option::flatten)
        })
    }

    pub(crate) fn split_calendar_series(
        &self,
        master_id: &str,
        original_input: EventMutation,
        following_input: EventMutation,
    ) -> rusqlite::Result<SeriesSplit> {
        let original_input = validate_mutation(&original_input)?;
        let following_input = validate_mutation(&following_input)?;
        self.with_calendar_transaction(|tx| {
            let master = read_event(tx, master_id)?
                .filter(|event| event.recurrence.is_some() && event.parent_event_id.is_none())
                .ok_or_else(|| invalid("recurring series does not exist"))?;
            let (original_source, original) = update_event(tx, master_id, &original_input)?;
            queue_operation(tx, &original_source, &original, OperationKind::Update)?;
            let (following_source, following) =
                insert_event(tx, &following_input, None, None, None)?;
            queue_operation(tx, &following_source, &following, OperationKind::Create)?;
            debug_assert_eq!(master.id, original.id);
            Ok(SeriesSplit {
                original,
                following: Some(following),
                exception: None,
            })
        })
    }

    pub fn delete_calendar_event(&self, id: &str) -> rusqlite::Result<CalendarEvent> {
        self.with_calendar_transaction(|tx| {
            let existing = read_event(tx, id)?.ok_or_else(|| invalid("event does not exist"))?;
            let source_id: String = tx.query_row(
                "SELECT source_id FROM calendar_calendars WHERE id=?1",
                [&existing.calendar_id],
                |row| row.get(0),
            )?;
            tx.execute(
                "UPDATE calendar_events SET deleted=1, sync_state='pending',
                 local_revision=local_revision+1, updated_at=?2 WHERE id=?1",
                params![id, Utc::now().timestamp()],
            )?;
            let event =
                read_event(tx, id)?.ok_or_else(|| invalid("deleted event was not found"))?;
            queue_operation(tx, &source_id, &event, OperationKind::Delete)?;
            Ok(event)
        })
    }

    pub fn calendar_operation_for(&self, event_id: &str) -> rusqlite::Result<CalendarOperation> {
        self.with_calendar_connection(|connection| {
            connection.query_row(
                "SELECT id, source_id, calendar_id, event_id, kind, local_revision,
                        expected_provider_version, attempts, next_retry_at, last_error
                 FROM calendar_operations WHERE event_id=?1
                 ORDER BY created_at DESC, rowid DESC LIMIT 1",
                [event_id],
                |row| {
                    Ok(CalendarOperation {
                        id: row.get(0)?,
                        source_id: row.get(1)?,
                        calendar_id: row.get(2)?,
                        event_id: row.get(3)?,
                        kind: OperationKind::parse(&row.get::<_, String>(4)?),
                        revision: row.get(5)?,
                        expected_provider_version: row.get(6)?,
                        attempts: row.get(7)?,
                        next_retry_at: row.get(8)?,
                        last_error: row.get(9)?,
                    })
                },
            )
        })
    }

    pub fn calendar_sync_targets(
        &self,
        source_id: &str,
    ) -> rusqlite::Result<Vec<CalendarSyncTarget>> {
        self.with_calendar_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT c.id, c.source_id, c.provider_id, c.name, c.description, c.color,
                        c.timezone, c.access_role, c.writable, c.visible, c.is_default,
                        c.sort_order, c.remote_url, s.cursor
                 FROM calendar_calendars c
                 LEFT JOIN calendar_sync_state s ON s.calendar_id=c.id
                 WHERE c.source_id=?1 AND c.deleted=0 ORDER BY c.sort_order, c.id",
            )?;
            let targets = statement
                .query_map([source_id], |row| {
                    Ok(CalendarSyncTarget {
                        calendar: Calendar {
                            id: row.get(0)?,
                            source_id: row.get(1)?,
                            provider_id: row.get(2)?,
                            name: row.get(3)?,
                            description: row.get(4)?,
                            color: row.get(5)?,
                            timezone: row.get(6)?,
                            access_role: CalendarAccessRole::parse(&row.get::<_, String>(7)?),
                            writable: row.get::<_, i64>(8)? != 0,
                            visible: row.get::<_, i64>(9)? != 0,
                            is_default: row.get::<_, i64>(10)? != 0,
                            sort_order: row.get(11)?,
                        },
                        remote_url: row.get(12)?,
                        cursor: row.get(13)?,
                    })
                })?
                .collect();
            targets
        })
    }

    pub fn due_calendar_operations(
        &self,
        source_id: &str,
        now: i64,
    ) -> rusqlite::Result<Vec<CalendarOperation>> {
        self.with_calendar_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, source_id, calendar_id, event_id, kind, local_revision,
                        expected_provider_version, attempts, next_retry_at, last_error
                 FROM calendar_operations
                 WHERE source_id=?1 AND next_retry_at<=?2
                 ORDER BY created_at, rowid LIMIT 100",
            )?;
            let operations = statement
                .query_map(params![source_id, now], |row| {
                    Ok(CalendarOperation {
                        id: row.get(0)?,
                        source_id: row.get(1)?,
                        calendar_id: row.get(2)?,
                        event_id: row.get(3)?,
                        kind: OperationKind::parse(&row.get::<_, String>(4)?),
                        revision: row.get(5)?,
                        expected_provider_version: row.get(6)?,
                        attempts: row.get(7)?,
                        next_retry_at: row.get(8)?,
                        last_error: row.get(9)?,
                    })
                })?
                .collect();
            operations
        })
    }

    pub fn complete_calendar_operation(
        &self,
        operation: &CalendarOperation,
        outcome: &PushOutcome,
    ) -> rusqlite::Result<()> {
        self.with_calendar_transaction(|tx| {
            tx.execute(
                "UPDATE calendar_events SET provider_id=COALESCE(?2, provider_id),
                 resource_url=COALESCE(?2, resource_url),
                 provider_version=COALESCE(?3, provider_version), sync_state='synced',
                 updated_at=?4 WHERE id=?1 AND local_revision=?5",
                params![
                    operation.event_id,
                    outcome.href,
                    outcome.provider_version,
                    Utc::now().timestamp(),
                    operation.revision,
                ],
            )?;
            tx.execute(
                "DELETE FROM calendar_operations WHERE id=?1",
                [&operation.id],
            )?;
            Ok(())
        })
    }

    pub fn retry_calendar_operation(
        &self,
        operation_id: &str,
        error_code: &str,
        retry_at: i64,
    ) -> rusqlite::Result<()> {
        self.with_calendar_connection(|connection| {
            connection.execute(
                "UPDATE calendar_operations SET attempts=attempts+1,
                 next_retry_at=?2, last_error=?3 WHERE id=?1",
                params![operation_id, retry_at, error_code],
            )?;
            Ok(())
        })
    }

    pub fn commit_calendar_sync_batch(
        &self,
        calendar_id: &str,
        batch: &SyncBatch,
    ) -> rusqlite::Result<()> {
        self.with_calendar_transaction(|tx| {
            let now = Utc::now().timestamp();
            for change in &batch.changes {
                match change {
                    RemoteChange::Upsert { href, etag, event } => {
                        let existing_id = tx
                            .query_row(
                                "SELECT id FROM calendar_events
                                 WHERE calendar_id=?1 AND
                                   (provider_id=?2 OR resource_url=?3 OR
                                    (uid=?4 AND IFNULL(recurrence_id, '')=IFNULL(?5, '')))
                                 LIMIT 1",
                                params![
                                    calendar_id,
                                    event.provider_id,
                                    href,
                                    event.uid,
                                    event.recurrence_id,
                                ],
                                |row| row.get::<_, String>(0),
                            )
                            .optional()?;
                        if let Some(existing_id) = existing_id {
                            let local = read_event(tx, &existing_id)?
                                .ok_or_else(|| invalid("calendar event disappeared during sync"))?;
                            if matches!(local.sync_state, EventSyncState::Pending | EventSyncState::Conflict) {
                                let mut remote = event.clone();
                                remote.id = existing_id.clone();
                                remote.calendar_id = calendar_id.to_string();
                                tx.execute(
                                    "INSERT INTO calendar_conflicts
                                     (event_id, local_json, remote_json, provider_version, created_at)
                                     VALUES (?1, ?2, ?3, ?4, ?5)
                                     ON CONFLICT(event_id) DO UPDATE SET
                                       local_json=excluded.local_json,
                                       remote_json=excluded.remote_json,
                                       provider_version=excluded.provider_version,
                                       created_at=excluded.created_at",
                                    params![
                                        existing_id,
                                        encode(&local)?,
                                        encode(&remote)?,
                                        etag.as_ref().or(event.provider_version.as_ref()),
                                        now,
                                    ],
                                )?;
                                tx.execute(
                                    "UPDATE calendar_events SET sync_state='conflict', updated_at=?2
                                     WHERE id=?1",
                                    params![existing_id, now],
                                )?;
                                continue;
                            }
                            write_remote_event(tx, &existing_id, calendar_id, href, etag, event, now)?;
                        } else {
                            let id = format!("event:{}", Uuid::new_v4());
                            write_remote_event(tx, &id, calendar_id, href, etag, event, now)?;
                        }
                    }
                    RemoteChange::Delete { href } => {
                        let existing_id = tx
                            .query_row(
                                "SELECT id FROM calendar_events WHERE calendar_id=?1 AND
                                 (provider_id=?2 OR resource_url=?2) LIMIT 1",
                                params![calendar_id, href],
                                |row| row.get::<_, String>(0),
                            )
                            .optional()?;
                        if let Some(existing_id) = existing_id {
                            let local = read_event(tx, &existing_id)?
                                .ok_or_else(|| invalid("calendar event disappeared during sync"))?;
                            if local.sync_state == EventSyncState::Pending {
                                let mut remote = local.clone();
                                remote.deleted = true;
                                remote.sync_state = EventSyncState::Synced;
                                tx.execute(
                                    "INSERT INTO calendar_conflicts
                                     (event_id, local_json, remote_json, provider_version, created_at)
                                     VALUES (?1, ?2, ?3, NULL, ?4)
                                     ON CONFLICT(event_id) DO UPDATE SET
                                       local_json=excluded.local_json,
                                       remote_json=excluded.remote_json,
                                       provider_version=NULL,
                                       created_at=excluded.created_at",
                                    params![existing_id, encode(&local)?, encode(&remote)?, now],
                                )?;
                                tx.execute(
                                    "UPDATE calendar_events SET sync_state='conflict', updated_at=?2
                                     WHERE id=?1",
                                    params![existing_id, now],
                                )?;
                            } else {
                                tx.execute(
                                    "UPDATE calendar_events SET deleted=1, sync_state='synced',
                                     updated_at=?2 WHERE id=?1",
                                    params![existing_id, now],
                                )?;
                            }
                        }
                    }
                }
            }
            tx.execute(
                "INSERT INTO calendar_sync_state (calendar_id, cursor, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(calendar_id) DO UPDATE SET
                   cursor=excluded.cursor, updated_at=excluded.updated_at",
                params![calendar_id, batch.next_cursor, now],
            )?;
            let source_id: String = tx.query_row(
                "SELECT source_id FROM calendar_calendars WHERE id=?1",
                [calendar_id],
                |row| row.get(0),
            )?;
            tx.execute(
                "UPDATE calendar_sources SET last_attempt_at=?2, last_sync_at=?2,
                 sync_error=NULL, retry_at=NULL, auth_state='ready', updated_at=?2
                 WHERE id=?1",
                params![source_id, now],
            )?;
            Ok(())
        })
    }

    pub fn record_calendar_sync_error(
        &self,
        source_id: &str,
        error_code: &str,
        auth_required: bool,
        retry_at: Option<i64>,
    ) -> rusqlite::Result<()> {
        self.with_calendar_connection(|connection| {
            let now = Utc::now().timestamp();
            connection.execute(
                "UPDATE calendar_sources SET last_attempt_at=?2, sync_error=?3,
                 retry_at=?4, auth_state=?5, updated_at=?2 WHERE id=?1",
                params![
                    source_id,
                    now,
                    error_code,
                    retry_at,
                    if auth_required {
                        "reauthorizationRequired"
                    } else {
                        "error"
                    },
                ],
            )?;
            Ok(())
        })
    }

    pub fn calendar_conflicts(&self) -> rusqlite::Result<Vec<CalendarConflict>> {
        self.with_calendar_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT event_id, local_json, remote_json, provider_version, created_at
                 FROM calendar_conflicts ORDER BY created_at, event_id",
            )?;
            let conflicts = statement
                .query_map([], |row| {
                    let local_json: String = row.get(1)?;
                    let remote_json: String = row.get(2)?;
                    Ok(CalendarConflict {
                        event_id: row.get(0)?,
                        local: serde_json::from_str(&local_json).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                local_json.len(),
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?,
                        remote: serde_json::from_str(&remote_json).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                remote_json.len(),
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?,
                        provider_version: row.get(3)?,
                        created_at: row.get(4)?,
                    })
                })?
                .collect();
            conflicts
        })
    }

    pub fn resolve_calendar_conflict(
        &self,
        event_id: &str,
        resolution: ConflictResolution,
    ) -> rusqlite::Result<Vec<CalendarEvent>> {
        self.with_calendar_transaction(|tx| {
            let (local_json, remote_json, provider_version): (String, String, Option<String>) = tx
                .query_row(
                    "SELECT local_json, remote_json, provider_version
                     FROM calendar_conflicts WHERE event_id=?1",
                    [event_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
            let local: CalendarEvent = serde_json::from_str(&local_json)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            let remote: CalendarEvent = serde_json::from_str(&remote_json)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            tx.execute(
                "DELETE FROM calendar_operations WHERE event_id=?1",
                [event_id],
            )?;
            let now = Utc::now().timestamp();
            let mut resolved = Vec::new();
            match resolution {
                ConflictResolution::KeepLocal => {
                    tx.execute(
                        "UPDATE calendar_events SET provider_version=?2, sync_state='pending',
                         updated_at=?3 WHERE id=?1",
                        params![event_id, provider_version, now],
                    )?;
                    let event = read_event(tx, event_id)?
                        .ok_or_else(|| invalid("conflicted event was not found"))?;
                    let source_id: String = tx.query_row(
                        "SELECT source_id FROM calendar_calendars WHERE id=?1",
                        [&event.calendar_id],
                        |row| row.get(0),
                    )?;
                    queue_operation(tx, &source_id, &event, OperationKind::Update)?;
                    resolved.push(event);
                }
                ConflictResolution::UseRemote | ConflictResolution::Duplicate => {
                    let href = remote.provider_id.as_deref().unwrap_or(remote.uid.as_str());
                    write_remote_event(
                        tx,
                        event_id,
                        &remote.calendar_id,
                        href,
                        &provider_version,
                        &remote,
                        now,
                    )?;
                    resolved.push(
                        read_event(tx, event_id)?
                            .ok_or_else(|| invalid("remote event was not restored"))?,
                    );
                    if resolution == ConflictResolution::Duplicate {
                        let duplicate = EventMutation::from(&local);
                        let (source_id, duplicate) =
                            insert_event(tx, &duplicate, None, None, None)?;
                        queue_operation(tx, &source_id, &duplicate, OperationKind::Create)?;
                        resolved.push(duplicate);
                    }
                }
            }
            tx.execute(
                "DELETE FROM calendar_conflicts WHERE event_id=?1",
                [event_id],
            )?;
            Ok(resolved)
        })
    }

    pub fn calendar_sync_health(&self, source_id: &str) -> rusqlite::Result<CalendarSyncHealth> {
        self.with_calendar_connection(|connection| {
            connection.query_row(
                "SELECT s.id,
                        (SELECT COUNT(*) FROM calendar_operations o WHERE o.source_id=s.id),
                        (SELECT COUNT(*) FROM calendar_conflicts f
                         JOIN calendar_events e ON e.id=f.event_id
                         JOIN calendar_calendars c ON c.id=e.calendar_id
                         WHERE c.source_id=s.id),
                        s.last_sync_at, s.sync_error, s.retry_at
                 FROM calendar_sources s WHERE s.id=?1",
                [source_id],
                |row| {
                    Ok(CalendarSyncHealth {
                        source_id: row.get(0)?,
                        pending_count: row.get(1)?,
                        conflict_count: row.get(2)?,
                        last_sync_at: row.get(3)?,
                        error_code: row.get(4)?,
                        retry_at: row.get(5)?,
                    })
                },
            )
        })
    }

    pub fn calendar_reminder_candidates(
        &self,
        window_start: &str,
        window_end: &str,
    ) -> rusqlite::Result<Vec<ReminderCandidate>> {
        self.with_calendar_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT r.id, r.event_id, e.title, e.location, e.start_kind,
                        e.start_value, e.timezone, e.visibility, r.minutes_before
                 FROM calendar_event_reminders r
                 JOIN calendar_events e ON e.id=r.event_id
                 WHERE r.delivered_at IS NULL AND e.deleted=0 AND e.status!='cancelled'
                   AND e.start_value>=?1 AND e.start_value<=?2
                 ORDER BY e.start_value, r.minutes_before DESC LIMIT 2000",
            )?;
            let candidates = statement
                .query_map(params![window_start, window_end], |row| {
                    Ok(ReminderCandidate {
                        id: row.get(0)?,
                        event_id: row.get(1)?,
                        title: row.get(2)?,
                        location: row.get(3)?,
                        start: event_moment(row.get(4)?, row.get(5)?),
                        timezone: row.get(6)?,
                        visibility: EventVisibility::parse(&row.get::<_, String>(7)?),
                        minutes_before: row.get(8)?,
                    })
                })?
                .collect();
            candidates
        })
    }

    pub fn mark_calendar_reminder_delivered(
        &self,
        reminder_id: &str,
        delivered_at: i64,
    ) -> rusqlite::Result<bool> {
        self.with_calendar_connection(|connection| {
            let changed = connection.execute(
                "UPDATE calendar_event_reminders SET delivered_at=?2
                 WHERE id=?1 AND delivered_at IS NULL",
                params![reminder_id, delivered_at],
            )?;
            Ok(changed == 1)
        })
    }
}
