//! Bounded recurrence expansion and transactional recurring-series edits.

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use rrule::{RRule, RRuleSet, Tz, Unvalidated};
use serde::Serialize;

use super::domain::{
    CalendarEvent, EventMoment, EventMutation, EventOccurrence, EventRange, RecurrenceEditScope,
    RecurrenceSet, SeriesSplit,
};
use crate::store::Store;

const MAX_EXPANSION_LIMIT: usize = 512;
const MAX_RANGE_DAYS: i64 = 366;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarError {
    code: &'static str,
    message: String,
}

impl CalendarError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

fn invalid(message: impl Into<String>) -> CalendarError {
    CalendarError::new("invalid-recurrence", message)
}

fn parse_utc(value: &str, label: &str) -> Result<DateTime<Utc>, CalendarError> {
    DateTime::parse_from_rfc3339(value)
        .map(|parsed| parsed.with_timezone(&Utc))
        .map_err(|_| invalid(format!("{label} must be an RFC3339 timestamp")))
}

fn validated_range(range: &EventRange) -> Result<(DateTime<Utc>, DateTime<Utc>), CalendarError> {
    let start = parse_utc(&range.start, "range start")?;
    let end = parse_utc(&range.end, "range end")?;
    if end <= start {
        return Err(invalid("range end must be after start"));
    }
    if end.signed_duration_since(start) > Duration::days(MAX_RANGE_DAYS) {
        return Err(CalendarError::new(
            "recurrence-range",
            format!("recurrence ranges are limited to {MAX_RANGE_DAYS} days"),
        ));
    }
    Ok((start, end))
}

fn recurrence_datetime(
    value: &str,
    timezone: chrono_tz::Tz,
    all_day: bool,
) -> Result<DateTime<Tz>, CalendarError> {
    if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
        let zone = Tz::from(timezone);
        return Ok(parsed.with_timezone(&Utc).with_timezone(&zone));
    }

    let local = if all_day {
        NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .map_err(|_| invalid("all-day recurrence values must be ISO dates"))?
            .and_hms_opt(0, 0, 0)
            .ok_or_else(|| invalid("all-day recurrence value is invalid"))?
    } else {
        NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S")
            .map_err(|_| invalid("recurrence values must be RFC3339 or local ISO timestamps"))?
    };
    let local = timezone
        .from_local_datetime(&local)
        .earliest()
        .ok_or_else(|| invalid("recurrence value falls in an invalid local time"))?;
    Ok(local.with_timezone(&Tz::from(timezone)))
}

fn base_occurrence(
    event: &CalendarEvent,
    range_start: DateTime<Utc>,
    range_end: DateTime<Utc>,
) -> Result<Vec<EventOccurrence>, CalendarError> {
    match (&event.start, &event.end) {
        (EventMoment::Timed { utc: start }, EventMoment::Timed { utc: end }) => {
            let start = parse_utc(start, "event start")?;
            let end = parse_utc(end, "event end")?;
            if start < range_end && end > range_start {
                Ok(vec![EventOccurrence {
                    event_id: event.id.clone(),
                    recurrence_id: start.to_rfc3339_opts(SecondsFormat::Secs, true),
                    start_utc: Some(start),
                    end_utc: Some(end),
                    start_date: None,
                    end_date: None,
                }])
            } else {
                Ok(Vec::new())
            }
        }
        (EventMoment::AllDay { date: start }, EventMoment::AllDay { date: end }) => {
            let timezone = event
                .timezone
                .parse::<chrono_tz::Tz>()
                .map_err(|_| invalid("event timezone must be an IANA timezone"))?;
            let start_date = NaiveDate::parse_from_str(start, "%Y-%m-%d")
                .map_err(|_| invalid("all-day event start must be an ISO date"))?;
            let end_date = NaiveDate::parse_from_str(end, "%Y-%m-%d")
                .map_err(|_| invalid("all-day event end must be an ISO date"))?;
            let start_local = timezone
                .from_local_datetime(&start_date.and_hms_opt(0, 0, 0).unwrap())
                .earliest()
                .ok_or_else(|| invalid("all-day event start is invalid"))?
                .with_timezone(&Utc);
            let end_local = timezone
                .from_local_datetime(&end_date.and_hms_opt(0, 0, 0).unwrap())
                .earliest()
                .ok_or_else(|| invalid("all-day event end is invalid"))?
                .with_timezone(&Utc);
            if start_local < range_end && end_local > range_start {
                Ok(vec![EventOccurrence {
                    event_id: event.id.clone(),
                    recurrence_id: start.clone(),
                    start_utc: None,
                    end_utc: None,
                    start_date: Some(start.clone()),
                    end_date: Some(end.clone()),
                }])
            } else {
                Ok(Vec::new())
            }
        }
        _ => Err(invalid("event start and end must use the same time shape")),
    }
}

