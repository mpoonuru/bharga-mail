//! Persistence integration test for offline calendar changes before provider sync.

use std::path::PathBuf;

use bharga_mail_lib::calendar::domain::{
    EventMoment, EventMutation, EventStatus, EventVisibility, Transparency,
};
use bharga_mail_lib::store::Store;
use uuid::Uuid;

fn temporary_database() -> PathBuf {
    std::env::temp_dir().join(format!("bharga-calendar-test-{}.sqlite3", Uuid::new_v4()))
}

#[test]
fn offline_calendar_operation_survives_database_reopen() {
    let path = temporary_database();
    let event_id = {
        let store = Store::open(path.clone()).unwrap();
        let calendar = store
            .create_local_calendar("Offline", "#6f8df6", "UTC")
            .unwrap();
        let event = store
            .create_calendar_event(EventMutation {
                calendar_id: calendar.id,
                title: "Offline change".into(),
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
                status: EventStatus::Confirmed,
                transparency: Transparency::Busy,
                visibility: EventVisibility::Default,
                organizer: None,
                attendees: Vec::new(),
                reminders: Vec::new(),
            })
            .unwrap();
        assert_eq!(
            event.sync_state,
            bharga_mail_lib::calendar::domain::EventSyncState::Local
        );
        assert!(store.calendar_operation_for(&event.id).is_err());
        event.id
    };
    let reopened = Store::open(path.clone()).unwrap();
    assert_eq!(
        reopened.calendar_event(&event_id).unwrap().unwrap().title,
        "Offline change"
    );
    drop(reopened);
    for candidate in [
        path.clone(),
        PathBuf::from(format!("{}-wal", path.display())),
        PathBuf::from(format!("{}-shm", path.display())),
    ] {
        let _ = std::fs::remove_file(candidate);
    }
}
