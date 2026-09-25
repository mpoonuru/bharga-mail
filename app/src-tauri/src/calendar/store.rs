//! Calendar persistence and atomic offline mutation queue.

use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use uuid::Uuid;

use super::domain::{
    AttendeeRole, Calendar, CalendarAccessRole, CalendarAuthState, CalendarEvent,
    CalendarOperation, CalendarProvider, CalendarSource, EventAttendee, EventMoment, EventMutation,
    EventRange, EventReminder, EventStatus, EventSyncState, EventVisibility, OperationKind,
    ParticipationStatus, ReminderMethod, Transparency,
};
use crate::store::Store;

const MAX_TITLE_BYTES: usize = 512;
const MAX_DESCRIPTION_BYTES: usize = 100_000;
const MAX_LOCATION_BYTES: usize = 4_096;
const MAX_URL_BYTES: usize = 8_192;
const MAX_ATTENDEES: usize = 500;
const MAX_REMINDERS: usize = 20;
const MAX_RECURRENCE_VALUES: usize = 128;

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

impl Store {
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

    pub fn create_calendar_event(&self, input: EventMutation) -> rusqlite::Result<CalendarEvent> {
        let input = validate_mutation(&input)?;
        self.with_calendar_transaction(|tx| {
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
            let uid = format!("{}@bharga.local", Uuid::new_v4());
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
                         ?11, ?12, ?13, ?14, NULL, NULL, ?15, ?16, ?17, ?18,
                         0, NULL, 1, 'pending', 0, ?19, ?19)",
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
                    input.status.as_str(),
                    input.transparency.as_str(),
                    input.visibility.as_str(),
                    input.organizer.as_ref().map(encode).transpose()?,
                    now,
                ],
            )?;
            replace_people_and_reminders(tx, &id, &input.attendees, &input.reminders)?;
            let event =
                read_event(tx, &id)?.ok_or_else(|| invalid("created event was not found"))?;
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
            let event =
                read_event(tx, id)?.ok_or_else(|| invalid("updated event was not found"))?;
            queue_operation(tx, &source_id, &event, OperationKind::Update)?;
            Ok(event)
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
}