struct RecurrenceContext {
    set: RRuleSet,
    timezone: chrono_tz::Tz,
    timed_duration: Option<Duration>,
    all_day_duration: Option<i64>,
}

fn recurrence_context(
    event: &CalendarEvent,
    recurrence: &RecurrenceSet,
) -> Result<RecurrenceContext, CalendarError> {
    let timezone = event
        .timezone
        .parse::<chrono_tz::Tz>()
        .map_err(|_| invalid("event timezone must be an IANA timezone"))?;
    let all_day = matches!(event.start, EventMoment::AllDay { .. });
    let (dt_start, timed_duration, all_day_duration) = match (&event.start, &event.end) {
        (EventMoment::Timed { utc: start }, EventMoment::Timed { utc: end }) => {
            let start = parse_utc(start, "event start")?;
            let end = parse_utc(end, "event end")?;
            if end <= start {
                return Err(invalid("event end must be after start"));
            }
            (
                start.with_timezone(&Tz::from(timezone)),
                Some(end.signed_duration_since(start)),
                None,
            )
        }
        (EventMoment::AllDay { date: start }, EventMoment::AllDay { date: end }) => {
            let start = NaiveDate::parse_from_str(start, "%Y-%m-%d")
                .map_err(|_| invalid("all-day event start must be an ISO date"))?;
            let end = NaiveDate::parse_from_str(end, "%Y-%m-%d")
                .map_err(|_| invalid("all-day event end must be an ISO date"))?;
            let days = end.signed_duration_since(start).num_days();
            if days <= 0 {
                return Err(invalid("all-day event end must be after start"));
            }
            let local = timezone
                .from_local_datetime(&start.and_hms_opt(0, 0, 0).unwrap())
                .earliest()
                .ok_or_else(|| invalid("all-day event start is invalid"))?;
            (local.with_timezone(&Tz::from(timezone)), None, Some(days))
        }
        _ => return Err(invalid("event start and end must use the same time shape")),
    };

    let mut set = RRuleSet::new(dt_start);
    for raw_rule in &recurrence.rules {
        let raw_rule = raw_rule
            .trim()
            .strip_prefix("RRULE:")
            .unwrap_or(raw_rule.trim());
        let rule = raw_rule
            .parse::<RRule<Unvalidated>>()
            .map_err(|error| invalid(format!("invalid RRULE: {error}")))?
            .validate(dt_start)
            .map_err(|error| invalid(format!("invalid RRULE: {error}")))?;
        set = set.rrule(rule);
    }
    for value in &recurrence.dates {
        set = set.rdate(recurrence_datetime(value, timezone, all_day)?);
    }
    for value in &recurrence.excluded_dates {
        set = set.exdate(recurrence_datetime(value, timezone, all_day)?);
    }

    Ok(RecurrenceContext {
        set,
        timezone,
        timed_duration,
        all_day_duration,
    })
}

