//! Bounded RFC 5545 and iTIP interoperability for calendar files and invitations.

use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

use chrono::{
    DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, Offset, SecondsFormat, TimeZone, Utc,
};
use icalendar::{
    Alarm, Calendar as IcalCalendar, CalendarComponent, CalendarDateTime, Component,
    DatePerhapsTime, Event as IcalEvent, EventLike, Property,
};
use serde::{Deserialize, Serialize};

use super::domain::{
    AttendeeRole, CalendarEvent, EventAttendee, EventMoment, EventPerson, EventRange,
    EventReminder, EventStatus, EventSyncState, EventVisibility, ParticipationStatus,
    RecurrenceSet, ReminderMethod, Transparency,
};
use super::recurrence::{expand_event, CalendarError};

pub const MAX_ICS_BYTES: usize = 4 * 1024 * 1024;
const IMPORT_CALENDAR_ID: &str = "ics-import";

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_bytes: usize,
    pub max_events: usize,
    pub max_properties: usize,
    pub max_line_bytes: usize,
    pub max_component_depth: usize,
    pub max_unknown_properties_per_event: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_bytes: MAX_ICS_BYTES,
            max_events: 2_000,
            max_properties: 50_000,
            max_line_bytes: 16_384,
            max_component_depth: 16,
            max_unknown_properties_per_event: 64,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum ItipMethod {
    Publish,
    Request,
    Reply,
    Cancel,
}

impl ItipMethod {
    fn as_str(self) -> &'static str {
        match self {
            Self::Publish => "PUBLISH",
            Self::Request => "REQUEST",
            Self::Reply => "REPLY",
            Self::Cancel => "CANCEL",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_uppercase().as_str() {
            "PUBLISH" => Some(Self::Publish),
            "REQUEST" => Some(Self::Request),
            "REPLY" => Some(Self::Reply),
            "CANCEL" => Some(Self::Cancel),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreservedProperty {
    pub name: String,
    pub value: String,
    pub parameters: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedEvent {
    pub event: CalendarEvent,
    pub preserved_properties: Vec<PreservedProperty>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedCalendar {
    pub method: Option<ItipMethod>,
    pub timezones: Vec<String>,
    pub events: Vec<ParsedEvent>,
}

#[derive(Debug, Clone)]
pub struct ExportOptions {
    pub method: ItipMethod,
    pub product_id: String,
    pub calendar_name: Option<String>,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            method: ItipMethod::Publish,
            product_id: "-//Bharga Mail//Calendar 1.0//EN".into(),
            calendar_name: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ItipActor {
    pub name: Option<String>,
    pub email: String,
    pub participation_status: ParticipationStatus,
}

fn calendar_error(code: &'static str, message: impl Into<String>) -> CalendarError {
    CalendarError::new(code, message)
}

fn calendar_property<'a>(calendar: &'a IcalCalendar, name: &str) -> Option<&'a Property> {
    calendar
        .properties
        .iter()
        .find(|property| property.key().eq_ignore_ascii_case(name))
}

fn validate_source(bytes: &[u8], limits: Limits) -> Result<String, CalendarError> {
    if bytes.len() > limits.max_bytes {
        return Err(calendar_error(
            "ics-too-large",
            format!("Calendar data exceeds {} bytes", limits.max_bytes),
        ));
    }
    let source = std::str::from_utf8(bytes)
        .map_err(|_| calendar_error("invalid-ics", "Calendar data must be UTF-8"))?;
    if source.chars().any(|character| {
        character == '\0' || (character.is_control() && !matches!(character, '\r' | '\n' | '\t'))
    }) {
        return Err(calendar_error(
            "invalid-ics",
            "Calendar data contains disallowed control characters",
        ));
    }

    let unfolded = icalendar::parser::unfold(source);
    let mut property_count = 0usize;
    let mut depth = 0usize;
    for line in unfolded.lines() {
        if line.len() > limits.max_line_bytes {
            return Err(calendar_error(
                "ics-line-too-large",
                "Calendar content line exceeds the supported size",
            ));
        }
        property_count += 1;
        if property_count > limits.max_properties {
            return Err(calendar_error(
                "ics-too-complex",
                "Calendar has too many content lines",
            ));
        }
        if line.starts_with("BEGIN:") {
            depth += 1;
            if depth > limits.max_component_depth {
                return Err(calendar_error(
                    "ics-too-complex",
                    "Calendar component nesting is too deep",
                ));
            }
        } else if line.starts_with("END:") {
            depth = depth.saturating_sub(1);
        }
    }
    if depth != 0 {
        return Err(calendar_error(
            "invalid-ics",
            "Calendar components are not balanced",
        ));
    }
    Ok(source.to_string())
}

fn unescape_text(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut characters = value.chars();
    while let Some(character) = characters.next() {
        if character != '\\' {
            output.push(character);
            continue;
        }
        match characters.next() {
            Some('n' | 'N') => output.push('\n'),
            Some('\\') => output.push('\\'),
            Some(',') => output.push(','),
            Some(';') => output.push(';'),
            Some(other) => output.push(other),
            None => output.push('\\'),
        }
    }
    output
}

fn parameter<'a>(property: &'a Property, name: &str) -> Option<&'a str> {
    property
        .params()
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.value())
}

fn local_to_utc(
    local: NaiveDateTime,
    timezone: &str,
    label: &str,
) -> Result<DateTime<Utc>, CalendarError> {
    let timezone = timezone
        .parse::<chrono_tz::Tz>()
        .map_err(|_| calendar_error("invalid-timezone", format!("{label} has an unknown TZID")))?;
    timezone
        .from_local_datetime(&local)
        .earliest()
        .map(|value| value.with_timezone(&Utc))
        .ok_or_else(|| {
            calendar_error(
                "invalid-time",
                format!("{label} falls in a nonexistent local time"),
            )
        })
}

fn parse_moment(
    property: &Property,
    fallback_timezone: Option<&str>,
    label: &str,
) -> Result<(EventMoment, Option<String>), CalendarError> {
    match DatePerhapsTime::from_property(property)
        .ok_or_else(|| calendar_error("invalid-time", format!("{label} is invalid")))?
    {
        DatePerhapsTime::Date(date) => Ok((
            EventMoment::AllDay {
                date: date.format("%Y-%m-%d").to_string(),
            },
            None,
        )),
        DatePerhapsTime::DateTime(CalendarDateTime::Utc(value)) => Ok((
            EventMoment::Timed {
                utc: value.to_rfc3339_opts(SecondsFormat::Secs, true),
            },
            Some("UTC".into()),
        )),
        DatePerhapsTime::DateTime(CalendarDateTime::WithTimezone { date_time, tzid }) => {
            let utc = local_to_utc(date_time, &tzid, label)?;
            Ok((
                EventMoment::Timed {
                    utc: utc.to_rfc3339_opts(SecondsFormat::Secs, true),
                },
                Some(tzid),
            ))
        }
        DatePerhapsTime::DateTime(CalendarDateTime::Floating(value)) => {
            let timezone = fallback_timezone.ok_or_else(|| {
                calendar_error(
                    "invalid-timezone",
                    format!("{label} is floating and no calendar timezone is defined"),
                )
            })?;
            let utc = local_to_utc(value, timezone, label)?;
            Ok((
                EventMoment::Timed {
                    utc: utc.to_rfc3339_opts(SecondsFormat::Secs, true),
                },
                Some(timezone.to_string()),
            ))
        }
    }
}

fn parse_recurrence_value(
    property: &Property,
    value: &str,
    fallback_timezone: &str,
    all_day: bool,
) -> Result<String, CalendarError> {
    if all_day {
        let date = NaiveDate::parse_from_str(value, "%Y%m%d")
            .map_err(|_| calendar_error("invalid-recurrence", "RDATE/EXDATE date is invalid"))?;
        return Ok(date.format("%Y-%m-%d").to_string());
    }
    if let Ok(value) = NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%SZ") {
        return Ok(Utc
            .from_utc_datetime(&value)
            .to_rfc3339_opts(SecondsFormat::Secs, true));
    }
    let local = NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S")
        .map_err(|_| calendar_error("invalid-recurrence", "RDATE/EXDATE timestamp is invalid"))?;
    let timezone = parameter(property, "TZID").unwrap_or(fallback_timezone);
    Ok(local_to_utc(local, timezone, "RDATE/EXDATE")?.to_rfc3339_opts(SecondsFormat::Secs, true))
}

