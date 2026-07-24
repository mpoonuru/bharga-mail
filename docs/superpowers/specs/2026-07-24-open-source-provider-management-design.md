# Open-source defaults and AI provider management

## Objective

Ship Bharga Mail with organization-neutral defaults and a complete, secure AI
provider lifecycle. Production installs start without seeded mail data. Browser
preview and explicit demo mode retain realistic fictional content using reserved
example domains.

## Safety boundary

- Never rewrite an existing user's SQLite database, connected mail accounts, or
  OS keychain entries as part of identity neutralization.
- Only shipped source fixtures, explicit demo seeds, static previews, generated
  preview artifacts, and documentation may be neutralized.
- AI credentials never appear in serialized profiles, logs, errors, tests, or
  frontend responses.
- Provider removal must delete its credential from both the OS keychain and the
  encrypted SQLite fallback before reporting success.
- A failed persistence or credential operation must be returned to the UI. The
  UI must not display a success state after a failed desktop command.

## Open-source identity design

The Tauri production store already seeds mail only when `BHARGA_DEMO` is set.
That behavior remains. Rust demo seed and browser mock identities use fictional
people and reserved `example.com`, `example.org`, or `example.net` domains.
Static previews are rebuilt from the neutral source.

A repository hygiene test scans tracked release inputs for blocked organization
identifiers. It excludes `.git`, dependency trees, compiler output, lockfiles,
binary assets, and the test's own blocked-term declaration. This prevents a
future release from accidentally restoring private organization defaults.

## Provider data model

`AiProfile` stores non-secret provider metadata:

- stable provider ID
- user-visible label
- provider kind
- model identifier
- endpoint
- role assignments
- capabilities
- core-derived credential state
- optional last connection-check result

An API key is a write-only command input. It is never a property returned by
`get_ai_profile` and never serialized into the `ai_profile` setting.

Credentials are stored under a namespaced identifier derived from the stable
provider ID. The existing credential service is extended with fallible AI-key
operations so callers can distinguish successful storage/deletion from failure.
The encrypted SQLite fallback remains ciphertext-only.

## Command lifecycle

Provider mutations are owned by Rust:

- `save_ai_provider(input)` validates and normalizes metadata, stores a supplied
  key, persists the sanitized profile, then returns the sanitized provider.
- `remove_ai_provider(provider_id)` removes the provider and its assignments,
  deletes its credentials, persists the profile, and returns the updated
  sanitized profile.
- `test_ai_provider(input)` constructs an ephemeral provider from sanitized
  metadata plus a supplied or stored key and reports a connection result without
  persisting plaintext.
- `set_ai_profile` is narrowed to non-secret profile preferences and role
  assignments or replaced by explicit commands where practical.

Mutation ordering avoids false success and orphaned secrets. Adding or updating
a provider stores credentials first, persists metadata second, and removes a
newly written credential if metadata persistence fails. Removing a provider
deletes the credential first and persists the new profile second; if profile
persistence fails, the provider remains visible but becomes unconfigured rather
than retaining an undeletable secret.

## Routing and readiness

The core derives readiness from provider requirements:

- cloud provider: stored credential exists and required metadata is valid
- local provider: valid endpoint exists
- optional authentication on OpenAI-compatible endpoints is supported

The router honors explicit role assignments. It does not silently fall back to
an unrelated cloud provider when an assigned provider is missing, unready, or
removed. Local-only privacy remains a hard boundary. Unassigned roles return a
clear configuration error.

## User interface

Settings presents providers as compact management cards consistent with the
existing Calm Command design:

- provider label and type
- connection state
- model and endpoint fields
- password field that is always blank after save
- role assignments
- Test connection, Save changes, and Remove provider actions

The add-provider flow begins from a provider-type catalog. OpenAI-compatible
providers expose both endpoint and optional API-key fields. Destructive removal
uses an accessible confirmation modal listing roles that will become
unassigned. Built-in configured instances are removable; their provider types
remain available in the catalog.

Errors appear inline with actionable text. Keyboard focus, reduced motion,
responsive layout, and visible focus states are preserved.

## Tests

- Rust serialization test proves API keys cannot appear in profile JSON.
- Credential tests prove AI keys can be stored, read internally, and deleted.
- Command/store tests cover add, update, persistence failure, and removal.
- Router tests prove no cross-provider cloud fallback.
- Frontend store tests cover add/update/remove state and surfaced save failures.
- Component tests cover endpoint plus key fields and removal confirmation where
  the current test stack permits.
- Hygiene test proves blocked organization identifiers fail the release check.
- Full TypeScript build, frontend tests, Rust tests, and release-input scan run
  before completion.

## Migration and compatibility

Existing saved profiles deserialize with defaults for newly introduced metadata.
Legacy `ready` values are ignored and recomputed. Since earlier AI keys were not
successfully persisted by the current implementation, users may be asked to
enter a cloud key once after upgrade. Existing mail accounts and mail
credentials are unaffected.

