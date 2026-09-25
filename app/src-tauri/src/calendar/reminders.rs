//! Native reminder delivery with privacy redaction and bounded reconciliation.

use std::sync::Arc;

use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use super::domain::{EventMoment, EventVisibility};
use crate::store::Store;

const STARTUP_LOOKBACK_MINUTES: i64 = 15;
const QUERY_HORIZON_DAYS: i64 = 29;

#[derive(Debug, Clone)]
pub struct ReminderCandidate {
    pub id: String,
    pub event_id: String,
    pub title: String,
    pub location: String,
    pub start: EventMoment,
    pub timezone: String,
    pub visibility: EventVisibility,
    pub minutes_before: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DueReminder {
    pub id: String,
    pub event_id: String,
    pub due_at: i64,
    pub title: String,
    pub location: String,
    pub start_at: i64,
    pub visibility: EventVisibility,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReminderNotification {
    pub title: String,
    pub body: String,
}

fn start_at(candidate: &ReminderCandidate) -> Option<i64> {
    match &candidate.start {
        EventMoment::Timed { utc } => DateTime::parse_from_rfc3339(utc)
            .ok()
            .map(|value| value.timestamp()),
        EventMoment::AllDay { date } => {
            let timezone = candidate.timezone.parse::<chrono_tz::Tz>().ok()?;
            let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
            timezone
                .from_local_datetime(&date.and_hms_opt(0, 0, 0)?)
                .earliest()
                .map(|value| value.timestamp())
        }
    }
}

pub fn reconcile_reminders(
    now: i64,
    earliest: i64,
    candidates: Vec<ReminderCandidate>,
) -> Vec<DueReminder> {
    let mut due = candidates
        .into_iter()
        .filter_map(|candidate| {
            let start_at = start_at(&candidate)?;
            let due_at = start_at.saturating_sub(candidate.minutes_before.saturating_mul(60));
            (due_at >= earliest && due_at <= now).then_some(DueReminder {
                id: candidate.id,
                event_id: candidate.event_id,
                due_at,
                title: candidate.title,
                location: candidate.location,
                start_at,
                visibility: candidate.visibility,
            })
        })
        .collect::<Vec<_>>();
    due.sort_by_key(|item| (item.due_at, item.id.clone()));
    due
}

pub fn reminder_notification(reminder: &DueReminder) -> ReminderNotification {
    if matches!(
        reminder.visibility,
        EventVisibility::Private | EventVisibility::Confidential
    ) {
        return ReminderNotification {
            title: "Private event".into(),
            body: "An event is starting soon.".into(),
        };
    }
    let start = DateTime::from_timestamp(reminder.start_at, 0)
        .map(|value| value.format("%H:%M UTC").to_string())
        .unwrap_or_else(|| "soon".into());
    ReminderNotification {
        title: reminder.title.clone(),
        body: if reminder.location.is_empty() {
            format!("Starts at {start}")
        } else {
            format!("Starts at {start} · {}", reminder.location)
        },
    }
}

fn query_window(now: i64) -> (String, String) {
    let start = DateTime::from_timestamp(now, 0)
        .unwrap_or_else(Utc::now)
        .date_naive()
        - Duration::days(QUERY_HORIZON_DAYS);
    let end = DateTime::from_timestamp(now, 0)
        .unwrap_or_else(Utc::now)
        .date_naive()
        + Duration::days(2);
    (
        start.format("%Y-%m-%d").to_string(),
        end.format("%Y-%m-%d").to_string(),
    )
}

fn deliver_due(app: &AppHandle, store: &Store, earliest: i64, now: i64) {
    let (window_start, window_end) = query_window(now);
    let Ok(candidates) = store.calendar_reminder_candidates(&window_start, &window_end) else {
        return;
    };
    for reminder in reconcile_reminders(now, earliest, candidates) {
        let notice = reminder_notification(&reminder);
        if app
            .notification()
            .builder()
            .title(notice.title)
            .body(notice.body)
            .show()
            .is_ok()
        {
            let _ = store.mark_calendar_reminder_delivered(&reminder.id, now);
        }
    }
}

pub async fn run(app: AppHandle, store: Arc<Store>) {
    let mut last_check = Utc::now().timestamp() - STARTUP_LOOKBACK_MINUTES * 60;
    loop {
        let now = Utc::now().timestamp();
        deliver_due(&app, &store, last_check, now);
        last_check = now.saturating_add(1);
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(title: &str, visibility: EventVisibility, start: &str) -> ReminderCandidate {
        ReminderCandidate {
            id: format!("reminder:{title}"),
            event_id: "event".into(),
            title: title.into(),
            location: "Board room".into(),
            start: EventMoment::Timed { utc: start.into() },
            timezone: "UTC".into(),
            visibility,
            minutes_before: 10,
        }
    }

    #[test]
    fn private_event_notification_hides_details() {
        let start = DateTime::parse_from_rfc3339("2025-10-01T07:56:40Z")
            .unwrap()
            .timestamp();
        let due = reconcile_reminders(
            start - 10 * 60,
            start - 20 * 60,
            vec![candidate(
                "Board acquisition",
                EventVisibility::Private,
                "2025-10-01T07:56:40Z",
            )],
        );
        let notice = reminder_notification(&due[0]);
        assert_eq!(notice.title, "Private event");
        assert!(!notice.body.contains("Board acquisition"));
        assert!(!notice.body.contains("Board room"));
    }

    #[test]
    fn startup_reconciliation_does_not_replay_old_reminders() {
        let now = 1_759_300_000;
        let due = reconcile_reminders(
            now,
            now - STARTUP_LOOKBACK_MINUTES * 60,
            vec![candidate(
                "Old event",
                EventVisibility::Default,
                "2025-10-01T04:00:00Z",
            )],
        );
        assert!(due.is_empty());
    }
}