fn properties_named<'a>(event: &'a IcalEvent, name: &str) -> Vec<&'a Property> {
    let mut values = Vec::new();
    if let Some(property) = event.properties().get(name) {
        values.push(property);
    }
    if let Some(properties) = event.multi_properties().get(name) {
        values.extend(properties);
    }
    values
}

fn mail_address(value: &str) -> Result<String, CalendarError> {
    let value = value.trim();
    let value = value
        .strip_prefix("mailto:")
        .or_else(|| value.strip_prefix("MAILTO:"))
        .unwrap_or(value)
        .trim();
    if value.len() > 320 || !value.contains('@') || value.contains(['\r', '\n']) {
        return Err(calendar_error(
            "invalid-attendee",
            "Calendar attendee address is invalid",
        ));
    }
    Ok(value.to_ascii_lowercase())
}

fn attendee_role(value: Option<&str>) -> AttendeeRole {
    match value.unwrap_or_default().to_ascii_uppercase().as_str() {
        "OPT-PARTICIPANT" => AttendeeRole::Optional,
        "CHAIR" => AttendeeRole::Chair,
        "NON-PARTICIPANT" => AttendeeRole::NonParticipant,
        _ => AttendeeRole::Required,
    }
}

fn participation(value: Option<&str>) -> ParticipationStatus {
    match value.unwrap_or_default().to_ascii_uppercase().as_str() {
        "ACCEPTED" => ParticipationStatus::Accepted,
        "DECLINED" => ParticipationStatus::Declined,
        "TENTATIVE" => ParticipationStatus::Tentative,
        "DELEGATED" => ParticipationStatus::Delegated,
        _ => ParticipationStatus::NeedsAction,
    }
}

fn parse_attendees(event: &IcalEvent) -> Result<Vec<EventAttendee>, CalendarError> {
    properties_named(event, "ATTENDEE")
        .into_iter()
        .map(|property| {
            Ok(EventAttendee {
                name: parameter(property, "CN").map(unescape_text),
                email: mail_address(property.value())?,
                role: attendee_role(parameter(property, "ROLE")),
                status: participation(parameter(property, "PARTSTAT")),
                rsvp: parameter(property, "RSVP")
                    .is_some_and(|value| value.eq_ignore_ascii_case("TRUE")),
                comment: parameter(property, "X-RESPONSE-COMMENT").map(unescape_text),
            })
        })
        .collect()
}

fn parse_organizer(event: &IcalEvent) -> Result<Option<EventPerson>, CalendarError> {
    event
        .properties()
        .get("ORGANIZER")
        .map(|property| {
            Ok(EventPerson {
                name: parameter(property, "CN").map(unescape_text),
                email: mail_address(property.value())?,
            })
        })
        .transpose()
}

