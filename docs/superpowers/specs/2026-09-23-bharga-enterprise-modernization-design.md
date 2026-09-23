# Bharga Mail Enterprise Modernization Design

## Purpose

This specification defines the approved modernization of Bharga Mail from a
feature-rich prototype into a calm, trustworthy, enterprise-ready desktop mail
client. It converts the September 23 product and architecture audit into
testable requirements without changing Bharga's local-first, model-agnostic
identity.

## Intended outcome

Bharga should feel quiet and immediate during normal mail work. Motion explains
state changes instead of decorating every surface. Mail, account, and privacy
behavior must match what the interface and documentation promise. The desktop
client must remain usable without an AI provider and must never expose private
organization defaults in the open-source distribution.

Success means:

- a user with multiple accounts can open Bharga with at most one Keychain
  authorization request per process launch;
- replies and new messages always use an explicitly resolved real account;
- unfinished integrations are visibly labeled and cannot be mistaken for live
  data;
- routine navigation does not replay staggered row or message animation;
- the primary mail surfaces are fully keyboard operable and dialogs manage
  focus correctly;
- public privacy claims match the actual storage implementation;
- all frontend and Rust tests, the TypeScript build, the Rust build, and the
  open-source hygiene check pass before release.

## Scope and delivery boundaries

The program is deliberately split into four independently verifiable
workstreams. Each workstream receives its own implementation plan and can ship
as a coherent change without requiring unfinished work from a later phase.

1. **Trust and correctness** — account identity, credentials, calendar truth,
   runtime versioning, storage claims, and release identity.
2. **Calm motion and interaction** — one motion policy, simplified account
   disclosure, reduced chrome, and responsive behavior.
3. **Information architecture and accessibility** — reading hierarchy,
   settings navigation, semantic interaction, focus management, and touch
   targets.
4. **Quality and release hardening** — regression coverage, performance
   profiling, diagnostics, encryption-at-rest decision, and signed release
   requirements.

Database encryption and platform code-signing are release-gate projects with
external operational prerequisites. The repository work must make their status
truthful and explicit even when the external certificates are not available.

## Product principles

### Calm Command

Bharga is command-first and content-first. The message is the primary object;
AI, navigation, and controls support it. Persistent controls are limited to the
highest-frequency actions. Secondary actions live in menus or the command bar.

### Honest capability

The interface must never imply that mock, preview, or locally generated data is
connected to a provider. Marketing and privacy copy must describe shipped
behavior rather than planned architecture.

### Local-first without security theatre

Secrets remain outside plaintext storage. Message storage is described as local
unless full-database encryption is actually active. A stable, signed release
identity is the long-term macOS credential and distribution boundary.

### Progressive disclosure

Rows show only the information needed to make the next decision. Details and
rare actions appear on request. This applies to accounts, folders, messages,
AI providers, and settings.

## Workstream 1: Trust and correctness

### Real account identity

- Remove production dependencies on `data/mock` from the composer and send
  routing.
- Resolve the current user address from the thread's account for replies.
- New mail must require an explicit account when more than one account exists.
- Sending must fail closed with a user-readable error if no connected account
  can be resolved. A mock or fabricated fallback is forbidden.
- Reply-all must exclude every address owned by the sending account while
  preserving other recipients and deduplicating case-insensitively.

### Credential access

- The OS Keychain stores one Bharga database master key.
- Account and provider secrets are encrypted with authenticated encryption in
  the local secrets store.
- The master key is loaded once per process and held in memory for the process
  lifetime; secret reads do not query separate per-account Keychain entries.
- Existing per-account Keychain entries remain readable during a one-way,
  idempotent migration. A credential is deleted only after the encrypted copy
  can be read back successfully.
- Credential values are never logged, returned over IPC, or included in error
  messages.
- Removing an account or AI provider deletes its encrypted secret records and
  any legacy Keychain entries. Failure is reported and does not claim success.

### Capability truth

- Calendar is labeled **Preview** until real provider synchronization exists.
- Preview events are visually identified as examples and never mixed with real
  events.
- Runtime version text comes from Tauri package metadata rather than a literal.
- Public documentation must say that credentials are encrypted and message
  content is stored locally. It may claim full local encryption only after
  SQLCipher is enabled and migration is verified.
- Open-source checks continue to reject organization-specific email addresses,
  credentials, endpoints, and seeded accounts.

### Release identity

- Developer builds are visibly identified as development builds in diagnostics.
- Release documentation distinguishes ad-hoc builds from notarized production
  builds.
- Enterprise release readiness requires macOS Developer ID signing and
  notarization plus Windows code signing. Missing signing credentials do not
  block local development but do block an enterprise-release claim.

## Workstream 2: Calm motion and interaction

### Motion tokens

The application exposes one shared motion policy used by CSS and Motion for
React:

| Token | Duration | Use |
| --- | ---: | --- |
| instant | 90 ms | color, hover, pressed feedback |
| standard | 140 ms | menus, tooltips, small state changes |
| disclosure | 160 ms | account and settings disclosure |
| structural | 200 ms maximum | sidebar, focus mode, responsive panes |

The standard easing is `cubic-bezier(0.2, 0.8, 0.2, 1)`. Springs are reserved
for direct manipulation where velocity matters, such as a touch swipe settling
into place. Routine buttons, menus, cards, and page changes do not scale, lift,
or bounce.

### Reduced motion

- A root Motion configuration honors the operating system preference.
- Reduced motion removes translation, scale, layout interpolation, and stagger;
  it may retain an instant opacity change.
- CSS and JavaScript motion use the same preference and acceptance tests.

### Stream and stage

- Switching account, folder, filter, or search does not replay row entrances.
- Newly arriving mail may use one 140 ms emphasis transition without moving
  existing rows.
