# Bharga Mail Calendar Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the calendar preview with a persisted, offline-capable calendar supporting local events, recurrence, ICS/iTIP, CalDAV, Google Calendar, Microsoft 365, reminders, and mail-integrated invitations.

**Architecture:** SQLite is the canonical working copy and every remote provider implements a connector contract around it. Local mutations and durable outbound operations commit atomically; connector sync batches and their cursors also commit atomically. React consumes typed Tauri commands only and renders one canonical event model across month, week, day, and agenda views.

**Tech Stack:** Tauri 2, Rust 2021, SQLite/rusqlite, reqwest, icalendar 0.17.6, rrule 0.14.0, chrono/chrono-tz, quick-xml 0.39.4, React 19, TypeScript 5.9, Zustand, dayjs UTC/timezone, Vitest, Bun.

**Spec:** `docs/superpowers/specs/2026-09-25-calendar-platform-design.md`

## Global Constraints

- Use Bun for every frontend dependency and script; never use npm, pnpm, or Yarn.
- Use `dayjs` with UTC/timezone plugins for frontend dates; never construct native JavaScript `Date` objects.
- Do not introduce `cn`, `cva`, CommonJS `import * as`, seeded desktop events, mock availability, or simulated provider success.
- Calendar credentials and refresh tokens remain write-only over IPC and use the existing master-key-backed encrypted secret store.
- Calendar OAuth tokens use capability-specific namespaces and must never replace Gmail or Microsoft mail tokens.
- Back up and verify an existing SQLite database before schema migration 14; migration failure preserves the original store.
- Bound ICS/XML bytes, property counts, recurrence expansion, query windows, redirect count, and bulk IPC inputs.
- Keep all provider payloads and calendar text out of logs, diagnostics, and user-visible raw errors.
- All local event changes work offline and enter the durable operation queue in the same SQLite transaction.
- Provider writes use conditional versions; Bharga never resolves write-write conflicts silently.
- CI uses deterministic fixtures and local HTTP servers; personal calendar credentials never enter tests.
- Preserve the user-owned untracked `AGENTS.md` and stage only task-owned files.
- Each task follows RED → verify failure → GREEN → full relevant suite → narrow commit.

## Review Focus

1. **DST and all-day boundaries:** creating an event across a daylight-saving transition or viewing an all-day event in another time zone must preserve the intended local dates and duration; Task 3 adds these recurrence/range tests.
2. **Concurrent remote edits:** a stale ETag or provider revision must preserve both local and remote values and mark a conflict instead of overwriting; Tasks 8 and 10 add conditional-write tests.
3. **Hostile calendar payloads:** oversized ICS/XML, entity declarations, pathological recurrence, and redirect credential leaks must fail before persistence or network expansion; Tasks 4 and 8 add bounded parser and connector tests.
4. **Revoked calendar authorization:** calendar reauthorization must be requested while existing mail sync and mail credentials continue working; Tasks 9 and 10 assert namespace and failure isolation.
5. **Stale invitations:** a lower iTIP sequence or mismatched organizer must not replace a newer event or send a response; Task 7 pins this behavior.

---

## File Structure

### Rust core

- `app/src-tauri/src/calendar/mod.rs` — calendar module exports and shared error categories.
- `app/src-tauri/src/calendar/domain.rs` — provider-neutral source, calendar, event, attendee, reminder, recurrence, conflict, and input types.
- `app/src-tauri/src/calendar/store.rs` — calendar persistence, range queries, atomic local mutations, sync-batch commits, and operation queue.
- `app/src-tauri/src/calendar/recurrence.rs` — bounded recurrence expansion and series splitting.
- `app/src-tauri/src/calendar/ical.rs` — RFC 5545/iTIP parsing and generation.
- `app/src-tauri/src/calendar/connectors/mod.rs` — connector trait, sync batches, capability and error contracts.
- `app/src-tauri/src/calendar/connectors/caldav.rs` — discovery, WebDAV XML, CalDAV sync, conditional writes, and scheduling capabilities.
- `app/src-tauri/src/calendar/connectors/google.rs` — calendar-specific Google OAuth and incremental sync.
- `app/src-tauri/src/calendar/connectors/microsoft.rs` — calendar-specific Microsoft Graph OAuth and delta sync.
- `app/src-tauri/src/calendar/sync.rs` — per-source serialization, queue flushing, retries, conflicts, and Tauri change events.
- `app/src-tauri/src/calendar/reminders.rs` — due-reminder calculation and native notification dispatch.
- `app/src-tauri/src/calendar/commands.rs` — validated Tauri command handlers.
- `app/src-tauri/src/store/mod.rs` — schema-14 migration, verified pre-migration backup, and crate-visible connection accessor.
- `app/src-tauri/src/sync/mime.rs` — standards-compliant `text/calendar` MIME parts.
- `app/src-tauri/src/lib.rs` — calendar module registration, state, background tasks, and command registration.

### React frontend

- `app/src/calendar/types.ts` — TypeScript mirror of the canonical calendar IPC types.
- `app/src/calendar/date.ts` — dayjs-only range, slot, all-day, timezone, and display helpers.
- `app/src/calendar/layout.ts` — deterministic overlap and multi-day event layout.
- `app/src/calendar/store.ts` — calendar-specific Zustand state and async actions.
- `app/src/calendar/CalendarWorkspace.tsx` — workspace composition and responsive view selection.
- `app/src/calendar/CalendarToolbar.tsx` — date navigation, view selector, search, health, and create action.
- `app/src/calendar/CalendarSidebar.tsx` — mini month, collection visibility, ordering, and source health.
- `app/src/calendar/MonthView.tsx` — month grid and multi-day/all-day spans.
- `app/src/calendar/TimeGrid.tsx` — shared week/day time grid, overlap positioning, current time, and keyboard selection.
- `app/src/calendar/AgendaView.tsx` — accessible grouped agenda with paging.
- `app/src/calendar/EventDialog.tsx` — create/edit/duplicate/delete form.
- `app/src/calendar/RecurrenceEditor.tsx` — recurrence presets, custom rule, and edit-scope dialog.
- `app/src/calendar/InvitationCard.tsx` — mail invitation summary and RSVP actions.
- `app/src/calendar/SourceDialog.tsx` — local, CalDAV, Google, and Microsoft source setup.
- `app/src/calendar/ConflictDialog.tsx` — local/remote comparison and resolution.
- `app/src/calendar/calendar.css` — calendar layout, themes, focus, touch, print, and reduced motion.
- `app/src/lib/bridge.ts` — typed calendar IPC methods.
- `app/src/components/CalendarView.tsx` — compatibility entry that renders `CalendarWorkspace`.
- `app/src/components/Stage.tsx` — invitation attachment/card integration and schedule-from-thread intent.
- `app/src/components/settings/AccountSettings.tsx` — calendar-source management entry.
- `app/src/styles.css` — remove legacy preview grid rules and import calendar styles.