fn parse_duration_minutes(value: &str) -> Result<i64, CalendarError> {
    let Some(mut rest) = value.strip_prefix("-P") else {
        return Err(calendar_error(
            "unsupported-alarm",
            "Only reminders before an event are supported",
        ));
    };
    let mut days = 0i64;
    let mut hours = 0i64;
    let mut minutes = 0i64;
    let mut seconds = 0i64;
    let mut number = String::new();
    let mut in_time = false;
    while let Some(character) = rest.chars().next() {
        rest = &rest[character.len_utf8()..];
        if character == 'T' {
            in_time = true;
            continue;
        }
        if character.is_ascii_digit() {
            number.push(character);
            continue;
        }
        let value = number
            .parse::<i64>()
            .map_err(|_| calendar_error("invalid-alarm", "VALARM duration is invalid"))?;
        number.clear();
        match (in_time, character) {
            (false, 'W') => days += value * 7,
            (false, 'D') => days += value,
            (true, 'H') => hours += value,
            (true, 'M') => minutes += value,
            (true, 'S') => seconds += value,
            _ => {
                return Err(calendar_error(
                    "invalid-alarm",
                    "VALARM duration is invalid",
                ))
            }
        }
    }
    if !number.is_empty() {
        return Err(calendar_error(
            "invalid-alarm",
            "VALARM duration is invalid",
        ));
    }
    let total_seconds = days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
    Ok((total_seconds + 59) / 60)
}

fn parse_reminders(event: &IcalEvent) -> Result<Vec<EventReminder>, CalendarError> {
    let mut reminders = Vec::new();
    for component in event
        .components()
        .iter()
        .filter(|component| component.component_kind() == "VALARM")
    {
        let action = component
            .property_value("ACTION")
            .unwrap_or("DISPLAY")
            .to_ascii_uppercase();
        if action != "DISPLAY" && action != "EMAIL" {
            continue;
        }
        let trigger = component
            .property_value("TRIGGER")
            .ok_or_else(|| calendar_error("invalid-alarm", "VALARM is missing TRIGGER"))?;
        reminders.push(EventReminder {
            id: None,
            method: if action == "EMAIL" {
                ReminderMethod::Email
            } else {
                ReminderMethod::Display
            },
            minutes_before: parse_duration_minutes(trigger)?,
        });
        if reminders.len() > 20 {
            return Err(calendar_error(
                "ics-too-complex",
                "Calendar event has too many reminders",
            ));
        }
    }
    Ok(reminders)
}

fn known_property(name: &str) -> bool {
    matches!(
        name,
        "UID"
            | "DTSTAMP"
            | "SEQUENCE"
            | "DTSTART"
            | "DTEND"
            | "DURATION"
            | "SUMMARY"
            | "DESCRIPTION"
            | "LOCATION"
            | "URL"
            | "ORGANIZER"
            | "ATTENDEE"
            | "RRULE"
            | "RDATE"
            | "EXDATE"
            | "RECURRENCE-ID"
            | "STATUS"
            | "TRANSP"
            | "CLASS"
            | "CREATED"
            | "LAST-MODIFIED"
            | "CATEGORIES"
    )
}

fn preserve_property(
    property: &Property,
    limits: Limits,
) -> Result<Option<PreservedProperty>, CalendarError> {
    let name = property.key().to_ascii_uppercase();
    if known_property(&name) {
        return Ok(None);
    }
    if name.is_empty()
        || name.len() > 64
        || !name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
        || property.value().len() > 4_096
        || property.value().contains(['\r', '\n', '\0'])
        || property.params().len() > 16
    {
        return Err(calendar_error(
            "invalid-property",
            "Calendar contains an unsafe extension property",
        ));
    }
    let mut parameters = BTreeMap::new();
    for (key, value) in property.params() {
        if key.len() > 64
            || value.value().len() > 1_024
            || value.value().contains(['\r', '\n', '\0'])
        {
            return Err(calendar_error(
                "invalid-property",
                "Calendar contains an unsafe extension parameter",
            ));
        }
        parameters.insert(key.clone(), value.value().to_string());
    }
    if parameters.len() > limits.max_unknown_properties_per_event {
        return Err(calendar_error(
            "ics-too-complex",
            "Calendar extension property limit exceeded",
        ));
    }
    Ok(Some(PreservedProperty {
        name,
        value: property.value().to_string(),
        parameters,
    }))
}