- Thread changes use a single 120 ms crossfade. The old thread is not required
  to finish an exit animation before the new thread appears.
- Messages and AI summaries do not animate independently during thread opening.
- Desktop mail rows do not enable horizontal drag. Swipe actions are available
  only for touch or coarse-pointer input.

### Account disclosure

- The stable account row contains status, name, unread count, caret, and one
  overflow action.
- Refresh moves into overflow. Reorder controls appear only in an explicit edit
  order mode.
- Expanding an account performs one disclosure transition and one caret
  rotation. Folder controls do not animate individually.
- `aria-expanded`, `aria-hidden`, and `inert` remain synchronized with the
  visual state.

## Workstream 3: Information architecture and accessibility

### Stream hierarchy

- Every row prioritizes sender, subject, preview, and time.
- A row may show one trust signal and one state signal without interaction.
- Attachments, labels, AI provenance, and additional status move to detail or
  hover/focus disclosure.
- Selected rows use a restrained tonal or edge accent rather than combined
  gradients, borders, and card elevation.
- Global synchronization appears in one place. Stream-level controls are
  limited to view, sort, and filter.

### Reading hierarchy

- Message content precedes expanded AI analysis.
- An AI summary is collapsed to one line by default and expands on request.
- The persistent toolbar contains Reply, Archive, Snooze, and More.
- Reply all, Forward, text size, task creation, focus, and destructive actions
  remain available through More, keyboard shortcuts, or the command bar.
- Conversation history uses flat separators and collapsible quoted content
  rather than progressively indented message cards.

### Settings

Settings uses section navigation with these stable destinations:

1. Accounts
2. Appearance
3. AI and privacy
4. Signatures
5. Security and data
6. Diagnostics
7. About

Provider cards display a compact summary at rest and expand for editing. Each
provider has one unambiguous save model: explicit per-provider save or immediate
validated persistence, not both local and global save actions. Account health,
last successful sync, authentication state, and a redacted diagnostics export
belong in Accounts and Diagnostics.

### Accessibility

- Mail and child-message rows use native interactive semantics or a documented
  composite widget pattern with complete keyboard behavior.
- Every interactive element has a visible `:focus-visible` treatment.
- Dialogs use `role="dialog"`, `aria-modal="true"`, an accessible name, initial
  focus, focus containment, Escape handling, and focus restoration.
- Desktop targets are at least 32 px high where layout permits. Touch layouts
  use at least 44 px targets. No required action has a target below 24 by 24 px.
- Text and controls meet WCAG 2.1 AA contrast in both themes.
- Empty, offline, authentication-required, partial-sync, and failure states say
  what happened and provide a next action.

## Workstream 4: Quality and release hardening

### Automated coverage

- Unit tests cover sender resolution, reply-all exclusion, credential migration,
  provider deletion, motion policy, and capability labels.
- Component tests cover account disclosure semantics, dialog focus behavior,
  keyboard row activation, and reduced motion.
- Browser tests capture stable screenshots for inbox, reading, settings, empty,
  offline, and error states in light and dark themes.
- Automated accessibility checks run against the primary routes.
- The open-source hygiene check remains part of the release verification.

### Performance

- Unread counts are derived once through memoized selectors rather than by
  filtering the full thread set for every folder render.
- Inbox list virtualization is introduced only after profiling proves that
  normal enterprise mailbox sizes miss the interaction budget.
- Target interaction latency is under 100 ms for local navigation and under
  16 ms per animation frame on supported hardware.
- Dead visual effects and unused components are removed after reference checks.

### Storage and diagnostics

- SQLCipher work includes backup, migration, rollback, corrupt-key handling,
  and recovery tests. It must not be introduced as an untested configuration
  toggle.
- Diagnostics redact message content, recipients, credentials, tokens, and
  identifiers by default.
- Telemetry and crash reporting remain opt-in and use explicit PII scrubbing.

## Error handling

- Security-sensitive operations fail closed.
- Destructive operations use Bharga dialogs with clear scope and an undo path
  where restoration is possible; browser-native confirmations are removed.
- Provider, account, sync, and credential errors remain local to the affected
  entity and do not make unrelated accounts unusable.
- The UI never reports deletion, save, migration, sync, or send success until
  the authoritative operation and read-back verification complete.

## Migration and compatibility

- Existing accounts, provider configuration, signatures, preferences, and mail
  remain readable throughout the modernization.
- Credential migration is versioned and idempotent.
- Schema-changing work follows the repository's backup-first rule and includes
  rollback documentation.
- Browser preview continues to use mock data but displays a persistent Preview
  marker so it cannot be mistaken for the desktop runtime.

## Verification gates

Every implementation plan must include fresh evidence for:

1. focused red-green tests for each changed behavior;
2. the complete frontend test suite through Bun;
3. TypeScript and Vite production build through Bun;
4. the complete Rust test suite;
5. `cargo check` for the desktop core;
6. the open-source hygiene check;
7. light and dark visual review at desktop and narrow widths;
8. keyboard-only and reduced-motion walkthroughs;
9. a clean diff audit excluding user-owned files.

## Explicit non-goals

- Building real Google, Microsoft, or CalDAV calendar synchronization in the
  visual-modernization phase.
- Adding a hosted Bharga backend or managed AI service.
- Changing licensing or introducing organization-specific defaults.
- Adding animation to make unchanged behavior appear more modern.
- Claiming enterprise release readiness without verified signing,
  notarization, encrypted message storage, and recovery procedures.

## Delivery sequence

1. Trust and correctness.
2. Calm motion and interaction.
3. Information architecture and accessibility.
4. Quality and release hardening.

Each phase must leave the application buildable and testable. Later phases may
refine earlier presentation, but they may not weaken the security, truthfulness,
or compatibility guarantees established here.