## Task 1: Add the calendar domain and safe schema-14 migration

**Files:**
- Create: `app/src-tauri/src/calendar/mod.rs`
- Create: `app/src-tauri/src/calendar/domain.rs`
- Create: `app/src-tauri/src/calendar/store.rs`
- Modify: `app/src-tauri/src/store/mod.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src-tauri/Cargo.toml`
- Test: `app/src-tauri/src/calendar/store.rs`
- Test: `app/src-tauri/src/store/mod.rs`

**Interfaces:**
- Produces: `CalendarSource`, `Calendar`, `CalendarEvent`, `EventAttendee`, `EventReminder`, `CalendarOperation`, `EventMutation`, `EventRange`, and `Store::{calendar_sources, calendars, calendar_events, create_calendar_event, update_calendar_event, delete_calendar_event}`.
- Produces: schema version 14 and `backup_before_migration(path: &Path, from: i64, to: i64) -> rusqlite::Result<Option<PathBuf>>`.

- [ ] **Step 1: Add schema and backup tests before production code**

```rust
#[test]
fn migration_14_preserves_mail_and_creates_calendar_tables() {
    let (path, original) = schema_13_fixture();
    let store = Store::open(path.clone()).unwrap();
    assert_eq!(store.thread(&original.thread_id).unwrap().subject, original.subject);
    assert_eq!(store.schema_version().unwrap(), 14);
    assert!(store.table_exists("calendar_events").unwrap());
    assert!(verified_backup_for(&path, 13, 14).is_some());
}

#[test]
fn local_event_and_pending_create_commit_together() {
    let store = Store::in_memory().unwrap();
    let calendar = store.create_local_calendar("Personal", "#6f8df6", "Europe/Berlin").unwrap();
    let event = store.create_calendar_event(new_event(&calendar.id)).unwrap();
    assert_eq!(store.calendar_operation_for(&event.id).unwrap().kind, OperationKind::Create);
}
```

- [ ] **Step 2: Run the focused Rust tests and verify RED**

Run: `cd app/src-tauri && cargo test migration_14_preserves_mail_and_creates_calendar_tables -- --nocapture && cargo test local_event_and_pending_create_commit_together -- --nocapture`

Expected: compilation fails because schema-14 and calendar types do not exist.

- [ ] **Step 3: Add pinned, MSRV-compatible dependencies**

```toml
icalendar = { version = "=0.17.6", features = ["parser", "chrono-tz"] }
rrule = { version = "=0.14.0", features = ["serde"] }
chrono-tz = "=0.10.4"
quick-xml = { version = "=0.39.4", features = ["serialize"] }
uuid = { version = "=1.11.0", features = ["v4", "serde"] }
```

Run: `cd app && bunx tauri info`

- [ ] **Step 4: Define the canonical domain and migration**

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub calendar_id: String,
    pub uid: String,
    pub title: String,
    pub description: String,
    pub location: String,
    pub start: EventMoment,
    pub end: EventMoment,
    pub timezone: String,
    pub recurrence: Option<RecurrenceSet>,
    pub recurrence_id: Option<String>,
    pub status: EventStatus,
    pub transparency: Transparency,
    pub visibility: EventVisibility,
    pub organizer: Option<EventPerson>,
    pub attendees: Vec<EventAttendee>,
    pub reminders: Vec<EventReminder>,
    pub revision: i64,
    pub sync_state: EventSyncState,
}
```

Implement migration 14 with foreign keys and indexes for source, calendar, time range, UID/recurrence identity, pending operations, conflicts, and due reminders. Make `Store::open` read `PRAGMA user_version`, create and fsync a timestamped copy when upgrading a file-backed schema below 14, reopen/verify the copy, then migrate transactionally.

- [ ] **Step 5: Implement atomic local CRUD and validation**

Validate non-empty title, valid calendar, writable access, start before end, exclusive all-day end, valid IANA time zone, bounded attendees/reminders/text, and matching timed/all-day moment variants. Create/update/delete must write the event revision and operation row in one transaction.

- [ ] **Step 6: Run focused and full Rust verification**

Run: `cd app/src-tauri && cargo test calendar::store && cargo test store::tests::migrates_stale_imap_accounts_schema && cargo check`

Expected: calendar storage tests pass, existing migration test passes, and `cargo check` exits 0.

- [ ] **Step 7: Commit the domain and migration**

```bash
git add app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock app/src-tauri/src/calendar app/src-tauri/src/store/mod.rs app/src-tauri/src/lib.rs
git commit -m "feat: add persisted calendar domain"
```

## Task 2: Expose validated local calendar IPC

**Files:**
- Create: `app/src-tauri/src/calendar/commands.rs`
- Modify: `app/src-tauri/src/calendar/mod.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src/types.ts`
- Modify: `app/src/lib/bridge.ts`
- Test: `app/src-tauri/src/calendar/commands.rs`
- Test: `app/src/lib/bridge.desktop.test.ts`

**Interfaces:**
- Consumes: Task 1 store CRUD.
- Produces: `list_calendar_sources`, `list_calendars`, `list_calendar_events`, `get_calendar_event`, `create_calendar_event`, `update_calendar_event`, `delete_calendar_event`, `create_local_calendar`, and `set_calendar_visibility` commands plus matching `api.calendar.*` methods.

- [ ] **Step 1: Write failing Rust command-boundary tests**

```rust
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
    assert_eq!(validate_event(mixed_moment_input()).unwrap_err().code, "invalid-time-shape");
}
```

- [ ] **Step 2: Run command tests and verify RED**

Run: `cd app/src-tauri && cargo test calendar::commands -- --nocapture`

Expected: compilation fails because the command module does not exist.

- [ ] **Step 3: Implement commands with structured errors**

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarCommandError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

#[tauri::command]
pub fn list_calendar_events(
    input: EventRangeInput,
    state: State<'_, AppState>,
) -> Result<Vec<CalendarEvent>, CalendarCommandError> {
    let range = validate_range(&input)?;
    state.store.calendar_events(&range).map_err(store_error)
}
```

Register every command explicitly in `generate_handler!`; remove the old `CalEvent` command and type.

- [ ] **Step 4: Write a failing desktop-bridge invocation test**

```ts
it("sends bounded range inputs to the calendar command", async () => {
  await api.calendar.listEvents({ start: "2026-09-01T00:00:00Z", end: "2026-10-01T00:00:00Z" });
  expect(invoke).toHaveBeenCalledWith("list_calendar_events", {
    input: { start: "2026-09-01T00:00:00Z", end: "2026-10-01T00:00:00Z" },
  });
});
```

- [ ] **Step 5: Run the bridge test and verify RED**

Run: `cd app && bun run test -- src/lib/bridge.desktop.test.ts`