fn parse_event(
    event: &IcalEvent,
    calendar_timezone: Option<&str>,
    limits: Limits,
) -> Result<ParsedEvent, CalendarError> {
    let uid = event
        .property_value("UID")
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 1_024)
        .ok_or_else(|| calendar_error("missing-property", "VEVENT is missing a valid UID"))?
        .to_string();
    let start_property = event
        .properties()
        .get("DTSTART")
        .ok_or_else(|| calendar_error("missing-property", "VEVENT is missing DTSTART"))?;
    let (start, start_timezone) = parse_moment(start_property, calendar_timezone, "DTSTART")?;
    let timezone = start_timezone
        .or_else(|| calendar_timezone.map(str::to_string))
        .unwrap_or_else(|| "UTC".into());
    let end_property = event
        .properties()
        .get("DTEND")
        .ok_or_else(|| calendar_error("missing-property", "VEVENT is missing DTEND"))?;
    let (end, _) = parse_moment(end_property, Some(&timezone), "DTEND")?;
    if std::mem::discriminant(&start) != std::mem::discriminant(&end) {
        return Err(calendar_error(
            "invalid-time-shape",
            "VEVENT DTSTART and DTEND must both be DATE or DATE-TIME",
        ));
    }

    let all_day = matches!(start, EventMoment::AllDay { .. });
    let mut recurrence = RecurrenceSet::default();
    recurrence.rules = properties_named(event, "RRULE")
        .into_iter()
        .map(|property| property.value().trim().to_string())
        .collect();
    for property in properties_named(event, "RDATE") {
        for value in property.value().split(',') {
            recurrence.dates.push(parse_recurrence_value(
                property,
                value.trim(),
                &timezone,
                all_day,
            )?);
        }
    }
    for property in properties_named(event, "EXDATE") {
        for value in property.value().split(',') {
            recurrence.excluded_dates.push(parse_recurrence_value(
                property,
                value.trim(),
                &timezone,
                all_day,
            )?);
        }
    }
    recurrence.dates.sort();
    recurrence.dates.dedup();
    recurrence.excluded_dates.sort();
    recurrence.excluded_dates.dedup();
    let recurrence = (!recurrence.rules.is_empty()
        || !recurrence.dates.is_empty()
        || !recurrence.excluded_dates.is_empty())
    .then_some(recurrence);

    let recurrence_id = event
        .properties()
        .get("RECURRENCE-ID")
        .map(|property| parse_recurrence_value(property, property.value(), &timezone, all_day))
        .transpose()?;
    let title = event
        .property_value("SUMMARY")
        .map(unescape_text)
        .unwrap_or_else(|| "(Untitled event)".into());
    if title.len() > 512 {
        return Err(calendar_error(
            "invalid-property",
            "VEVENT summary is too large",
        ));
    }

    let status = match event
        .property_value("STATUS")
        .unwrap_or("CONFIRMED")
        .to_ascii_uppercase()
        .as_str()
    {
        "TENTATIVE" => EventStatus::Tentative,
        "CANCELLED" => EventStatus::Cancelled,
        _ => EventStatus::Confirmed,
    };
    let visibility = match event
        .property_value("CLASS")
        .unwrap_or("DEFAULT")
        .to_ascii_uppercase()
        .as_str()
    {
        "PUBLIC" => EventVisibility::Public,
        "PRIVATE" => EventVisibility::Private,
        "CONFIDENTIAL" => EventVisibility::Confidential,
        _ => EventVisibility::Default,
    };
    let transparency = if event
        .property_value("TRANSP")
        .is_some_and(|value| value.eq_ignore_ascii_case("TRANSPARENT"))
    {
        Transparency::Free
    } else {
        Transparency::Busy
    };
    let sequence = event
        .property_value("SEQUENCE")
        .unwrap_or("0")
        .parse::<i64>()
        .map_err(|_| calendar_error("invalid-property", "VEVENT SEQUENCE is invalid"))?;

    let mut preserved_properties = Vec::new();
    for property in event.properties().values() {
        if let Some(property) = preserve_property(property, limits)? {
            preserved_properties.push(property);
        }
    }
    for property in event.multi_properties().values().flatten() {
        if let Some(property) = preserve_property(property, limits)? {
            preserved_properties.push(property);
        }
    }
    if preserved_properties.len() > limits.max_unknown_properties_per_event {
        return Err(calendar_error(
            "ics-too-complex",
            "Calendar extension property limit exceeded",
        ));
    }
    preserved_properties.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.value.cmp(&right.value))
    });

    let id = recurrence_id
        .as_ref()
        .map(|value| format!("ics:{uid}:{value}"))
        .unwrap_or_else(|| format!("ics:{uid}"));
    let calendar_event = CalendarEvent {
        id,
        calendar_id: IMPORT_CALENDAR_ID.into(),
        uid,
        provider_id: None,
        title,
        description: event
            .property_value("DESCRIPTION")
            .map(unescape_text)
            .unwrap_or_default(),
        location: event
            .property_value("LOCATION")
            .map(unescape_text)
            .unwrap_or_default(),
        conference_url: event.property_value("URL").map(str::to_string),
        source_thread_id: None,
        start,
        end,
        timezone,
        recurrence,
        recurrence_id,
        parent_event_id: None,
        status,
        transparency,
        visibility,
        organizer: parse_organizer(event)?,
        attendees: parse_attendees(event)?,
        reminders: parse_reminders(event)?,
        sequence,
        provider_version: None,
        revision: 1,
        sync_state: EventSyncState::Local,
        deleted: false,
    };

    if calendar_event.recurrence.is_some() && calendar_event.recurrence_id.is_none() {
        let range_start = match &calendar_event.start {
            EventMoment::Timed { utc } => DateTime::parse_from_rfc3339(utc)
                .map(|value| value.with_timezone(&Utc))
                .map_err(|_| calendar_error("invalid-time", "VEVENT DTSTART is invalid"))?,
            EventMoment::AllDay { date } => {
                let date = NaiveDate::parse_from_str(date, "%Y-%m-%d")
                    .map_err(|_| calendar_error("invalid-time", "VEVENT DTSTART is invalid"))?;
                Utc.from_utc_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
            }
        };
        let range = EventRange {
            start: range_start.to_rfc3339_opts(SecondsFormat::Secs, true),
            end: (range_start + Duration::days(366)).to_rfc3339_opts(SecondsFormat::Secs, true),
        };
        expand_event(&calendar_event, &range, 512)?;
    }

    Ok(ParsedEvent {
        event: calendar_event,
        preserved_properties,
    })
}

