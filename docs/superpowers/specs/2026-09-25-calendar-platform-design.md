# Bharga Mail Calendar Platform Design

## Purpose

This specification replaces Bharga Mail's calendar preview with a production,
local-first calendar subsystem. It defines the persisted calendar domain, native
desktop experience, iCalendar interoperability, CalDAV synchronization, and
Google Calendar and Microsoft 365 connector boundaries required for the 0.2.0
calendar release.

The calendar is part of the mail client, not a separate scheduling product. Its
primary job is to let a person understand their time, act on invitations, and
turn an email into a real event without leaving Bharga.

## Intended outcome

Bharga must remain useful offline while faithfully synchronizing with the user's
calendar providers when connectivity returns. No example availability, seeded
events, or simulated invite actions may appear in the desktop runtime.

The release is successful when a user can:

- view their real calendars in month, week, day, and agenda modes;
- create, edit, move, duplicate, and delete timed or all-day events;
- work with recurring series and individual recurrence exceptions;
- manage attendees, reminders, visibility, availability, location, and meeting
  links;
- import and export `.ics` files without losing supported calendar semantics;
- accept, tentatively accept, decline, or add an invitation received by email;
- send standards-compliant invitations, updates, cancellations, and replies;
- connect a CalDAV account and synchronize changes in both directions;
- authorize Google Calendar or Microsoft 365 independently from mail access;
- continue reading and editing previously synchronized events while offline;
- see provider health, pending changes, conflicts, and authorization failures;
- use the primary calendar workflows with keyboard, pointer, touch, high
  contrast, and reduced-motion preferences.

## Standards baseline

The implementation follows the protocol semantics in these primary sources:

- [RFC 5545](https://www.rfc-editor.org/info/rfc5545/) for iCalendar objects;
- [RFC 5546](https://www.rfc-editor.org/info/rfc5546/) for iTIP scheduling;
- [RFC 4791](https://www.rfc-editor.org/info/rfc4791/) for CalDAV access;
- [RFC 6578](https://www.rfc-editor.org/info/rfc6578/) for WebDAV collection
  synchronization;
- [RFC 6638](https://www.rfc-editor.org/info/rfc6638/) for CalDAV scheduling;
- [RFC 6764](https://www.rfc-editor.org/info/rfc6764/) for CalDAV service
  discovery;
- [Google Calendar incremental synchronization](https://developers.google.com/workspace/calendar/api/guides/sync);
- [Microsoft Graph event delta](https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-1.0).

Provider behavior is normalized into Bharga's domain model, but provider-only
properties that Bharga does not understand must be preserved when possible so a
round trip does not destructively erase metadata.

## Architectural decision

### Local-first canonical model

SQLite is the canonical working copy used by the UI. Provider APIs are remote
replicas accessed through connector adapters. UI components never call CalDAV,
Google, or Microsoft directly.

This model was selected over two alternatives:

1. **Provider-first rendering** would reduce initial schema work but would make
   navigation depend on network latency, fragment behavior by provider, and make
   offline editing unreliable.
2. **Embedding a calendar UI library without a calendar core** would improve the
   grid but would leave synchronization, recurrence, invitations, security, and
   conflict handling unresolved.

The canonical model keeps the user experience consistent and makes provider
connectors independently testable. The cost is a deliberate synchronization
layer and conflict model, which are required for trustworthy desktop behavior.

### Module boundaries

The implementation is divided into units with narrow contracts:

- `calendar/domain` owns event, recurrence, attendee, reminder, and validation
  types.
- `calendar/store` owns schema migration, queries, atomic sync application, and
  the durable outbound operation queue.
- `calendar/ical` parses and writes iCalendar and iTIP messages.
- `calendar/connectors` defines the connector trait and provider-neutral sync
  outcomes.
- `calendar/connectors/caldav` owns discovery, WebDAV XML, sync tokens, ETags,
  conditional writes, and scheduling capability detection.
- `calendar/connectors/google` owns Google Calendar authorization and sync.
- `calendar/connectors/microsoft` owns Microsoft Graph authorization and sync.
- `calendar/sync` serializes per-source synchronization, retries safe failures,
  and emits health and change events to the UI.
- `calendar/reminders` calculates due reminders and emits native notifications.
- React calendar components consume only typed Tauri commands from the bridge.

Mail sync and calendar sync share generic OAuth and encrypted-secret
infrastructure but do not share provider tokens or failure state.

## Domain model

### Calendar source

A calendar source represents one local or remote account:

- stable Bharga identifier;
- optional linked mail account identifier;
- provider kind: `local`, `caldav`, `google`, or `microsoft`;
- non-secret account label and user address;
- encrypted credential reference;
- authorization state and capability flags;
- last successful attempt, last failure, retry time, and disabled state.

Calendar authorization is independent from mail authorization. Revoking or
removing calendar access must not invalidate Gmail or Microsoft mail tokens.
Removing a mail account does not silently delete a separately configured local
or CalDAV calendar source.

### Calendar collection

A source contains one or more calendars. Each calendar stores:

- local identifier and provider identifier or CalDAV collection URL;
- source identifier, name, description, color, and time zone;
- access role and writable/read-only state;
- selected, visible, and default-calendar preferences;
- provider ETag/CTag or sync token where applicable;
- deletion tombstone and timestamps.

The user may hide or reorder calendars without changing provider ownership.
Read-only and free/busy-only collections must never expose write actions.

### Calendar event

An event stores:

- local identifier, calendar identifier, RFC 5545 UID, provider identifier, and
  provider resource URL;
- title, description, location, conference URL, and source thread identifier;
- timed start/end instants or all-day start/end dates;
- canonical IANA time zone and original provider time-zone identifier;
- organizer, attendees, attendee roles, RSVP status, and comment;
- busy/free transparency, visibility, status, and event classification;
- recurrence rule, recurrence dates, excluded dates, recurrence identifier, and
  parent-series identifier;
- sequence, DTSTAMP, provider version/ETag, local revision, and last-modified
  metadata;
- reminder definitions;
- provider metadata and preserved iCalendar properties;
- pending, conflicted, deleted, and dirty-field state.

All-day end dates are exclusive, matching RFC 5545 and provider APIs. Timed
events are stored as UTC instants plus an IANA time zone. The frontend uses
`dayjs` with UTC and timezone plugins for all date arithmetic and formatting;
native JavaScript `Date` objects are forbidden. Rust uses its existing
time-zone-aware protocol types at the storage and connector boundary.

### Recurrence and exceptions

Recurring masters remain distinct from expanded occurrences. Bharga expands
only the visible range and never writes generated occurrences as independent
events. Modified or cancelled occurrences are stored as exception records keyed
by series UID and `RECURRENCE-ID`.

Editing a recurring occurrence always requires one of three explicit scopes:

- this occurrence;
- this and following occurrences;
- the complete series.

The core performs series splitting for “this and following.” It updates the old
series end and creates a new series with a new provider-safe identity inside one
local transaction before queuing provider operations.

### Durable outbound operations

Every local mutation and its outbound operation are committed atomically. Queue
entries include source, calendar, event, operation kind, local revision,
expected provider version, retry count, retry deadline, and a redacted error.

Operations are idempotent:

- create uses a stable client-generated UID and operation identity;
- update carries the expected ETag or provider revision;
- delete retains a tombstone until the provider acknowledges it;
- invitation sending records the event sequence and recipient set.

Permanent authorization, permission, validation, and conflict errors are not
blindly retried. Transient network and server errors use bounded exponential
backoff with jitter.

## Storage and migration

Schema migration 14 introduces normalized tables for sources, calendars,
events, attendees, reminders, sync state, recurrence exceptions, and queued
operations. Provider payload fragments are stored as bounded JSON only when
they preserve fields that do not belong in the normalized model.

Before the first migration of an existing user database, the application makes
a verified timestamped backup beside the database. The migration runs in a
single SQLite transaction. Failure leaves the original database and backup
intact and presents a recovery error; a calendar migration failure must never
trigger destructive database recreation.

The migration removes no existing mail, task, account, outbox, secret, or AI
records. Legacy demo events are code-only and are removed rather than migrated.

Calendar queries are indexed by calendar/start/end, UID, provider identity,
dirty state, and reminder due time. Range queries expand recurrence after
fetching the relevant masters and exceptions.

## Connector contract

Every connector implements the same responsibilities:

- discover or list remote calendars;
- perform initial and incremental synchronization;
- create, update, and delete one event conditionally;
- expose free/busy and scheduling capabilities when the provider supports them;
- translate remote failures into stable auth, permission, conflict, transient,
  unsupported, or invalid-data categories;
- map provider payloads to and from the canonical event model;
- return new cursors only after a complete successful page sequence.

A connector does not write directly to the database. It returns a bounded sync
batch that the calendar store applies atomically. The next cursor is committed
in the same transaction as the batch, preventing skipped changes after a crash.

Only one sync runs per source. Concurrent manual and background requests join
the active run rather than racing it.

## CalDAV

### Account setup

The setup flow accepts an email or server URL, username, authentication method,
and credential. It attempts RFC 6764 discovery, then well-known CalDAV, then the
explicit URL. The user reviews discovered calendars before saving.

Credentials are encrypted using Bharga's existing master-key-backed secret
store. Passwords and bearer tokens never cross back to the frontend after save.
TLS verification is mandatory. Redirects may not forward credentials to a
different origin without a fresh explicit authorization step.

### Synchronization

The connector discovers the principal and calendar home, enumerates calendar
collections, and records supported reports and scheduling features.

For collections supporting RFC 6578, `sync-collection` is the incremental path.
Otherwise the connector falls back to CTag comparison and a bounded
`calendar-query`/multiget reconciliation. A rejected or expired sync token
causes a full collection reconciliation without deleting unsynchronized local
operations.

Writes use conditional `PUT` and `DELETE`:

- new resources use `If-None-Match: *`;
- updates and deletes use the last observed ETag;
- HTTP 409/412 becomes a conflict and preserves both local and remote versions.

Server-provided resource URLs are treated as opaque. The client does not derive
identity from a filename.

### Scheduling

When a server advertises RFC 6638 scheduling, Bharga uses the scheduling outbox
and inbox. Otherwise it sends iMIP email through the user's selected mail
account. The interface states which transport will be used before sending.

## Google Calendar

Google Calendar uses a calendar-specific OAuth grant stored under a separate
credential namespace. Least-privilege calendar list and event scopes are
requested; Gmail scopes are neither reused nor expanded silently.

Initial sync consumes every result page before saving `nextSyncToken`.
Incremental sync reuses the same query shape and includes deletions. HTTP 410
invalidates only the affected calendar cursor and performs a full
reconciliation, as required by the provider.

Recurring masters and exceptions remain distinguishable. Provider-generated
conference data and unsupported extended properties are preserved. Invitation
delivery options are explicit so an edit never emails attendees unexpectedly.

## Microsoft 365

Microsoft Calendar uses a calendar-specific Microsoft Graph grant with
`Calendars.ReadWrite`, identity, and offline access scopes. Mail access remains
independent.

Calendar and event synchronization follows provider delta links. Delta links
are stored by provider-supported range or collection scope and are treated as
opaque. Expired cursors cause reconciliation of that scope. Cancelled and
removed events become local tombstones; they are not confused with a transient
missing page.

Graph transaction identities are used where supported. Online meeting payloads
and provider-only fields are preserved without exposing raw OAuth data to the
UI.

## iCalendar and invitation interoperability

### Parsing

The parser supports the event and scheduling fields required for real-world
mail and provider interoperability:

- `VEVENT`, `VTIMEZONE`, `VALARM`, `UID`, `SEQUENCE`, and `DTSTAMP`;
- `DTSTART`, `DTEND`, `DURATION`, floating values, UTC values, local values, and
  all-day dates;
- `RRULE`, `RDATE`, `EXDATE`, and `RECURRENCE-ID`;
- organizer and attendee parameters, RSVP, role, participation status, and
  delegated relationships;
- summary, description, location, URL, status, transparency, classification,
  categories, and conference links;
- `METHOD:PUBLISH`, `REQUEST`, `REPLY`, and `CANCEL`.

Malformed input returns a line-independent, user-readable error and never
partially writes an event. Input size, property count, recurrence expansion, and
nesting are bounded. Remote attachments and URLs are not fetched automatically.

### Import and export

File import presents a review of calendars, duplicates, conflicts, warnings,
and unsupported components before committing. Duplicate detection prioritizes
UID and recurrence identity rather than title and time.

Export can produce one event, a recurring series, a calendar range, or a full
calendar. The exporter uses CRLF, escaped text, folded content lines, stable
UIDs, correct time-zone components, and standards-compliant all-day end dates.

Unknown but safe properties from an imported or synchronized object are
preserved on export when doing so cannot contradict a user edit.

### Mail invitations

Messages with `text/calendar` content or `.ics` attachments display a calendar
invitation card after the MIME data is parsed by the Rust core. The card shows
organizer identity, time zone, recurrence, location, attendees, update status,
and conflicts with visible calendars.

Actions are determined by iTIP method and sequence:

- `REQUEST`: Accept, Tentative, Decline, or Add without response;
- `CANCEL`: remove or mark the matching event cancelled after confirmation;
- `REPLY`: update attendee state only when the current user is the organizer;
- stale sequence numbers are identified and cannot overwrite a newer event.

Sending or updating an event builds both a human-readable mail body and a
`text/calendar` MIME part. `REQUEST`, `CANCEL`, and `REPLY` messages use the
correct method, UID, sequence, and attendee state. The user confirms recipients
before delivery.

## Calendar user experience

### Layout

Calendar becomes a full workspace rather than a generic content card:

- a toolbar contains Today, previous/next, date context, view switcher, search,
  sync health, and New event;
- a collapsible calendar sidebar contains a mini month, calendar visibility,
  source health, and account management entry points;
- the main surface provides month, week, day, and agenda views;
- the current time, working hours, weekends, all-day events, overlapping events,
  and multi-day spans have distinct but restrained presentation;
- narrow windows use agenda or compact day presentation instead of squeezing a
  seven-column desktop grid.

The default view and visible calendars are durable settings. Initial focus and
keyboard navigation return to the previously selected date and event.

### Event editor

The accessible event dialog supports:

- title, calendar, start/end, all-day, and time zone;
- recurrence presets plus a custom recurrence editor;
- location, conferencing URL, description, attendees, reminders, visibility,
  and busy/free status;
- save, duplicate, delete, and invitation-update controls;
- read-only explanation when provider permissions prevent editing;
- dirty-state protection and field-level validation.

The editor makes attendee notification behavior explicit. Closing a dirty
editor requires confirmation. Provider errors keep the local edit and show its
pending or conflicted state.

### Direct manipulation and keyboard access

Pointer drag creates an event in week/day views. Existing events may be moved or
resized only when writable. Each direct-manipulation action has keyboard and
dialog alternatives.

The grid follows an ARIA grid pattern with predictable arrow-key navigation.
Enter opens the selected event, `N` creates an event at the selected slot,
Delete requests deletion, and Escape exits transient selection. Global
shortcuts do not fire while typing in an editor.

Touch targets are at least 44 px on coarse-pointer layouts. Focus indicators are
always visible for keyboard navigation. Reduced motion removes animated layout
interpolation and drag-settling transitions.

### Mail-to-calendar flow

“Schedule from thread” opens the event editor with a suggested title, source
thread reference, and deduplicated participant addresses. It does not invent
availability, choose a time, send mail, or write an event without confirmation.

Free/busy suggestions use only calendars the user selected for availability.
If provider free/busy data is incomplete, the UI says so instead of claiming the
time is free.

## Reminders and notifications

Each event may inherit calendar defaults or define bounded display/email
reminders. Bharga schedules display reminders from the local store and emits
native notifications while the desktop process is running, including while its
window is hidden. Startup reconciliation surfaces recently missed reminders
without replaying stale notifications indefinitely.

Provider-managed email reminders are synchronized when supported. Bharga does
not claim reliable delivery of its own email reminders while the application is
not running.

Notification text respects private-event visibility. Secrets, private notes,
attendee lists, and provider payloads never appear in logs or diagnostics.

## Conflict handling

Bharga never resolves a write-write conflict silently.

- If the local event is clean, a newer remote version replaces it.
- If a local edit has not been sent and the remote version is unchanged, the
  queued write proceeds conditionally.
- If both sides changed, the remote version and local draft are retained and the
  event is marked conflicted.
- The conflict view compares user-editable fields and offers Keep local, Use
  remote, or Duplicate. Keep local performs a new conditional write against the
  freshly observed remote version.
- Recurring-series conflicts operate on the master and exceptions together so
  an exception is never orphaned.

The user can continue navigating and editing unrelated events while a conflict
exists.

## Security and privacy

- Calendar credentials and OAuth refresh tokens use the encrypted secrets
  store; they are write-only over IPC.
- Token namespaces are separated by capability and account.
- Provider responses, ICS files, XML documents, recurrence expansion, and
  attachment sizes have strict limits.
- XML parsing disables external entities and network resolution.
- Calendar text is rendered as text or sanitized rich content, never trusted
  provider HTML.
- Imported URLs use the existing validated external-link boundary.
- CalDAV uses verified TLS by default. An enterprise custom-CA design is a
  separate trust-store feature; insecure certificate bypass is not provided.
- Redirects, credential forwarding, and cross-origin discovery follow explicit
  allow rules.
- Diagnostics redact credentials, tokens, event bodies, attendees, locations,
  conference links, remote URLs containing user data, and calendar payloads.
- Deleting a source reports partial credential-cleanup failures and never claims
  success until local data and credentials meet the selected removal policy.

## Error and empty states

Calendar state is never represented by a blank grid alone. The workspace has
distinct states for:

- no calendar configured;
- connected but currently empty;
- offline with a last-successful-sync time;
- authorization required;
- read-only provider access;
- pending local changes;
- partial provider failure;
- sync conflict;
- malformed invitation;
- migration or local-store recovery required.

Every failure says what remains safe locally and offers the next valid action.
Errors are categorized in the Rust core; the UI does not infer behavior from
provider message strings.

## Background synchronization

Calendar sync runs at startup, after a successful calendar mutation, on manual
refresh, after network recovery when detectable, and on a bounded interval while
the process is active. Hidden-window operation is supported because Bharga
remains in the desktop process after the window closes on macOS.

The scheduler applies jitter, respects provider retry headers, and suspends a
source after a permanent authorization failure. Sync never runs concurrently for
the same source and never blocks mail synchronization.

The frontend receives coarse events such as `calendar:changed`,
`calendar:health`, and `calendar:reminder`; provider payloads do not cross the
event bus.

## Tauri command surface

The frontend bridge uses typed commands grouped around user intent:

- list sources and calendars;
- query an event range or agenda page;
- get one event and its recurrence context;
- create, update, move, duplicate, or delete an event;
- resolve a recurrence edit scope;
- import or export iCalendar data;
- inspect and respond to a mail invitation;
- connect, test, update, synchronize, or remove a calendar source;
- query free/busy information;
- resolve a conflict;
- list provider health and pending operations.

Command inputs are validated again in Rust. IDs are opaque. Bulk commands have
explicit item and payload limits.

## Accessibility and motion acceptance

- Views, toolbar, mini month, event blocks, dialogs, invitation cards, and
  conflict controls meet WCAG 2.1 AA semantics and contrast in both themes.
- All functionality is reachable without pointer drag.
- Modal focus is contained and restored using the shared modal primitive.
- Screen readers receive full event names and times without reading decorative
  grid labels repeatedly.
- Live regions announce save, sync, invitation, and conflict outcomes without
  announcing every background event update.
- Motion uses the existing shared tokens and compositor-safe properties.
- Calendar navigation does not animate the whole grid. Direct manipulation may
  animate only the affected event and drop target.

## Testing strategy

### Rust unit and integration tests

- migration from schema 13 and preservation of every existing table;
- event CRUD, range queries, all-day boundaries, and time-zone conversion;
- recurrence expansion, exclusions, moved instances, series splitting, DST
  transitions, and bounded pathological rules;
- ICS parse/write round trips and fixed interoperability fixtures;
- iTIP request, update, cancellation, reply, and stale-sequence behavior;
- CalDAV discovery, multistatus parsing, sync-token fallback, conditional writes,
  redirects, auth failures, and ETag conflicts against a local test server;
- Google pagination, incremental tokens, deletion, and HTTP 410 recovery;
- Microsoft delta paging, deletion, cursor recovery, and recurrence mapping;
- durable queue retry, idempotency, crash recovery, and conflict retention;
- secret lifecycle and redacted diagnostics.

### Frontend unit and component tests

- deterministic dayjs date/range calculations across locale and DST boundaries;
- month, week, day, and agenda rendering from the same canonical events;
- overlap layout, all-day spans, recurrence indicators, and pending/conflict
  state;
- event-editor validation and recurrence-scope flows;
- invitation actions and mail-to-calendar prefill;
- source setup, health, offline, empty, error, and conflict states;
- keyboard grid behavior, focus restoration, reduced motion, and touch targets.

### End-to-end verification

- local create/edit/delete while offline, followed by successful sync;
- CalDAV two-way synchronization against a standards-compatible test server;
- ICS exchange fixtures from Apple Calendar, Google Calendar, Microsoft Outlook,
  and common CalDAV servers;
- invitation receive/respond/update/cancel flow through the mail client;
- account removal without mail regression or credential leakage;
- clean installation, schema-13 upgrade with verified backup, and rollback after
  an injected migration failure;
- light/dark and desktop/narrow-window visual review;
- complete Bun test/build and Rust test/check gates.

Live Google and Microsoft smoke tests use operator-owned test tenants and remain
separate from deterministic CI. CI never requires personal provider credentials.

## Delivery sequence

The calendar is one 0.2.0 program delivered through independently verifiable
commits:

1. canonical domain, migration, local CRUD, recurrence, and typed IPC;
2. production month/week/day/agenda UI and accessible editor;
3. ICS import/export plus mail invitation receive/send/respond;
4. CalDAV setup, synchronization, conflicts, and source health;
5. Google Calendar connector and separate authorization;
6. Microsoft 365 connector and separate authorization;
7. reminders, free/busy assistance, background sync, diagnostics, and release
   hardening.

No stage reintroduces fake data. Before a remote connector is complete, it is
shown as unavailable rather than simulated.

## Explicit non-goals for 0.2.0

- public booking pages or Calendly-style availability links;
- organization-wide room/resource administration;
- shared-calendar ACL administration;
- Exchange Web Services support;
- Apple Reminders or VTODO task synchronization;
- server push infrastructure while Bharga is not running;
- video-conference account provisioning;
- unverified TLS or a global certificate-warning bypass.

These exclusions do not reduce normal personal and enterprise calendar usage;
they prevent the desktop mail client from becoming a separate scheduling SaaS
or infrastructure administration product.

## Release gates

Bharga Mail 0.2.0 may be described as having a real calendar only when:

- preview copy and legacy seed-event behavior are removed;
- local CRUD and all four views operate on persisted events;
- recurrence and ICS interoperability suites pass;
- CalDAV sync passes deterministic two-way integration tests;
- any visible Google or Microsoft connector passes its deterministic contract
  tests and a recorded test-tenant smoke test;
- invitation actions produce valid iTIP and never claim delivery before the mail
  outbox accepts the message;
- migration backup and rollback are verified with a copy of a schema-13 store;
- authorization loss, offline work, pending writes, and conflicts are visible;
- frontend tests/build, Rust tests/check, open-source hygiene, and version
  integrity checks pass;
- packaged-device keyboard, reduced-motion, notification, and native compositor
  behavior receive a final manual pass.