Expected: fails because `api.calendar` is missing.

- [ ] **Step 6: Add TypeScript mirrors and bridge methods**

Create exact discriminated unions for `EventMoment`, provider kind, status, access role, sync state, and command errors. Browser preview uses an in-memory local calendar repository, never imported mock events or fake connector results.

- [ ] **Step 7: Verify and commit IPC**

Run: `cd app && bun run test -- src/lib/bridge.desktop.test.ts && bun run build`

Run: `cd app/src-tauri && cargo test calendar::commands && cargo check`

```bash
git add app/src-tauri/src/calendar app/src-tauri/src/lib.rs app/src/types.ts app/src/lib/bridge.ts app/src/lib/bridge.desktop.test.ts
git commit -m "feat: expose calendar commands"
```

## Task 3: Implement recurrence, timezone, and occurrence expansion

**Files:**
- Create: `app/src-tauri/src/calendar/recurrence.rs`
- Modify: `app/src-tauri/src/calendar/domain.rs`
- Modify: `app/src-tauri/src/calendar/store.rs`
- Test: `app/src-tauri/src/calendar/recurrence.rs`

**Interfaces:**
- Consumes: canonical events and range queries.
- Produces: `expand_event(event, range, limit) -> Result<Vec<EventOccurrence>, CalendarError>` and `split_series(store, event_id, recurrence_id, patch) -> Result<SeriesSplit, CalendarError>`.

- [ ] **Step 1: Write failing recurrence and DST tests**

```rust
#[test]
fn weekly_berlin_event_keeps_nine_am_across_dst() {
    let occurrences = expand_event(&weekly_berlin_event(), march_range(), 128).unwrap();
    assert_eq!(local_times(&occurrences, "Europe/Berlin"), vec!["09:00", "09:00", "09:00"]);
    assert_ne!(occurrences[0].start_utc, occurrences[1].start_utc - Duration::weeks(1));
}

#[test]
fn all_day_dates_do_not_shift_in_los_angeles() {
    let occurrence = expand_event(&berlin_all_day_event(), visible_range(), 8).unwrap().remove(0);
    assert_eq!(occurrence.start_date.as_deref(), Some("2026-10-25"));
    assert_eq!(occurrence.end_date.as_deref(), Some("2026-10-26"));
}

#[test]
fn expansion_rejects_pathological_rule_before_limit() {
    assert_eq!(expand_event(&minutely_forever(), year_range(), 512).unwrap_err().code(), "recurrence-limit");
}
```

- [ ] **Step 2: Verify RED**

Run: `cd app/src-tauri && cargo test calendar::recurrence -- --nocapture`

Expected: compilation fails because recurrence expansion does not exist.

- [ ] **Step 3: Implement bounded RRULE/RDATE/EXDATE expansion**

Normalize valid rules through `rrule`, preserve the event's IANA time zone, subtract exclusions, merge additional dates, apply stored exceptions, sort, deduplicate, and reject more than 512 occurrences or a range over 366 days per request.

- [ ] **Step 4: Implement recurrence edit scopes**

`ThisOccurrence` creates or updates an exception. `EntireSeries` patches the master. `ThisAndFollowing` truncates the original rule before the recurrence ID and creates a new master and operation set transactionally.

- [ ] **Step 5: Verify recurrence and store integration**

Run: `cd app/src-tauri && cargo test calendar::recurrence && cargo test calendar::store && cargo check`

- [ ] **Step 6: Commit recurrence**

```bash
git add app/src-tauri/src/calendar
git commit -m "feat: add bounded calendar recurrence"
```

## Task 4: Parse and generate ICS/iTIP safely

**Files:**
- Create: `app/src-tauri/src/calendar/ical.rs`
- Create: `app/src-tauri/tests/fixtures/calendar/apple-recurring.ics`
- Create: `app/src-tauri/tests/fixtures/calendar/google-invite.ics`
- Create: `app/src-tauri/tests/fixtures/calendar/outlook-update.ics`
- Create: `app/src-tauri/tests/fixtures/calendar/caldav-timezone.ics`
- Modify: `app/src-tauri/src/calendar/mod.rs`
- Test: `app/src-tauri/src/calendar/ical.rs`

**Interfaces:**
- Produces: `parse_calendar(bytes, limits) -> Result<ParsedCalendar, CalendarError>`, `write_calendar(events, options) -> Result<Vec<u8>, CalendarError>`, and `build_itip(event, method, actor) -> Result<Vec<u8>, CalendarError>`.

- [ ] **Step 1: Add failing fixture and hostile-input tests**

```rust
#[test]
fn round_trips_uid_recurrence_timezone_and_attendees() {
    let parsed = parse_calendar(include_bytes!("../../tests/fixtures/calendar/google-invite.ics"), Limits::default()).unwrap();
    let encoded = write_calendar(&parsed.events, ExportOptions::default()).unwrap();
    let reparsed = parse_calendar(&encoded, Limits::default()).unwrap();
    assert_semantically_equal(&parsed.events, &reparsed.events);
}

#[test]
fn rejects_oversized_and_pathological_inputs_without_partial_events() {
    assert_eq!(parse_calendar(&vec![b'X'; MAX_ICS_BYTES + 1], Limits::default()).unwrap_err().code(), "ics-too-large");
    assert_eq!(parse_calendar(pathological_rrule(), Limits::default()).unwrap_err().code(), "recurrence-limit");
}
```

- [ ] **Step 2: Verify RED**

Run: `cd app/src-tauri && cargo test calendar::ical -- --nocapture`

- [ ] **Step 3: Implement parser normalization**

Parse CRLF/folded lines through `icalendar`, normalize UTC/local/all-day moments, capture `VTIMEZONE`, `VALARM`, attendees, recurrence, `METHOD`, `SEQUENCE`, and `RECURRENCE-ID`, retain bounded safe unknown properties, and return no events if any required property is invalid.

- [ ] **Step 4: Implement standards-compliant writer**

Emit CRLF, 75-octet folding, escaped text, exclusive all-day ends, stable UID, incremented sequence, DTSTAMP, timezone components, alarms, recurrence, attendee parameters, and `METHOD:PUBLISH|REQUEST|REPLY|CANCEL`.

- [ ] **Step 5: Verify fixtures and commit**

Run: `cd app/src-tauri && cargo test calendar::ical && cargo check`

```bash
git add app/src-tauri/src/calendar app/src-tauri/tests/fixtures/calendar
git commit -m "feat: add calendar interoperability core"
```

## Task 5: Build dayjs calendar math and frontend state

**Files:**
- Create: `app/src/calendar/types.ts`
- Create: `app/src/calendar/date.ts`
- Create: `app/src/calendar/date.test.ts`
- Create: `app/src/calendar/layout.ts`
- Create: `app/src/calendar/layout.test.ts`
- Create: `app/src/calendar/store.ts`
- Create: `app/src/calendar/store.test.ts`
- Modify: `app/src/lib/bridge.ts`