pub fn expand_event(
    event: &CalendarEvent,
    range: &EventRange,
    limit: usize,
) -> Result<Vec<EventOccurrence>, CalendarError> {
    let (range_start, range_end) = validated_range(range)?;
    if limit == 0 || limit > MAX_EXPANSION_LIMIT {
        return Err(CalendarError::new(
            "recurrence-limit",
            format!("recurrence expansion limit must be between 1 and {MAX_EXPANSION_LIMIT}"),
        ));
    }
    let Some(recurrence) = &event.recurrence else {
        return base_occurrence(event, range_start, range_end);
    };
    if recurrence.rules.is_empty() && recurrence.dates.is_empty() {
        return base_occurrence(event, range_start, range_end);
    }

    let context = recurrence_context(event, recurrence)?;
    let timezone = context.timezone;
    let timed_duration = context.timed_duration;
    let all_day_duration = context.all_day_duration;

    let overlap = timed_duration.unwrap_or_else(|| Duration::days(all_day_duration.unwrap_or(1)));
    let after = (range_start - overlap - Duration::seconds(1)).with_timezone(&Tz::from(timezone));
    let before = range_end.with_timezone(&Tz::from(timezone));
    let result = context
        .set
        .after(after)
        .before(before)
        .all(u16::try_from(limit + 1).unwrap());
    if result.limited || result.dates.len() > limit {
        return Err(CalendarError::new(
            "recurrence-limit",
            format!("recurrence expansion exceeded {limit} occurrences"),
        ));
    }

    let mut occurrences = Vec::with_capacity(result.dates.len());
    for start in result.dates {
        if let Some(duration) = timed_duration {
            let start_utc = start.with_timezone(&Utc);
            let end_utc = start_utc + duration;
            if start_utc < range_end && end_utc > range_start {
                occurrences.push(EventOccurrence {
                    event_id: event.id.clone(),
                    recurrence_id: start_utc.to_rfc3339_opts(SecondsFormat::Secs, true),
                    start_utc: Some(start_utc),
                    end_utc: Some(end_utc),
                    start_date: None,
                    end_date: None,
                });
            }
        } else {
            let start_date = start.date_naive();
            let end_date = start_date + Duration::days(all_day_duration.unwrap());
            let start_boundary = start.with_timezone(&Utc);
            let end_local = timezone
                .from_local_datetime(&end_date.and_hms_opt(0, 0, 0).unwrap())
                .earliest()
                .ok_or_else(|| invalid("all-day occurrence end is invalid"))?
                .with_timezone(&Utc);
            if start_boundary < range_end && end_local > range_start {
                let start_text = start_date.format("%Y-%m-%d").to_string();
                occurrences.push(EventOccurrence {
                    event_id: event.id.clone(),
                    recurrence_id: start_text.clone(),
                    start_utc: None,
                    end_utc: None,
                    start_date: Some(start_text),
                    end_date: Some(end_date.format("%Y-%m-%d").to_string()),
                });
            }
        }
    }
    occurrences.sort_by(|left, right| left.recurrence_id.cmp(&right.recurrence_id));
    occurrences.dedup_by(|left, right| left.recurrence_id == right.recurrence_id);
    Ok(occurrences)
}

fn store_error(error: rusqlite::Error) -> CalendarError {
    match error {
        rusqlite::Error::InvalidParameterName(message) => invalid(message),
        other => {
            log::error!("recurrence store operation failed: {other}");
            CalendarError::new("storage-error", "Recurring event could not be saved")
        }
    }
}

fn recurrence_target(
    event: &CalendarEvent,
    recurrence_id: &str,
) -> Result<(RecurrenceContext, DateTime<Tz>, usize), CalendarError> {
    let recurrence = event
        .recurrence
        .as_ref()
        .filter(|value| !value.rules.is_empty() || !value.dates.is_empty())
        .ok_or_else(|| invalid("event is not a recurring series"))?;
    let context = recurrence_context(event, recurrence)?;
    let all_day = context.all_day_duration.is_some();
    let target = recurrence_datetime(recurrence_id, context.timezone, all_day)?;
    let generated = context
        .set
        .clone()
        .before(target + Duration::seconds(1))
        .all(u16::try_from(MAX_EXPANSION_LIMIT + 1).unwrap());
    if generated.limited {
        return Err(CalendarError::new(
            "recurrence-limit",
            "Recurring-series edit exceeds the supported occurrence limit",
        ));
    }
    let position = generated
        .dates
        .iter()
        .position(|candidate| *candidate == target)
        .ok_or_else(|| invalid("recurrence ID is not an occurrence in this series"))?;
    Ok((context, target, position))
}

