//! Provider-neutral calendar types shared by persistence, connectors, and IPC.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CalendarProvider {
    Local,
    CalDav,
    Google,
    Microsoft,
}

impl CalendarProvider {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::CalDav => "caldav",
            Self::Google => "google",
            Self::Microsoft => "microsoft",
        }
    }

    pub(crate) fn parse(value: &str) -> Self {
        match value {
            "caldav" => Self::CalDav,
            "google" => Self::Google,
            "microsoft" => Self::Microsoft,
            _ => Self::Local,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CalendarAuthState {
    Ready,
    ReauthorizationRequired,
    Error,
}

impl CalendarAuthState {
    pub(crate) fn parse(value: &str) -> Self {
        match value {
            "reauthorizationRequired" => Self::ReauthorizationRequired,
            "error" => Self::Error,
            _ => Self::Ready,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CalendarAccessRole {
    Owner,
    Writer,
    Reader,
    FreeBusyReader,
}

impl CalendarAccessRole {
    pub(crate) fn parse(value: &str) -> Self {
        match value {
            "writer" => Self::Writer,
            "reader" => Self::Reader,
            "freeBusyReader" => Self::FreeBusyReader,
            _ => Self::Owner,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSource {
    pub id: String,
    pub linked_account_id: Option<String>,
    pub provider: CalendarProvider,
    pub label: String,
    pub address: Option<String>,
    pub auth_state: CalendarAuthState,
    pub capabilities: Vec<String>,
    pub last_sync_at: Option<i64>,
    pub sync_error: Option<String>,
    pub disabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Calendar {
    pub id: String,
    pub source_id: String,
    pub provider_id: Option<String>,
    pub name: String,
    pub description: String,
    pub color: String,
    pub timezone: String,
    pub access_role: CalendarAccessRole,
    pub writable: bool,
    pub visible: bool,
    pub is_default: bool,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EventMoment {
    Timed { utc: String },
    AllDay { date: String },
}

impl EventMoment {
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::Timed { .. } => "timed",
            Self::AllDay { .. } => "allDay",
        }
    }

    pub(crate) fn value(&self) -> &str {
        match self {
            Self::Timed { utc } => utc,
            Self::AllDay { date } => date,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecurrenceSet {
    #[serde(default)]
    pub rules: Vec<String>,
    #[serde(default)]
    pub dates: Vec<String>,
    #[serde(default)]
    pub excluded_dates: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EventStatus {
    Tentative,
    Confirmed,
    Cancelled,
}

impl EventStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Tentative => "tentative",
            Self::Confirmed => "confirmed",
            Self::Cancelled => "cancelled",
        }
    }

    pub(crate) fn parse(value: &str) -> Self {
        match value {
            "tentative" => Self::Tentative,
            "cancelled" => Self::Cancelled,
            _ => Self::Confirmed,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Transparency {
    Busy,
    Free,
}

impl Transparency {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Busy => "busy",
            Self::Free => "free",
        }
    }

    pub(crate) fn parse(value: &str) -> Self {
        if value == "free" {
            Self::Free
        } else {
            Self::Busy
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EventVisibility {
    Default,
    Public,
    Private,
    Confidential,
}

impl EventVisibility {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Public => "public",
            Self::Private => "private",
            Self::Confidential => "confidential",
        }
    }

    pub(crate) fn parse(value: &str) -> Self {
        match value {
            "public" => Self::Public,
            "private" => Self::Private,
            "confidential" => Self::Confidential,
            _ => Self::Default,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EventPerson {
    pub name: Option<String>,
    pub email: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AttendeeRole {
    Required,
    Optional,
    Chair,
    NonParticipant,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ParticipationStatus {
    NeedsAction,
    Accepted,
    Declined,
    Tentative,
    Delegated,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EventAttendee {
    pub name: Option<String>,
    pub email: String,
    pub role: AttendeeRole,
    pub status: ParticipationStatus,
    pub rsvp: bool,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReminderMethod {
    Display,
    Email,
}

impl ReminderMethod {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Display => "display",
            Self::Email => "email",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EventReminder {
    pub id: Option<String>,
    pub method: ReminderMethod,
    pub minutes_before: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EventSyncState {
    Local,
    Pending,
    Synced,
    Conflict,
    Error,
}

impl EventSyncState {
    pub(crate) fn parse(value: &str) -> Self {
        match value {
            "local" => Self::Local,
            "synced" => Self::Synced,
            "conflict" => Self::Conflict,
            "error" => Self::Error,
            _ => Self::Pending,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EventMutation {
    pub calendar_id: String,
    pub title: String,
    pub description: String,
    pub location: String,
    pub conference_url: Option<String>,
    pub source_thread_id: Option<String>,
    pub start: EventMoment,
    pub end: EventMoment,
    pub timezone: String,
    pub recurrence: Option<RecurrenceSet>,
    pub status: EventStatus,
    pub transparency: Transparency,
    pub visibility: EventVisibility,
    pub organizer: Option<EventPerson>,
    pub attendees: Vec<EventAttendee>,
    pub reminders: Vec<EventReminder>,
}

impl From<&CalendarEvent> for EventMutation {
    fn from(event: &CalendarEvent) -> Self {
        Self {
            calendar_id: event.calendar_id.clone(),
            title: event.title.clone(),
            description: event.description.clone(),
            location: event.location.clone(),
            conference_url: event.conference_url.clone(),
            source_thread_id: event.source_thread_id.clone(),
            start: event.start.clone(),
            end: event.end.clone(),
            timezone: event.timezone.clone(),
            recurrence: event.recurrence.clone(),
            status: event.status,
            transparency: event.transparency,
            visibility: event.visibility,
            organizer: event.organizer.clone(),
            attendees: event.attendees.clone(),
            reminders: event.reminders.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub calendar_id: String,
    pub uid: String,
    pub provider_id: Option<String>,
    pub title: String,
    pub description: String,
    pub location: String,
    pub conference_url: Option<String>,
    pub source_thread_id: Option<String>,
    pub start: EventMoment,
    pub end: EventMoment,
    pub timezone: String,
    pub recurrence: Option<RecurrenceSet>,
    pub recurrence_id: Option<String>,
    pub parent_event_id: Option<String>,
    pub status: EventStatus,
    pub transparency: Transparency,
    pub visibility: EventVisibility,
    pub organizer: Option<EventPerson>,
    pub attendees: Vec<EventAttendee>,
    pub reminders: Vec<EventReminder>,
    pub sequence: i64,
    pub provider_version: Option<String>,
    pub revision: i64,
    pub sync_state: EventSyncState,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EventRange {
    pub start: String,
    pub end: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EventOccurrence {
    pub event_id: String,
    pub recurrence_id: String,
    pub start_utc: Option<chrono::DateTime<chrono::Utc>>,
    pub end_utc: Option<chrono::DateTime<chrono::Utc>>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecurrenceEditScope {
    ThisOccurrence,
    EntireSeries,
    ThisAndFollowing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SeriesSplit {
    pub original: CalendarEvent,
    pub following: Option<CalendarEvent>,
    pub exception: Option<CalendarEvent>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OperationKind {
    Create,
    Update,
    Delete,
    SendInvitation,
}

impl OperationKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Update => "update",
            Self::Delete => "delete",
            Self::SendInvitation => "sendInvitation",
        }
    }

    pub(crate) fn parse(value: &str) -> Self {
        match value {
            "update" => Self::Update,
            "delete" => Self::Delete,
            "sendInvitation" => Self::SendInvitation,
            _ => Self::Create,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarOperation {
    pub id: String,
    pub source_id: String,
    pub calendar_id: String,
    pub event_id: String,
    pub kind: OperationKind,
    pub revision: i64,
    pub expected_provider_version: Option<String>,
    pub attempts: i64,
    pub next_retry_at: i64,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarConflict {
    pub event_id: String,
    pub local: CalendarEvent,
    pub remote: CalendarEvent,
    pub provider_version: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConflictResolution {
    KeepLocal,
    UseRemote,
    Duplicate,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSyncHealth {
    pub source_id: String,
    pub pending_count: i64,
    pub conflict_count: i64,
    pub last_sync_at: Option<i64>,
    pub error_code: Option<String>,
    pub retry_at: Option<i64>,
}