**Interfaces:**
- Consumes: Task 2 bridge.
- Produces: `calendarRange(anchor, view, timezone)`, `monthCells`, `weekDays`, `layoutTimedEvents`, `layoutMonthSpans`, and `useCalendar` actions.

- [ ] **Step 1: Write failing dayjs range and layout tests**

```ts
it("keeps an all-day event on its source dates in every viewer timezone", () => {
  expect(allDayLabel({ startDate: "2026-10-25", endDate: "2026-10-26" }, "America/Los_Angeles"))
    .toEqual({ start: "2026-10-25", endExclusive: "2026-10-26" });
});

it("places overlapping timed events in deterministic columns", () => {
  expect(layoutTimedEvents(overlapFixture())).toMatchObject([
    { id: "a", column: 0, columnCount: 2 },
    { id: "b", column: 1, columnCount: 2 },
  ]);
});
```

- [ ] **Step 2: Verify RED**

Run: `cd app && bun run test -- src/calendar/date.test.ts src/calendar/layout.test.ts`

- [ ] **Step 3: Implement date helpers without native Date**

Extend dayjs once with `utc`, `timezone`, `isoWeek`, `localizedFormat`, and `advancedFormat`. Accept ISO strings and date-only strings, derive bounded provider query ranges, and keep all-day calculations date-based.

- [ ] **Step 4: Implement overlap and span layout as pure functions**

Sort by start, then duration, then ID; allocate the first free column; compute group column counts; split multi-day spans by visible week without changing event identity.

- [ ] **Step 5: Write failing store behavior tests**

```ts
it("keeps an offline edit visible when provider refresh fails", async () => {
  const store = createCalendarStore(failingSyncApi());
  await store.getState().updateEvent("e1", { title: "Local title" });
  await expect(store.getState().syncSource("s1")).rejects.toMatchObject({ code: "offline" });
  expect(store.getState().events.e1).toMatchObject({ title: "Local title", syncState: "pending" });
});
```

- [ ] **Step 6: Implement normalized calendar state**

Store sources/calendars/events by ID, visible calendar IDs, anchor/view/timezone, selected occurrence, range request version, loading/error state, and async CRUD/sync actions. Ignore stale range responses using request versions.

- [ ] **Step 7: Verify and commit frontend foundation**

Run: `cd app && bun run test -- src/calendar && bun run build`

```bash
git add app/src/calendar app/src/lib/bridge.ts
git commit -m "feat: add calendar frontend foundation"
```

## Task 6: Replace the preview with month, week, day, and agenda views

**Files:**
- Create: `app/src/calendar/CalendarWorkspace.tsx`
- Create: `app/src/calendar/CalendarToolbar.tsx`
- Create: `app/src/calendar/CalendarSidebar.tsx`
- Create: `app/src/calendar/MonthView.tsx`
- Create: `app/src/calendar/TimeGrid.tsx`
- Create: `app/src/calendar/AgendaView.tsx`
- Create: `app/src/calendar/calendar.css`
- Create: `app/src/calendar/CalendarWorkspace.test.tsx`
- Create: `app/src/calendar/TimeGrid.test.tsx`
- Modify: `app/src/components/CalendarView.tsx`
- Modify: `app/src/components/CalendarView.test.tsx`
- Modify: `app/src/styles.css`

**Interfaces:**
- Consumes: Task 5 store/date/layout.
- Produces: navigable production calendar workspace and an `onCreate(slot)`/`onOpen(occurrence)` intent contract for Task 7.

- [ ] **Step 1: Replace preview assertions with failing production-workspace tests**

```tsx
it("renders persisted events and all four view choices without preview copy", async () => {
  render(<CalendarWorkspace api={calendarFixtureApi()} />);
  expect(await screen.findByText("Board meeting")).toBeVisible();
  for (const name of ["Month", "Week", "Day", "Agenda"]) expect(screen.getByRole("button", { name })).toBeVisible();
  expect(screen.queryByText(/preview|example events/i)).toBeNull();
});
```

- [ ] **Step 2: Verify RED**

Run: `cd app && bun run test -- src/components/CalendarView.test.tsx src/calendar/CalendarWorkspace.test.tsx`

- [ ] **Step 3: Implement workspace, toolbar, sidebar, month, and agenda**

Use semantic buttons for navigation and collections, ARIA grid semantics for dates, a real empty-state action, visible sync health, and a narrow-window switch to agenda/day. Persist view and visible calendars through `api.setSetting`.

- [ ] **Step 4: Add failing keyboard and overlap tests for the time grid**

```tsx
it("moves the active slot with arrows and creates with N", async () => {
  render(<TimeGrid {...weekFixture()} />);
  const grid = screen.getByRole("grid", { name: "Week of September 21, 2026" });
  grid.focus();
  fireEvent.keyDown(grid, { key: "ArrowRight" });
  fireEvent.keyDown(grid, { key: "n" });
  expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ date: "2026-09-22" }));
});
```

- [ ] **Step 5: Implement week/day time grid and accessible direct manipulation**

Render all-day and timed layers separately, current-time indicator, deterministic overlap columns, pointer-to-slot creation, keyboard creation, and buttons/dialog fallback for movement and resize. Do not animate full-grid navigation.

- [ ] **Step 6: Add responsive, focus, touch, and reduced-motion CSS**

Use existing motion tokens, 44 px coarse-pointer targets, high-contrast focus rings, logical properties, and container/media queries. Remove `.cal-grid`, `.cal-cell`, and `.cal-ev` preview styles.

- [ ] **Step 7: Verify and commit views**

Run: `cd app && bun run test -- src/calendar src/components/CalendarView.test.tsx && bun run build`

```bash
git add app/src/calendar app/src/components/CalendarView.tsx app/src/components/CalendarView.test.tsx app/src/styles.css
git commit -m "feat: build production calendar views"
```

## Task 7: Add the event editor, recurrence scopes, ICS files, and mail invitations

**Files:**
- Create: `app/src/calendar/EventDialog.tsx`
- Create: `app/src/calendar/EventDialog.test.tsx`
- Create: `app/src/calendar/RecurrenceEditor.tsx`
- Create: `app/src/calendar/RecurrenceEditor.test.tsx`
- Create: `app/src/calendar/InvitationCard.tsx`
- Create: `app/src/calendar/InvitationCard.test.tsx`
- Modify: `app/src/calendar/CalendarWorkspace.tsx`
- Modify: `app/src/lib/bridge.ts`
- Modify: `app/src/components/Stage.tsx`
- Modify: `app/src-tauri/src/calendar/commands.rs`
- Modify: `app/src-tauri/src/sync/mime.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/package.json`
- Modify: `app/src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: recurrence, ICS core, CRUD, shared `Modal`, mail outbox.
- Produces: event lifecycle UI, native ICS import/export, invitation inspection/response, and mail-to-calendar prefill.

- [ ] **Step 1: Write failing editor validation and recurrence-scope tests**

```tsx
it("does not save an invalid interval", async () => {
  render(<EventDialog initial={eventEndingBeforeStart()} onSave={onSave} />);
  await user.click(screen.getByRole("button", { name: "Save event" }));
  expect(screen.getByText("End must be after start")).toBeVisible();
  expect(onSave).not.toHaveBeenCalled();
});