fn rule_parts(rule: &str) -> Vec<&str> {
    rule.trim()
        .strip_prefix("RRULE:")
        .unwrap_or(rule.trim())
        .split(';')
        .filter(|part| !part.is_empty())
        .collect()
}

fn rule_count(rule: &str) -> Result<Option<u32>, CalendarError> {
    rule_parts(rule)
        .into_iter()
        .find_map(|part| part.strip_prefix("COUNT="))
        .map(|value| {
            value
                .parse::<u32>()
                .map_err(|_| invalid("RRULE COUNT is invalid"))
        })
        .transpose()
}

fn truncated_rule(rule: &str, until: DateTime<Utc>) -> String {
    let mut parts = rule_parts(rule)
        .into_iter()
        .filter(|part| !part.starts_with("COUNT=") && !part.starts_with("UNTIL="))
        .map(str::to_string)
        .collect::<Vec<_>>();
    parts.push(format!("UNTIL={}", until.format("%Y%m%dT%H%M%SZ")));
    parts.join(";")
}

fn following_rule(rule: &str, occurrences_before: usize) -> Result<String, CalendarError> {
    let mut parts = rule_parts(rule)
        .into_iter()
        .filter(|part| !part.starts_with("COUNT="))
        .map(str::to_string)
        .collect::<Vec<_>>();
    if let Some(count) = rule_count(rule)? {
        let remaining = count
            .checked_sub(u32::try_from(occurrences_before).unwrap_or(u32::MAX))
            .filter(|value| *value > 0)
            .ok_or_else(|| invalid("recurrence ID is after the end of the counted series"))?;
        parts.push(format!("COUNT={remaining}"));
    }
    Ok(parts.join(";"))
}

fn partition_recurrence_values(
    values: &[String],
    timezone: chrono_tz::Tz,
    all_day: bool,
    target: DateTime<Tz>,
) -> Result<(Vec<String>, Vec<String>), CalendarError> {
    let mut before = Vec::new();
    let mut following = Vec::new();
    for value in values {
        if recurrence_datetime(value, timezone, all_day)? < target {
            before.push(value.clone());
        } else {
            following.push(value.clone());
        }
    }
    Ok((before, following))
}

fn shift_unchanged_patch_to_target(
    master: &CalendarEvent,
    patch: &mut EventMutation,
    target: DateTime<Tz>,
    context: &RecurrenceContext,
) -> Result<(), CalendarError> {
    if patch.start != master.start || patch.end != master.end {
        return Ok(());
    }
    if let Some(duration) = context.timed_duration {
        let start = target.with_timezone(&Utc);
        patch.start = EventMoment::Timed {
            utc: start.to_rfc3339_opts(SecondsFormat::Secs, true),
        };
        patch.end = EventMoment::Timed {
            utc: (start + duration).to_rfc3339_opts(SecondsFormat::Secs, true),
        };
    } else {
        let start = target.date_naive();
        let end = start + Duration::days(context.all_day_duration.unwrap_or(1));
        patch.start = EventMoment::AllDay {
            date: start.format("%Y-%m-%d").to_string(),
        };
        patch.end = EventMoment::AllDay {
            date: end.format("%Y-%m-%d").to_string(),
        };
    }
    Ok(())
}