pub fn parse_calendar(bytes: &[u8], limits: Limits) -> Result<ParsedCalendar, CalendarError> {
    let source = validate_source(bytes, limits)?;
    let calendar = IcalCalendar::from_str(&source).map_err(|error| {
        calendar_error("invalid-ics", format!("Calendar parsing failed: {error}"))
    })?;
    let event_count = calendar.events().count();
    if event_count > limits.max_events {
        return Err(calendar_error(
            "ics-too-complex",
            "Calendar contains too many events",
        ));
    }

    let calendar_timezone = calendar_property(&calendar, "X-WR-TIMEZONE")
        .or_else(|| calendar_property(&calendar, "TIMEZONE-ID"))
        .map(Property::value);
    if let Some(timezone) = calendar_timezone {
        timezone.parse::<chrono_tz::Tz>().map_err(|_| {
            calendar_error("invalid-timezone", "Calendar default timezone is unknown")
        })?;
    }
    let mut timezones = calendar
        .components
        .iter()
        .filter_map(|component| match component {
            CalendarComponent::Other(other) if other.component_kind() == "VTIMEZONE" => {
                other.property_value("TZID").map(str::to_string)
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    timezones.sort();
    timezones.dedup();

    let mut events = Vec::with_capacity(event_count);
    for event in calendar.events() {
        events.push(parse_event(event, calendar_timezone, limits)?);
    }
    Ok(ParsedCalendar {
        method: calendar_property(&calendar, "METHOD")
            .and_then(|value| ItipMethod::parse(value.value())),
        timezones,
        events,
    })
}

fn attendee_role_text(role: AttendeeRole) -> &'static str {
    match role {
        AttendeeRole::Required => "REQ-PARTICIPANT",
        AttendeeRole::Optional => "OPT-PARTICIPANT",
        AttendeeRole::Chair => "CHAIR",
        AttendeeRole::NonParticipant => "NON-PARTICIPANT",
    }
}

fn participation_text(status: ParticipationStatus) -> &'static str {
    match status {
        ParticipationStatus::NeedsAction => "NEEDS-ACTION",
        ParticipationStatus::Accepted => "ACCEPTED",
        ParticipationStatus::Declined => "DECLINED",
        ParticipationStatus::Tentative => "TENTATIVE",
        ParticipationStatus::Delegated => "DELEGATED",
    }
}

fn property_with_parameters(
    name: &str,
    value: impl Into<String>,
    parameters: &[(&str, String)],
) -> Property {
    let mut property = Property::new(name, value);
    for (key, value) in parameters {
        property.add_parameter(key, value);
    }
    property.done()
}

fn timed_property(name: &str, utc: &str, timezone: &str) -> Result<Property, CalendarError> {
    let utc = DateTime::parse_from_rfc3339(utc)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| calendar_error("invalid-time", format!("{name} is invalid")))?;
    if timezone == "UTC" {
        return Ok(Property::new(
            name,
            utc.format("%Y%m%dT%H%M%SZ").to_string(),
        ));
    }
    let timezone_value = timezone.parse::<chrono_tz::Tz>().map_err(|_| {
        calendar_error("invalid-timezone", "Event timezone is not an IANA timezone")
    })?;
    Ok(property_with_parameters(
        name,
        utc.with_timezone(&timezone_value)
            .format("%Y%m%dT%H%M%S")
            .to_string(),
        &[("TZID", timezone.to_string())],
    ))
}

fn append_moment(
    event: &mut IcalEvent,
    name: &str,
    moment: &EventMoment,
    timezone: &str,
) -> Result<(), CalendarError> {
    let property = match moment {
        EventMoment::Timed { utc } => timed_property(name, utc, timezone)?,
        EventMoment::AllDay { date } => {
            let date = NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .map_err(|_| calendar_error("invalid-time", format!("{name} is invalid")))?;
            property_with_parameters(
                name,
                date.format("%Y%m%d").to_string(),
                &[("VALUE", "DATE".into())],
            )
        }
    };
    event.append_property(property);
    Ok(())
}

fn append_recurrence_values(
    event: &mut IcalEvent,
    name: &str,
    values: &[String],
    timezone: &str,
    all_day: bool,
) -> Result<(), CalendarError> {
    if values.is_empty() {
        return Ok(());
    }
    let mut encoded = Vec::with_capacity(values.len());
    for value in values {
        if all_day {
            let date = NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .map_err(|_| calendar_error("invalid-recurrence", "Recurrence date is invalid"))?;
            encoded.push(date.format("%Y%m%d").to_string());
        } else {
            let utc = DateTime::parse_from_rfc3339(value)
                .map(|value| value.with_timezone(&Utc))
                .map_err(|_| {
                    calendar_error("invalid-recurrence", "Recurrence timestamp is invalid")
                })?;
            if timezone == "UTC" {
                encoded.push(utc.format("%Y%m%dT%H%M%SZ").to_string());
            } else {
                let timezone_value = timezone
                    .parse::<chrono_tz::Tz>()
                    .map_err(|_| calendar_error("invalid-timezone", "Event timezone is invalid"))?;
                encoded.push(
                    utc.with_timezone(&timezone_value)
                        .format("%Y%m%dT%H%M%S")
                        .to_string(),
                );
            }
        }
    }
    let parameters = if all_day {
        vec![("VALUE", "DATE".into())]
    } else if timezone != "UTC" {
        vec![("TZID", timezone.to_string())]
    } else {
        Vec::new()
    };
    event.append_multi_property(property_with_parameters(
        name,
        encoded.join(","),
        &parameters,
    ));
    Ok(())
}

fn offset_text(seconds: i32) -> String {
    let sign = if seconds < 0 { '-' } else { '+' };
    let seconds = seconds.abs();
    format!("{sign}{:02}{:02}", seconds / 3_600, (seconds % 3_600) / 60)
}