it("requires a scope before changing one occurrence", async () => {
  render(<EventDialog initial={recurringOccurrence()} onSave={onSave} />);
  await user.type(screen.getByLabelText("Title"), " changed");
  await user.click(screen.getByRole("button", { name: "Save event" }));
  expect(screen.getByRole("dialog", { name: "Apply changes" })).toBeVisible();
});
```

- [ ] **Step 2: Verify editor tests RED**

Run: `cd app && bun run test -- src/calendar/EventDialog.test.tsx src/calendar/RecurrenceEditor.test.tsx`

- [ ] **Step 3: Implement the accessible editor and recurrence controls**

Use controlled fields, dayjs validation, attendee chip inputs, calendar permission checks, reminder limits, notification choice, dirty-close confirmation, and explicit recurrence scope. Focus the first invalid field; restore focus on close.

- [ ] **Step 4: Add native file dependencies using Bun and Cargo**

Run: `cd app && bun add @tauri-apps/plugin-dialog@^2 @tauri-apps/plugin-fs@^2`

Add `tauri-plugin-dialog = "2"` and `tauri-plugin-fs = "2"`, register both plugins, and restrict file operations to a user-selected path.

- [ ] **Step 5: Add failing invitation security and staleness tests**

```rust
#[test]
fn stale_request_cannot_replace_newer_event() {
    let existing = event_with_sequence(9);
    let incoming = request_with_sequence(8);
    assert_eq!(inspect_invitation(&existing, incoming).unwrap().state, InvitationState::Stale);
}

#[test]
fn reply_from_non_attendee_is_rejected() {
    assert_eq!(apply_reply(&organizer_event(), forged_reply()).unwrap_err().code(), "invalid-organizer-or-attendee");
}
```

- [ ] **Step 6: Implement import/export and invitation commands**

Add `inspect_calendar_attachment`, `import_ics`, `export_ics`, `respond_to_invitation`, and `schedule_from_thread`. Read selected files with a size cap in Rust. Invitation response transactionally updates the event and queues an outbox message containing human-readable HTML plus `text/calendar; method=...`.

- [ ] **Step 7: Render invitation cards in the message stage**

Only show RSVP controls after the Rust core successfully parses calendar MIME. Display organizer, normalized local time, source timezone, recurrence, conflicts, sequence state, and transport. “Schedule from thread” opens a draft editor and performs no write until Save.

- [ ] **Step 8: Verify and commit event workflows**

Run: `cd app && bun run test -- src/calendar src/components/Stage.links.test.tsx && bun run build`

Run: `cd app/src-tauri && cargo test calendar::ical && cargo test calendar::commands && cargo test sync::mime && cargo check`

```bash
git add app/package.json app/bun.lock app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock app/src-tauri/src app/src/calendar app/src/components/Stage.tsx app/src/lib/bridge.ts
git commit -m "feat: add calendar event and invitation workflows"
```

## Task 8: Implement the CalDAV connector and source setup

**Files:**
- Create: `app/src-tauri/src/calendar/connectors/mod.rs`
- Create: `app/src-tauri/src/calendar/connectors/caldav.rs`
- Create: `app/src-tauri/src/calendar/connectors/test_server.rs`
- Create: `app/src/calendar/SourceDialog.tsx`
- Create: `app/src/calendar/SourceDialog.test.tsx`
- Modify: `app/src-tauri/src/calendar/mod.rs`
- Modify: `app/src-tauri/src/calendar/commands.rs`
- Modify: `app/src-tauri/src/sync/tokens.rs`
- Modify: `app/src/lib/bridge.ts`
- Modify: `app/src/calendar/CalendarSidebar.tsx`

**Interfaces:**
- Produces: `CalendarConnector` trait; CalDAV discovery, collection sync, conditional mutation, scheduling capability, and source commands.

- [ ] **Step 1: Define the connector contract in a failing compile test**

```rust
#[async_trait]
pub trait CalendarConnector: Send + Sync {
    async fn discover(&self) -> Result<Vec<RemoteCalendar>, ConnectorError>;
    async fn pull(&self, cursor: Option<&str>) -> Result<SyncBatch, ConnectorError>;
    async fn push(&self, operation: &CalendarOperation) -> Result<PushOutcome, ConnectorError>;
    async fn free_busy(&self, request: &FreeBusyRequest) -> Result<FreeBusyResult, ConnectorError>;
}
```

Create a contract test that runs against `FakeConnector` and asserts cursor stability, tombstone mapping, conditional conflicts, and categorized auth/transient errors.

- [ ] **Step 2: Verify connector contract RED**

Run: `cd app/src-tauri && cargo test calendar::connectors -- --nocapture`

- [ ] **Step 3: Write failing CalDAV discovery and XML safety tests**

```rust
#[tokio::test]
async fn discovery_never_forwards_basic_auth_across_origins() {
    let servers = redirecting_servers();
    let error = CalDavConnector::discover(servers.first_url(), credentials()).await.unwrap_err();
    assert_eq!(error.code(), "cross-origin-authorization");
    assert_eq!(servers.second_authorization_header(), None);
}