pub fn split_series(
    store: &Store,
    event_id: &str,
    recurrence_id: &str,
    mut patch: EventMutation,
    notify_attendees: bool,
) -> Result<SeriesSplit, CalendarError> {
    let master = store
        .calendar_event(event_id)
        .map_err(store_error)?
        .ok_or_else(|| invalid("recurring series does not exist"))?;
    let recurrence = master
        .recurrence
        .as_ref()
        .ok_or_else(|| invalid("event is not a recurring series"))?;
    if recurrence.rules.len() != 1 {
        return Err(invalid(
            "this-and-following edits require exactly one RRULE",
        ));
    }
    let (context, target, occurrences_before) = recurrence_target(&master, recurrence_id)?;
    if occurrences_before == 0 {
        let updated = store
            .update_calendar_event_with_notifications(event_id, patch, notify_attendees)
            .map_err(store_error)?;
        return Ok(SeriesSplit {
            original: updated,
            following: None,
            exception: None,
        });
    }

    let all_day = context.all_day_duration.is_some();
    let (before_dates, following_dates) =
        partition_recurrence_values(&recurrence.dates, context.timezone, all_day, target)?;
    let (before_exdates, following_exdates) = partition_recurrence_values(
        &recurrence.excluded_dates,
        context.timezone,
        all_day,
        target,
    )?;
    let until = target.with_timezone(&Utc) - Duration::seconds(1);
    let mut original_patch = EventMutation::from(&master);
    original_patch.recurrence = Some(RecurrenceSet {
        rules: vec![truncated_rule(&recurrence.rules[0], until)],
        dates: before_dates,
        excluded_dates: before_exdates,
    });

    shift_unchanged_patch_to_target(&master, &mut patch, target, &context)?;
    patch.recurrence = Some(RecurrenceSet {
        rules: vec![following_rule(&recurrence.rules[0], occurrences_before)?],
        dates: following_dates,
        excluded_dates: following_exdates,
    });
    store
        .split_calendar_series(event_id, original_patch, patch, notify_attendees)
        .map_err(store_error)
}