fn timezone_component(
    timezone_name: &str,
    years: &BTreeSet<i32>,
) -> Result<CalendarComponent, CalendarError> {
    let timezone = timezone_name.parse::<chrono_tz::Tz>().map_err(|_| {
        calendar_error("invalid-timezone", "Event timezone is not an IANA timezone")
    })?;
    let first_year = years
        .iter()
        .next()
        .copied()
        .unwrap_or_else(|| Utc::now().year())
        - 1;
    let last_year = years.iter().next_back().copied().unwrap_or(first_year + 1) + 1;
    let start = Utc
        .with_ymd_and_hms(first_year, 1, 1, 0, 0, 0)
        .single()
        .ok_or_else(|| calendar_error("invalid-timezone", "Timezone year is invalid"))?;
    let end = Utc
        .with_ymd_and_hms(last_year + 1, 1, 1, 0, 0, 0)
        .single()
        .ok_or_else(|| calendar_error("invalid-timezone", "Timezone year is invalid"))?;

    let mut transitions: Vec<(bool, NaiveDateTime, i32, i32)> = Vec::new();
    let mut cursor = start;
    let mut previous = cursor
        .with_timezone(&timezone)
        .offset()
        .fix()
        .local_minus_utc();
    while cursor < end {
        cursor += Duration::hours(1);
        let next = cursor
            .with_timezone(&timezone)
            .offset()
            .fix()
            .local_minus_utc();
        if next != previous {
            transitions.push((
                next > previous,
                (cursor + Duration::seconds(i64::from(next))).naive_utc(),
                previous,
                next,
            ));
            previous = next;
        }
    }

    let mut output =
        format!("BEGIN:VTIMEZONE\r\nTZID:{timezone_name}\r\nX-LIC-LOCATION:{timezone_name}\r\n");
    if transitions.is_empty() {
        let offset = start
            .with_timezone(&timezone)
            .offset()
            .fix()
            .local_minus_utc();
        output.push_str(&format!(
            "BEGIN:STANDARD\r\nDTSTART:{first_year}0101T000000\r\nTZOFFSETFROM:{}\r\nTZOFFSETTO:{}\r\nTZNAME:{timezone_name}\r\nEND:STANDARD\r\n",
            offset_text(offset),
            offset_text(offset),
        ));
    } else {
        for daylight in [true, false] {
            let matching = transitions
                .iter()
                .filter(|transition| transition.0 == daylight)
                .collect::<Vec<_>>();
            if matching.is_empty() {
                continue;
            }
            let kind = if daylight { "DAYLIGHT" } else { "STANDARD" };
            let first = matching[0];
            output.push_str(&format!(
                "BEGIN:{kind}\r\nDTSTART:{}\r\nTZOFFSETFROM:{}\r\nTZOFFSETTO:{}\r\nTZNAME:{timezone_name}\r\n",
                first.1.format("%Y%m%dT%H%M%S"),
                offset_text(first.2),
                offset_text(first.3),
            ));
            if matching.len() > 1 {
                output.push_str("RDATE:");
                output.push_str(
                    &matching[1..]
                        .iter()
                        .map(|transition| transition.1.format("%Y%m%dT%H%M%S").to_string())
                        .collect::<Vec<_>>()
                        .join(","),
                );
                output.push_str("\r\n");
            }
            output.push_str(&format!("END:{kind}\r\n"));
        }
    }
    output.push_str("END:VTIMEZONE\r\n");
    CalendarComponent::from_str(&output).map_err(|error| {
        calendar_error(
            "invalid-timezone",
            format!("Timezone component could not be generated: {error}"),
        )
    })
}

fn event_year(event: &CalendarEvent) -> Result<i32, CalendarError> {
    match &event.start {
        EventMoment::Timed { utc } => DateTime::parse_from_rfc3339(utc)
            .map(|value| value.year())
            .map_err(|_| calendar_error("invalid-time", "Event start is invalid")),
        EventMoment::AllDay { date } => NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .map(|value| value.year())
            .map_err(|_| calendar_error("invalid-time", "Event start is invalid")),
    }
}