#[test]
fn rejects_xml_entities_and_oversized_multistatus() {
    assert_eq!(parse_multistatus(entity_document()).unwrap_err().code(), "unsafe-xml");
    assert_eq!(parse_multistatus(oversized_xml()).unwrap_err().code(), "xml-too-large");
}
```

- [ ] **Step 4: Implement discovery and collection enumeration**

Try RFC 6764 SRV/TXT where available, `/.well-known/caldav`, then the explicit HTTPS URL. Discover principal, calendar-home-set, supported reports, inbox/outbox, collection names/colors/timezones, write privileges, CTag, and sync token. Cap redirects at five and never forward credentials across origins.

- [ ] **Step 5: Implement incremental pull and conditional push**

Use `sync-collection` when supported; otherwise compare CTag then run bounded `calendar-query` plus multiget. Parse each resource through the ICS core. Use `If-None-Match: *` for create and `If-Match` for update/delete. Map 401/403/409/412/429/5xx into stable connector errors.

- [ ] **Step 6: Implement encrypted source lifecycle**

Store CalDAV username/password or bearer token under `calendar:<source-id>:...`. Save configuration and prepared encrypted secrets atomically. Removal clears verified secrets before hiding the source; credential cleanup failure leaves the source visible for retry.

- [ ] **Step 7: Implement and test source setup UI**

Test URL validation, no password echo, discovery progress, calendar selection, categorized errors, and focus restoration. The saved summary shows host, selected calendar count, last sync, and health but never credential material.

- [ ] **Step 8: Verify and commit CalDAV**

Run: `cd app/src-tauri && cargo test calendar::connectors::caldav -- --nocapture && cargo test calendar::connectors -- --nocapture && cargo check`

Run: `cd app && bun run test -- src/calendar/SourceDialog.test.tsx && bun run build`

```bash
git add app/src-tauri/src/calendar app/src-tauri/src/sync/tokens.rs app/src/calendar app/src/lib/bridge.ts
git commit -m "feat: add CalDAV synchronization"
```

## Task 9: Add calendar-specific Google synchronization

**Files:**
- Create: `app/src-tauri/src/calendar/connectors/google.rs`
- Modify: `app/src-tauri/src/calendar/connectors/mod.rs`
- Modify: `app/src-tauri/src/calendar/commands.rs`
- Modify: `app/src-tauri/src/sync/oauth.rs`
- Modify: `app/src-tauri/src/sync/tokens.rs`
- Modify: `app/src/calendar/SourceDialog.tsx`
- Test: `app/src-tauri/src/calendar/connectors/google.rs`
- Test: `app/src/calendar/SourceDialog.test.tsx`

**Interfaces:**
- Consumes: connector contract and calendar-specific credential namespace.
- Produces: Google calendar-list discovery, paged initial sync, `nextSyncToken` incremental sync, conditional event writes, and explicit attendee notification modes.

- [ ] **Step 1: Write failing pagination, 410 recovery, and token isolation tests**

```rust
#[tokio::test]
async fn commits_sync_token_only_after_all_pages_succeed() {
    let server = google_pages_with_second_page_failure();
    let result = connector(&server).pull(Some("old-token")).await;
    assert!(result.is_err());
    assert_eq!(store().calendar_cursor("gcal-1"), Some("old-token".into()));
}

#[test]
fn calendar_token_namespace_cannot_replace_mail_token() {
    save_calendar_tokens("gmail:user@example.test", calendar_tokens()).unwrap();
    assert_eq!(mail_refresh_token("gmail:user@example.test"), Some("mail-refresh".into()));
    assert_eq!(calendar_refresh_token("gmail:user@example.test"), Some("calendar-refresh".into()));
}
```

- [ ] **Step 2: Verify RED**

Run: `cd app/src-tauri && cargo test calendar::connectors::google -- --nocapture`

- [ ] **Step 3: Add generic OAuth purpose/namespace support**

Extend OAuth configuration with additional authorization parameters and a credential purpose. Calendar connect requests `calendar.calendarlist.readonly`, `calendar.events`, identity, and offline access without changing Gmail scopes or secrets.

- [ ] **Step 4: Implement mapping and incremental sync**

Page the calendar list and events, preserve recurring masters/exceptions and extended properties, commit `nextSyncToken` with the final batch, and perform a full reconciliation on HTTP 410 without discarding local pending operations.

- [ ] **Step 5: Implement conditional writes and notification choices**

Map ETags and event status, use explicit `sendUpdates=none|all|externalOnly`, stable client identities where supported, and preserve conference data. Never email attendees merely because a background retry ran.

- [ ] **Step 6: Verify calendar auth loss does not break Gmail**

Add a test that returns 401 from Calendar, successful Gmail token access, and a source health state of `reauthorizationRequired`.

- [ ] **Step 7: Verify and commit Google Calendar**

Run: `cd app/src-tauri && cargo test calendar::connectors::google && cargo test sync::gmail && cargo test sync::tokens && cargo check`

Run: `cd app && bun run test -- src/calendar/SourceDialog.test.tsx && bun run build`

```bash
git add app/src-tauri/src/calendar app/src-tauri/src/sync app/src/calendar/SourceDialog.tsx app/src/calendar/SourceDialog.test.tsx
git commit -m "feat: add Google Calendar synchronization"
```

## Task 10: Add calendar-specific Microsoft 365 synchronization

**Files:**
- Create: `app/src-tauri/src/calendar/connectors/microsoft.rs`
- Modify: `app/src-tauri/src/calendar/connectors/mod.rs`
- Modify: `app/src-tauri/src/calendar/commands.rs`
- Modify: `app/src-tauri/src/sync/oauth.rs`
- Modify: `app/src-tauri/src/sync/tokens.rs`
- Modify: `app/src/calendar/SourceDialog.tsx`
- Test: `app/src-tauri/src/calendar/connectors/microsoft.rs`

**Interfaces:**
- Produces: Graph calendar discovery, delta-link synchronization, recurrence mapping, conditional writes, online-meeting preservation, and isolated authorization.

- [ ] **Step 1: Write failing delta, deletion, conflict, and isolation tests**

```rust
#[tokio::test]
async fn follows_next_links_and_commits_only_the_terminal_delta_link() {
    let batch = connector(graph_delta_pages()).pull(Some("old-delta")).await.unwrap();
    assert_eq!(batch.next_cursor.as_deref(), Some("terminal-delta"));
    assert!(batch.changes.iter().any(|change| matches!(change, RemoteChange::Delete { .. })));
}

#[tokio::test]
async fn revoked_calendar_grant_leaves_mail_token_usable() {
    let error = connector(revoked_calendar_graph()).pull(None).await.unwrap_err();
    assert_eq!(error.kind, ConnectorErrorKind::AuthRequired);
    assert!(microsoft_mail_token("ms:user@example.test").is_some());
}
```

- [ ] **Step 2: Verify RED**

Run: `cd app/src-tauri && cargo test calendar::connectors::microsoft -- --nocapture`

- [ ] **Step 3: Implement calendar authorization and discovery**

Request `Calendars.ReadWrite`, `User.Read`, and `offline_access` under the calendar namespace. List calendars with permissions/colors and do not change mail authorization state.

- [ ] **Step 4: Implement delta synchronization and recurrence mapping**

Treat next/delta links as opaque, persist terminal delta links with their range scope, map removed events to tombstones, preserve recurrence exceptions and online-meeting data, and reconcile an expired delta scope without dropping pending local writes.

- [ ] **Step 5: Implement conditional writes**

Use Graph ETags/`If-Match`, provider transaction identities where supported, and explicit attendee delivery semantics. HTTP 412 becomes a retained local/remote conflict.

- [ ] **Step 6: Verify and commit Microsoft Calendar**

Run: `cd app/src-tauri && cargo test calendar::connectors::microsoft && cargo test sync::microsoft && cargo test sync::tokens && cargo check`

Run: `cd app && bun run test -- src/calendar/SourceDialog.test.tsx && bun run build`

```bash
git add app/src-tauri/src/calendar app/src-tauri/src/sync app/src/calendar/SourceDialog.tsx
git commit -m "feat: add Microsoft calendar synchronization"
```

## Task 11: Implement sync orchestration and conflict resolution

**Files:**
- Create: `app/src-tauri/src/calendar/sync.rs`
- Create: `app/src/calendar/ConflictDialog.tsx`
- Create: `app/src/calendar/ConflictDialog.test.tsx`
- Modify: `app/src-tauri/src/calendar/store.rs`
- Modify: `app/src-tauri/src/calendar/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src/calendar/store.ts`
- Modify: `app/src/calendar/CalendarToolbar.tsx`

**Interfaces:**
- Produces: `CalendarSyncCoordinator`, queue flush, source health, conflict snapshots, `calendar:changed`/`calendar:health` events, and conflict resolution commands.

- [ ] **Step 1: Write failing per-source serialization and retry tests**

```rust
#[tokio::test]
async fn concurrent_sync_requests_share_one_source_run() {
    let connector = counting_connector();
    let (a, b) = tokio::join!(coordinator.sync("s1"), coordinator.sync("s1"));
    assert!(a.is_ok() && b.is_ok());
    assert_eq!(connector.pull_count(), 1);
}

