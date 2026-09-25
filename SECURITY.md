# Security policy

This document defines the supported disclosure path and the security boundaries contributors must preserve.

## Reporting a vulnerability

Please use GitHub's private security-advisory workflow for this repository. Do not include real mailbox content, credentials, OAuth tokens, calendar payloads, private URLs, or database copies in a public issue. Provide the smallest synthetic reproduction possible.

## Calendar security boundaries

- Mail and calendar OAuth grants use separate scopes and credential namespaces.
- Secrets are encrypted before database persistence; the encryption master key remains in the operating-system keychain.
- CalDAV redirects never forward credentials across origins, and connector responses have size, page, and XML-complexity limits.
- Sync cursors and remote batches commit atomically. Conditional writes preserve local and remote snapshots when a conflict occurs.
- Source removal verifies credential cleanup before hiding the connection. Disconnecting never requests deletion of provider-side data.
- Private and confidential event notifications omit title, location, description, attendees, and conference details.
- Diagnostics export only allowlisted aggregate health fields and excludes identities, event content, URLs, credentials, cursors, and provider payloads.

## Known limitations

Local mail and calendar content is stored in SQLite and is not yet protected by SQLCipher. Public development builds may be ad-hoc signed and are not a claim of Apple notarization, Windows trusted signing, or enterprise endpoint certification. Review the current release notes before deploying to managed devices.