fn to_ical_event(parsed: &ParsedEvent) -> Result<IcalEvent, CalendarError> {
    let source = &parsed.event;
    let mut event = IcalEvent::with_uid(&source.uid);
    event.append_property(Property::new("SUMMARY", &source.title));
    if !source.description.is_empty() {
        event.append_property(Property::new("DESCRIPTION", &source.description));
    }
    if !source.location.is_empty() {
        event.append_property(Property::new("LOCATION", &source.location));
    }
    if let Some(url) = &source.conference_url {
        event.append_property(Property::new("URL", url));
    }
    event.append_property(Property::new("SEQUENCE", source.sequence.to_string()));
    event.append_property(Property::new(
        "DTSTAMP",
        Utc::now().format("%Y%m%dT%H%M%SZ").to_string(),
    ));
    append_moment(&mut event, "DTSTART", &source.start, &source.timezone)?;
    append_moment(&mut event, "DTEND", &source.end, &source.timezone)?;
    if let Some(recurrence_id) = &source.recurrence_id {
        if matches!(source.start, EventMoment::AllDay { .. }) {
            let date = NaiveDate::parse_from_str(recurrence_id, "%Y-%m-%d").map_err(|_| {
                calendar_error("invalid-recurrence", "RECURRENCE-ID date is invalid")
            })?;
            event.append_property(property_with_parameters(
                "RECURRENCE-ID",
                date.format("%Y%m%d").to_string(),
                &[("VALUE", "DATE".into())],
            ));
        } else {
            event.append_property(timed_property(
                "RECURRENCE-ID",
                recurrence_id,
                &source.timezone,
            )?);
        }
    }
    if let Some(recurrence) = &source.recurrence {
        for rule in &recurrence.rules {
            event.append_multi_property(Property::new(
                "RRULE",
                rule.trim().strip_prefix("RRULE:").unwrap_or(rule.trim()),
            ));
        }
        let all_day = matches!(source.start, EventMoment::AllDay { .. });
        append_recurrence_values(
            &mut event,
            "RDATE",
            &recurrence.dates,
            &source.timezone,
            all_day,
        )?;
        append_recurrence_values(
            &mut event,
            "EXDATE",
            &recurrence.excluded_dates,
            &source.timezone,
            all_day,
        )?;
    }

    event.append_property(Property::new(
        "STATUS",
        match source.status {
            EventStatus::Tentative => "TENTATIVE",
            EventStatus::Confirmed => "CONFIRMED",
            EventStatus::Cancelled => "CANCELLED",
        },
    ));
    event.append_property(Property::new(
        "TRANSP",
        if source.transparency == Transparency::Free {
            "TRANSPARENT"
        } else {
            "OPAQUE"
        },
    ));
    if source.visibility != EventVisibility::Default {
        event.append_property(Property::new(
            "CLASS",
            match source.visibility {
                EventVisibility::Public => "PUBLIC",
                EventVisibility::Private => "PRIVATE",
                EventVisibility::Confidential => "CONFIDENTIAL",
                EventVisibility::Default => unreachable!(),
            },
        ));
    }
    if let Some(organizer) = &source.organizer {
        let mut property = Property::new("ORGANIZER", format!("mailto:{}", organizer.email));
        if let Some(name) = &organizer.name {
            property.add_parameter("CN", name);
        }
        event.append_property(property.done());
    }
    for attendee in &source.attendees {
        let mut property = Property::new("ATTENDEE", format!("mailto:{}", attendee.email));
        if let Some(name) = &attendee.name {
            property.add_parameter("CN", name);
        }
        property
            .add_parameter("ROLE", attendee_role_text(attendee.role))
            .add_parameter("PARTSTAT", participation_text(attendee.status))
            .add_parameter("RSVP", if attendee.rsvp { "TRUE" } else { "FALSE" });
        if let Some(comment) = &attendee.comment {
            property.add_parameter("X-RESPONSE-COMMENT", comment);
        }
        event.append_multi_property(property.done());
    }
    for reminder in &source.reminders {
        let trigger = -Duration::minutes(reminder.minutes_before);
        match reminder.method {
            ReminderMethod::Display => {
                event.alarm(Alarm::display(&source.title, trigger));
            }
            ReminderMethod::Email => {
                let recipient = source
                    .organizer
                    .as_ref()
                    .map(|organizer| organizer.email.as_str())
                    .or_else(|| {
                        source
                            .attendees
                            .first()
                            .map(|attendee| attendee.email.as_str())
                    })
                    .ok_or_else(|| {
                        calendar_error(
                            "invalid-alarm",
                            "Email reminders require an organizer or attendee",
                        )
                    })?;
                let raw = format!(
                    "BEGIN:VALARM\r\nACTION:EMAIL\r\nTRIGGER:-PT{}M\r\nDESCRIPTION:{}\r\nSUMMARY:{}\r\nATTENDEE:mailto:{}\r\nEND:VALARM\r\n",
                    reminder.minutes_before,
                    source.title.replace(['\r', '\n'], " "),
                    source.title.replace(['\r', '\n'], " "),
                    recipient,
                );
                let component = CalendarComponent::from_str(&raw).map_err(|error| {
                    calendar_error("invalid-alarm", format!("Email alarm is invalid: {error}"))
                })?;
                if let CalendarComponent::Other(other) = component {
                    event.append_component(other);
                }
            }
        }
    }
    for property in &parsed.preserved_properties {
        if known_property(&property.name) {
            continue;
        }
        let parameters = property
            .parameters
            .iter()
            .map(|(key, value)| (key.as_str(), value.clone()))
            .collect::<Vec<_>>();
        event.append_multi_property(property_with_parameters(
            &property.name,
            &property.value,
            &parameters,
        ));
    }
    Ok(event.done())
}

pub fn write_calendar(
    events: &[ParsedEvent],
    options: ExportOptions,
) -> Result<Vec<u8>, CalendarError> {
    if events.len() > Limits::default().max_events {
        return Err(calendar_error(
            "ics-too-complex",
            "Calendar contains too many events",
        ));
    }
    let mut calendar = IcalCalendar {
        properties: vec![
            Property::new("VERSION", "2.0"),
            Property::new("PRODID", options.product_id),
            Property::new("CALSCALE", "GREGORIAN"),
            Property::new("METHOD", options.method.as_str()),
        ],
        components: Vec::new(),
    };
    if let Some(name) = options.calendar_name {
        calendar.append_property(Property::new("X-WR-CALNAME", name));
    }

    let mut timezone_years: BTreeMap<String, BTreeSet<i32>> = BTreeMap::new();
    for parsed in events {
        if parsed.event.timezone != "UTC" && matches!(parsed.event.start, EventMoment::Timed { .. })
        {
            timezone_years
                .entry(parsed.event.timezone.clone())
                .or_default()
                .insert(event_year(&parsed.event)?);
        }
    }
    for (timezone, years) in timezone_years {
        calendar.push(timezone_component(&timezone, &years)?);
    }
    for event in events {
        calendar.push(to_ical_event(event)?);
    }

    let encoded = calendar.to_string().into_bytes();
    if encoded.len() > MAX_ICS_BYTES {
        return Err(calendar_error(
            "ics-too-large",
            "Generated calendar exceeds the supported size",
        ));
    }
    Ok(encoded)
}