#[tokio::test]
async fn stale_etag_preserves_local_and_remote_snapshots() {
    coordinator.flush(conflicting_update()).await.unwrap();
    let conflict = store.event_conflict("e1").unwrap();
    assert_eq!(conflict.local.title, "Local");
    assert_eq!(conflict.remote.title, "Remote");
}
```

- [ ] **Step 2: Verify RED**

Run: `cd app/src-tauri && cargo test calendar::sync -- --nocapture`

- [ ] **Step 3: Implement coordinator and retry policy**

Serialize by source ID, flush due operations before pull, use bounded exponential backoff with jitter, honor retry headers, stop permanent failures, commit batches/cursors atomically, emit only coarse Tauri events, and never hold a SQLite lock during network I/O.

- [ ] **Step 4: Write failing conflict UI tests**

```tsx
it("shows both versions and requires an explicit resolution", async () => {
  render(<ConflictDialog conflict={fixtureConflict()} onResolve={onResolve} />);
  expect(screen.getByText("Local title")).toBeVisible();
  expect(screen.getByText("Remote title")).toBeVisible();
  expect(onResolve).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Keep local" }));
  expect(onResolve).toHaveBeenCalledWith("keepLocal");
});
```

- [ ] **Step 5: Implement conflict resolution and health UI**

Keep local rebases a conditional write on the new provider version; use remote discards the local draft; duplicate creates a new UID. Recurring conflicts include the master and exceptions. Toolbar/source UI shows pending count, last successful sync, auth state, retryable failure, and conflict count.

- [ ] **Step 6: Verify and commit orchestration**

Run: `cd app/src-tauri && cargo test calendar::sync && cargo test calendar::store && cargo check`

Run: `cd app && bun run test -- src/calendar && bun run build`

```bash
git add app/src-tauri/src/calendar app/src-tauri/src/lib.rs app/src/calendar
git commit -m "feat: coordinate calendar sync and conflicts"
```

## Task 12: Add reminders, free/busy, and background operation

**Files:**
- Create: `app/src-tauri/src/calendar/reminders.rs`
- Modify: `app/src-tauri/src/calendar/sync.rs`
- Modify: `app/src-tauri/src/calendar/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src-tauri/Cargo.toml`
- Modify: `app/package.json`
- Modify: `app/src/calendar/EventDialog.tsx`
- Modify: `app/src/calendar/CalendarWorkspace.tsx`
- Test: `app/src-tauri/src/calendar/reminders.rs`
- Test: `app/src/calendar/EventDialog.test.tsx`

**Interfaces:**
- Produces: native due-reminder delivery, startup reconciliation, provider-aware free/busy, and bounded background sync.

- [ ] **Step 1: Write failing reminder tests**

```rust
#[test]
fn private_event_notification_hides_details() {
    let notice = reminder_notification(&private_event(), due_reminder());
    assert_eq!(notice.title, "Private event");
    assert!(!notice.body.contains("Board acquisition"));
}

#[test]
fn startup_reconciliation_does_not_replay_old_reminders() {
    let due = reconcile_reminders(now(), reminders_from_hours_ago());
    assert!(due.iter().all(|item| item.due_at >= now() - Duration::minutes(15)));
}
```

- [ ] **Step 2: Verify RED**

Run: `cd app/src-tauri && cargo test calendar::reminders -- --nocapture`

- [ ] **Step 3: Add the notification plugin with Bun and Cargo**

Run: `cd app && bun add @tauri-apps/plugin-notification@^2`

Add `tauri-plugin-notification = "2"`, register it, request permission from an explicit user action, and keep notification bodies redacted for private events.

- [ ] **Step 4: Implement reminder and sync schedulers**

Query due reminders without loading event bodies unnecessarily, mark delivery atomically, wake on event changes, reconcile only the last 15 minutes at startup, sync at startup/manual/mutation and a jittered active-process interval, and keep mail/calendar schedulers independent.

- [ ] **Step 5: Implement truthful free/busy suggestions**

Merge selected local busy intervals with connector free/busy results. Return `complete: false` when any selected source is unavailable and show “Availability incomplete” instead of “Free.” Never select or save a time automatically.

- [ ] **Step 6: Verify and commit reminders/free-busy**

Run: `cd app/src-tauri && cargo test calendar::reminders && cargo test calendar::sync && cargo check`

Run: `cd app && bun run test -- src/calendar && bun run build`

```bash
git add app/package.json app/bun.lock app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock app/src-tauri/src app/src/calendar
git commit -m "feat: add calendar reminders and availability"
```

## Task 13: Complete source management, deletion, and diagnostics

**Files:**
- Modify: `app/src/calendar/CalendarSidebar.tsx`
- Modify: `app/src/calendar/SourceDialog.tsx`
- Modify: `app/src/components/settings/AccountSettings.tsx`
- Modify: `app/src/components/settings/DiagnosticsSettings.tsx`
- Modify: `app/src/lib/diagnostics.ts`
- Modify: `app/src-tauri/src/calendar/commands.rs`
- Modify: `app/src-tauri/src/calendar/store.rs`
- Modify: `app/src-tauri/src/sync/tokens.rs`
- Test: `app/src/calendar/SourceDialog.test.tsx`
- Test: `app/src/lib/diagnostics.test.ts`
- Test: `app/src-tauri/src/calendar/commands.rs`

**Interfaces:**
- Produces: discoverable source add/edit/remove, calendar visibility/order, explicit local-data removal policy, and redacted calendar diagnostics.

- [ ] **Step 1: Write failing removal-lifecycle tests**

```rust
#[test]
fn credential_cleanup_failure_keeps_source_visible() {
    let result = remove_calendar_source_with(&store, "s1", |_| Err("keychain denied".into()));
    assert!(result.is_err());
    assert!(store.calendar_source("s1").is_some());
}