pub fn edit_recurring_event(
    store: &Store,
    event_id: &str,
    recurrence_id: &str,
    scope: RecurrenceEditScope,
    patch: EventMutation,
    notify_attendees: bool,
) -> Result<SeriesSplit, CalendarError> {
    match scope {
        RecurrenceEditScope::EntireSeries => {
            let original = store
                .update_calendar_event_with_notifications(event_id, patch, notify_attendees)
                .map_err(store_error)?;
            Ok(SeriesSplit {
                original,
                following: None,
                exception: None,
            })
        }
        RecurrenceEditScope::ThisOccurrence => {
            let master = store
                .calendar_event(event_id)
                .map_err(store_error)?
                .ok_or_else(|| invalid("recurring series does not exist"))?;
            if store
                .calendar_exception(event_id, recurrence_id)
                .map_err(store_error)?
                .is_none()
            {
                recurrence_target(&master, recurrence_id)?;
            }
            store
                .create_calendar_exception(event_id, recurrence_id, patch, notify_attendees)
                .map_err(store_error)
        }
        RecurrenceEditScope::ThisAndFollowing => {
            split_series(store, event_id, recurrence_id, patch, notify_attendees)
        }
    }
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, Timelike};

    use super::*;
    use crate::calendar::domain::{
        CalendarEvent, EventMoment, EventMutation, EventRange, EventStatus, EventSyncState,
        EventVisibility, RecurrenceEditScope, RecurrenceSet, Transparency,
    };
    use crate::store::Store;

    fn event(start: EventMoment, end: EventMoment, timezone: &str, rule: &str) -> CalendarEvent {
        CalendarEvent {
            id: "event-1".into(),
            calendar_id: "calendar-1".into(),
            uid: "event-1@example.test".into(),
            provider_id: None,
            title: "Recurring review".into(),
            description: String::new(),
            location: String::new(),
            conference_url: None,
            source_thread_id: None,
            start,
            end,
            timezone: timezone.into(),
            recurrence: Some(RecurrenceSet {
                rules: vec![rule.into()],
                dates: Vec::new(),
                excluded_dates: Vec::new(),
            }),
            recurrence_id: None,
            parent_event_id: None,
            status: EventStatus::Confirmed,
            transparency: Transparency::Busy,
            visibility: EventVisibility::Default,
            organizer: None,
            attendees: Vec::new(),
            reminders: Vec::new(),
            sequence: 0,
            provider_version: None,
            revision: 1,
            sync_state: EventSyncState::Synced,
            deleted: false,
        }
    }

    #[test]
    fn weekly_berlin_event_keeps_nine_am_across_dst() {
        let recurring = event(
            EventMoment::Timed {
                utc: "2026-03-22T08:00:00Z".into(),
            },
            EventMoment::Timed {
                utc: "2026-03-22T09:00:00Z".into(),
            },
            "Europe/Berlin",
            "FREQ=WEEKLY;COUNT=3",
        );
        let range = EventRange {
            start: "2026-03-20T00:00:00Z".into(),
            end: "2026-04-10T00:00:00Z".into(),
        };

        let occurrences = expand_event(&recurring, &range, 128).unwrap();
        let zone: chrono_tz::Tz = "Europe/Berlin".parse().unwrap();
        let local_hours = occurrences
            .iter()
            .map(|occurrence| occurrence.start_utc.unwrap().with_timezone(&zone).hour())
            .collect::<Vec<_>>();

        assert_eq!(local_hours, vec![9, 9, 9]);
        assert_ne!(
            occurrences[0].start_utc.unwrap(),
            occurrences[1].start_utc.unwrap() - Duration::weeks(1)
        );
    }

    #[test]
    fn all_day_dates_do_not_shift_in_los_angeles() {
        let recurring = event(
            EventMoment::AllDay {
                date: "2026-10-25".into(),
            },
            EventMoment::AllDay {
                date: "2026-10-26".into(),
            },
            "Europe/Berlin",
            "FREQ=DAILY;COUNT=1",
        );
        let range = EventRange {
            start: "2026-10-24T00:00:00Z".into(),
            end: "2026-10-27T00:00:00Z".into(),
        };

        let occurrence = expand_event(&recurring, &range, 8).unwrap().remove(0);

        assert_eq!(occurrence.start_date.as_deref(), Some("2026-10-25"));
        assert_eq!(occurrence.end_date.as_deref(), Some("2026-10-26"));
    }

    #[test]
    fn expansion_rejects_pathological_rule_before_limit() {
        let recurring = event(
            EventMoment::Timed {
                utc: "2026-01-01T08:00:00Z".into(),
            },
            EventMoment::Timed {
                utc: "2026-01-01T09:00:00Z".into(),
            },
            "Europe/Berlin",
            "FREQ=MINUTELY",
        );
        let range = EventRange {
            start: "2026-01-01T00:00:00Z".into(),
            end: "2026-12-31T23:59:59Z".into(),
        };

        assert_eq!(
            expand_event(&recurring, &range, 512).unwrap_err().code(),
            "recurrence-limit"
        );
    }

    #[test]
    fn this_occurrence_edit_persists_an_exception() {
        let store = Store::in_memory().unwrap();
        let calendar = store
            .create_local_calendar("Personal", "#6f8df6", "Europe/Berlin")
            .unwrap();
        let master = store
            .create_calendar_event(EventMutation {
                calendar_id: calendar.id,
                title: "Weekly review".into(),
                description: String::new(),
                location: String::new(),
                conference_url: None,
                source_thread_id: None,
                start: EventMoment::Timed {
                    utc: "2026-03-22T08:00:00Z".into(),
                },
                end: EventMoment::Timed {
                    utc: "2026-03-22T09:00:00Z".into(),
                },
                timezone: "Europe/Berlin".into(),
                recurrence: Some(RecurrenceSet {
                    rules: vec!["FREQ=WEEKLY;COUNT=3".into()],
                    dates: Vec::new(),
                    excluded_dates: Vec::new(),
                }),
                status: EventStatus::Confirmed,
                transparency: Transparency::Busy,
                visibility: EventVisibility::Default,
                organizer: None,
                attendees: Vec::new(),
                reminders: Vec::new(),
            })
            .unwrap();
        let mut patch = EventMutation::from(&master);
        patch.title = "Moved review".into();
        patch.start = EventMoment::Timed {
            utc: "2026-03-29T09:00:00Z".into(),
        };
        patch.end = EventMoment::Timed {
            utc: "2026-03-29T10:00:00Z".into(),
        };

        let result = edit_recurring_event(
            &store,
            &master.id,
            "2026-03-29T07:00:00Z",
            RecurrenceEditScope::ThisOccurrence,
            patch,
            false,
        )
        .unwrap();
        let exception = result.exception.unwrap();

        assert_eq!(exception.uid, master.uid);
        assert_eq!(
            exception.parent_event_id.as_deref(),
            Some(master.id.as_str())
        );
        assert_eq!(
            exception.recurrence_id.as_deref(),
            Some("2026-03-29T07:00:00Z")
        );
        let refreshed_master = store.calendar_event(&master.id).unwrap().unwrap();
        let expanded = expand_event(
            &refreshed_master,
            &EventRange {
                start: "2026-03-20T00:00:00Z".into(),
                end: "2026-04-10T00:00:00Z".into(),
            },
            16,
        )
        .unwrap();
        assert_eq!(expanded.len(), 2);
        assert!(expanded
            .iter()
            .all(|occurrence| occurrence.recurrence_id != "2026-03-29T07:00:00Z"));

        let mut second_patch = EventMutation::from(&exception);
        second_patch.title = "Moved review again".into();
        let updated = edit_recurring_event(
            &store,
            &master.id,
            "2026-03-29T07:00:00Z",
            RecurrenceEditScope::ThisOccurrence,
            second_patch,
            false,
        )
        .unwrap()
        .exception
        .unwrap();
        assert_eq!(updated.id, exception.id);
        assert_eq!(updated.title, "Moved review again");
    }

    #[test]
    fn this_and_following_truncates_master_and_starts_a_new_series() {
        let store = Store::in_memory().unwrap();
        let calendar = store
            .create_local_calendar("Personal", "#6f8df6", "Europe/Berlin")
            .unwrap();
        let master = store
            .create_calendar_event(EventMutation {
                calendar_id: calendar.id,
                title: "Weekly review".into(),
                description: String::new(),
                location: String::new(),
                conference_url: None,
                source_thread_id: None,
                start: EventMoment::Timed {
                    utc: "2026-03-22T08:00:00Z".into(),
                },
                end: EventMoment::Timed {
                    utc: "2026-03-22T09:00:00Z".into(),
                },
                timezone: "Europe/Berlin".into(),
                recurrence: Some(RecurrenceSet {
                    rules: vec!["FREQ=WEEKLY;COUNT=5".into()],
                    dates: Vec::new(),
                    excluded_dates: Vec::new(),
                }),
                status: EventStatus::Confirmed,
                transparency: Transparency::Busy,
                visibility: EventVisibility::Default,
                organizer: None,
                attendees: Vec::new(),
                reminders: Vec::new(),
            })
            .unwrap();
        let mut patch = EventMutation::from(&master);
        patch.title = "New weekly review".into();

        let result = edit_recurring_event(
            &store,
            &master.id,
            "2026-04-05T07:00:00Z",
            RecurrenceEditScope::ThisAndFollowing,
            patch,
            false,
        )
        .unwrap();

        assert!(result.original.recurrence.unwrap().rules[0].contains("UNTIL="));
        assert_eq!(
            result.following.as_ref().unwrap().start,
            EventMoment::Timed {
                utc: "2026-04-05T07:00:00Z".into()
            }
        );
        assert_eq!(result.following.unwrap().title, "New weekly review");
    }
}