pub fn build_itip(
    event: &CalendarEvent,
    method: ItipMethod,
    actor: &ItipActor,
) -> Result<Vec<u8>, CalendarError> {
    let mut event = event.clone();
    event.sequence = event.sequence.saturating_add(1);
    match method {
        ItipMethod::Request | ItipMethod::Publish => {
            event.organizer = Some(EventPerson {
                name: actor.name.clone(),
                email: actor.email.clone(),
            });
        }
        ItipMethod::Reply => {
            let attendee = event
                .attendees
                .iter_mut()
                .find(|attendee| attendee.email.eq_ignore_ascii_case(&actor.email))
                .ok_or_else(|| {
                    calendar_error("invalid-actor", "Reply actor is not an event attendee")
                })?;
            attendee.status = actor.participation_status;
        }
        ItipMethod::Cancel => event.status = EventStatus::Cancelled,
    }
    write_calendar(
        &[ParsedEvent {
            event,
            preserved_properties: Vec::new(),
        }],
        ExportOptions {
            method,
            ..ExportOptions::default()
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_uid_recurrence_timezone_and_attendees() {
        let parsed = parse_calendar(
            include_bytes!("../../tests/fixtures/calendar/google-invite.ics"),
            Limits::default(),
        )
        .unwrap();
        let encoded = write_calendar(&parsed.events, ExportOptions::default()).unwrap();
        let reparsed = parse_calendar(&encoded, Limits::default()).unwrap();

        assert_eq!(parsed.events, reparsed.events);
    }

    #[test]
    fn parses_apple_outlook_and_caldav_interoperability_fixtures() {
        let apple = parse_calendar(
            include_bytes!("../../tests/fixtures/calendar/apple-recurring.ics"),
            Limits::default(),
        )
        .unwrap();
        assert!(matches!(
            apple.events[0].event.start,
            EventMoment::AllDay { .. }
        ));
        assert_eq!(
            apple.events[0]
                .event
                .recurrence
                .as_ref()
                .unwrap()
                .excluded_dates,
            ["2027-10-25"]
        );

        let outlook = parse_calendar(
            include_bytes!("../../tests/fixtures/calendar/outlook-update.ics"),
            Limits::default(),
        )
        .unwrap();
        assert_eq!(
            outlook.events[0].event.recurrence_id.as_deref(),
            Some("2026-11-02T14:00:00Z")
        );
        assert_eq!(outlook.events[0].event.sequence, 4);

        let caldav = parse_calendar(
            include_bytes!("../../tests/fixtures/calendar/caldav-timezone.ics"),
            Limits::default(),
        )
        .unwrap();
        assert_eq!(caldav.timezones, ["Europe/Berlin"]);
        assert_eq!(
            caldav.events[0].preserved_properties[0].name,
            "X-CALDAV-ETAG"
        );
    }

    #[test]
    fn writer_uses_crlf_and_folds_content_lines_to_rfc_limit() {
        let mut parsed = parse_calendar(
            include_bytes!("../../tests/fixtures/calendar/google-invite.ics"),
            Limits::default(),
        )
        .unwrap();
        parsed.events[0].event.title = "Enterprise calendar interoperability ".repeat(8);

        let encoded = write_calendar(&parsed.events, ExportOptions::default()).unwrap();
        let source = String::from_utf8(encoded).unwrap();

        assert!(!source.replace("\r\n", "").contains('\n'));
        assert!(source.split("\r\n").all(|line| line.as_bytes().len() <= 75));
        assert!(source.contains("\r\n "));
    }

    #[test]
    fn builds_parseable_itip_reply_with_incremented_sequence() {
        let parsed = parse_calendar(
            include_bytes!("../../tests/fixtures/calendar/google-invite.ics"),
            Limits::default(),
        )
        .unwrap();
        let encoded = build_itip(
            &parsed.events[0].event,
            ItipMethod::Reply,
            &ItipActor {
                name: Some("Bob Builder".into()),
                email: "bob@example.test".into(),
                participation_status: ParticipationStatus::Accepted,
            },
        )
        .unwrap();
        let reply = parse_calendar(&encoded, Limits::default()).unwrap();

        assert_eq!(reply.method, Some(ItipMethod::Reply));
        assert_eq!(reply.events[0].event.sequence, 3);
        assert_eq!(
            reply.events[0].event.attendees[0].status,
            ParticipationStatus::Accepted
        );
    }

    #[test]
    fn parses_utc_recurrence_dates() {
        let parsed = parse_calendar(
            b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Bharga//Test//EN\r\nBEGIN:VEVENT\r\nUID:utc-rdate@example.test\r\nDTSTART:20260101T090000Z\r\nDTEND:20260101T100000Z\r\nRDATE:20260102T090000Z\r\nEXDATE:20260103T090000Z\r\nSUMMARY:UTC recurrence\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
            Limits::default(),
        )
        .unwrap();
        let recurrence = parsed.events[0].event.recurrence.as_ref().unwrap();

        assert_eq!(recurrence.dates, ["2026-01-02T09:00:00Z"]);
        assert_eq!(recurrence.excluded_dates, ["2026-01-03T09:00:00Z"]);
    }

    #[test]
    fn rejects_oversized_and_pathological_inputs_without_partial_events() {
        assert_eq!(
            parse_calendar(&vec![b'X'; MAX_ICS_BYTES + 1], Limits::default())
                .unwrap_err()
                .code(),
            "ics-too-large"
        );
        assert_eq!(
            parse_calendar(pathological_rrule(), Limits::default())
                .unwrap_err()
                .code(),
            "recurrence-limit"
        );
    }

    fn pathological_rrule() -> &'static [u8] {
        b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Bharga//Test//EN\r\nBEGIN:VEVENT\r\nUID:pathological@example.test\r\nDTSTART:20260101T090000Z\r\nDTEND:20260101T100000Z\r\nRRULE:FREQ=MINUTELY\r\nSUMMARY:Pathological\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    }
}