#[test]
fn removing_remote_source_can_preserve_events_as_local_copy() {
    remove_calendar_source_with_policy(&store, "s1", RemovalPolicy::KeepLocalCopy).unwrap();
    assert!(store.calendar_source("s1").is_none());
    assert_eq!(store.event("e1").unwrap().sync_state, EventSyncState::Local);
}
```

- [ ] **Step 2: Verify RED**

Run: `cd app/src-tauri && cargo test calendar::commands::tests::credential_cleanup_failure_keeps_source_visible -- --nocapture`

- [ ] **Step 3: Implement source removal and collection controls**

Offer Disconnect and keep local copy, or Disconnect and delete local calendar data. Explain that provider events are not deleted. Verify encrypted and legacy secret absence before hiding the source. Calendar order and visibility persist independently.

- [ ] **Step 4: Write failing diagnostics redaction tests**

```ts
it("redacts event, attendee, URL, credential, and cursor data", () => {
  const report = buildDiagnostics(calendarDiagnosticFixture());
  for (const secret of ["Board acquisition", "guest@example.test", "sync-token", "https://dav.example.test/user/42"]) {
    expect(report).not.toContain(secret);
  }
});
```

- [ ] **Step 5: Implement redacted health diagnostics**

Include provider kind, capability names, selected calendar count, coarse status, pending/conflict counts, last success bucket, error category, app version, and schema version. Exclude event fields, identities, raw URLs, cursors, payloads, and tokens.

- [ ] **Step 6: Verify and commit management**

Run: `cd app && bun run test -- src/calendar/SourceDialog.test.tsx src/lib/diagnostics.test.ts && bun run build`

Run: `cd app/src-tauri && cargo test calendar::commands && cargo test sync::tokens && cargo check`

```bash
git add app/src/calendar app/src/components/settings app/src/lib/diagnostics.ts app/src/lib/diagnostics.test.ts app/src-tauri/src/calendar app/src-tauri/src/sync/tokens.rs
git commit -m "feat: complete calendar source lifecycle"
```

## Task 14: Remove preview artifacts and run end-to-end release hardening

**Files:**
- Modify: `app/src-tauri/src/store/seed.rs` — remove only the calendar event function and preserve mail demo seed behavior.
- Modify: `app/src/data/mock.ts`
- Modify: `app/src/components/CalendarView.test.tsx`
- Modify: `app/src-tauri/src/store/mod.rs`
- Modify: `app/package.json`
- Modify: `app/src-tauri/Cargo.toml`
- Modify: `app/src-tauri/tauri.conf.json`
- Modify: `app/src/lib/bridge.test.ts`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Create: `app/src/calendar/Calendar.e2e.test.tsx`
- Create: `app/src-tauri/tests/calendar_caldav.rs`

**Interfaces:**
- Consumes: all calendar functionality.
- Produces: truthful 0.2.0 product/release state and complete verification evidence.

- [ ] **Step 1: Add failing no-preview/no-fallback tests**

```ts
it("never substitutes mock events after a desktop calendar IPC failure", async () => {
  invoke.mockRejectedValueOnce(new Error("database unavailable"));
  await expect(api.calendar.listEvents(range)).rejects.toThrow("database unavailable");
  expect(screen.queryByText("Marco · pipeline")).toBeNull();
});
```

- [ ] **Step 2: Verify RED**

Run: `cd app && bun run test -- src/lib/bridge.test.ts src/components/CalendarView.test.tsx`

- [ ] **Step 3: Remove legacy calendar mocks and preview copy**

Delete `CalEvent`, mock event arrays, `Store::events`, `list_events`, preview assistant actions, and legacy calendar CSS. Browser preview uses the same in-memory local repository contract and labels unavailable remote connectors honestly.

- [ ] **Step 4: Add deterministic CalDAV and calendar workflow integration tests**

Cover schema-13 backup/migration, offline create/update/delete then reconnect, two-way CalDAV create/update/delete, expired sync token reconciliation, ETag conflict, ICS import/export fixtures, invitation request/update/cancel/reply, provider auth isolation, and source removal.

- [ ] **Step 5: Bump the release line to 0.2.0 consistently**

Update `app/package.json`, `app/src-tauri/Cargo.toml`, `app/src-tauri/Cargo.lock`, `app/src-tauri/tauri.conf.json`, and version bridge assertions. Do not publish to npm; this remains a private desktop package distributed through GitHub Releases.

- [ ] **Step 6: Update truthful documentation**

Document local calendar storage, encrypted credentials, provider permissions, offline queue, CalDAV/Google/Microsoft support, invitation behavior, limitations, backup location, diagnostics redaction, and test-tenant requirements. Do not claim Apple notarization or Windows trusted signing unless configured and verified.

- [ ] **Step 7: Run the complete release gate**

Run: `cd app && bun run test && bun run build && bun run check:open-source && bun run check:version`

Run: `cd app/src-tauri && cargo test && cargo check`

Expected: every frontend and Rust test passes, TypeScript/Vite build succeeds, open-source hygiene finds no organization data, and version 0.2.0 is consistent.

- [ ] **Step 8: Run packaged desktop validation**

Run: `cd app && bun run tauri:build`

Validate on the packaged application: schema-13 backup before migration, month/week/day/agenda navigation, keyboard grid, reduced motion, event CRUD, recurrence scopes, native file dialogs, invitation response, background reminder, offline pending state, CalDAV reconnect, calendar auth loss with working mail, conflict resolution, light/dark themes, and narrow window behavior.

- [ ] **Step 9: Commit release hardening**

```bash
git add app README.md SECURITY.md
git commit -m "feat: complete calendar platform"
```

## Final Verification and Handoff

- [ ] Confirm `git diff --check` returns no errors.
- [ ] Confirm `git status --short` contains only the intentionally untracked `AGENTS.md` before release staging.
- [ ] Confirm every task commit exists in order on `feature/calendar-platform`.
- [ ] Confirm no secrets, provider payloads, personal accounts, or organization defaults appear in tracked files or test fixtures.
- [ ] Confirm the packaged app reports 0.2.0 and the calendar contains no preview/example copy.
- [ ] Request a whole-branch code review focused on migration safety, recurrence/time zones, connector conflict behavior, token isolation, hostile payload bounds, accessibility, and packaged-device behavior.
- [ ] Fix every blocking review finding with a failing regression test before changing production code.
- [ ] Rerun the complete frontend, Rust, open-source, version, and packaged-device gates after review fixes.
