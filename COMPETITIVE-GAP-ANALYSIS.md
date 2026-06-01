# Bharga Mail — Competitive Gap Analysis

_Last updated: 2026-05-31. Grounded in the actual codebase (35 Tauri commands, all components, AI prompts) vs. current feature sets of the leading clients._

## TL;DR — the gaps that matter most

Bharga already has a strong **foundation** that most clients took years to build: BYO-AI engine, RAG "ask my inbox," semantic + full-text search, AI triage, multi-account (Gmail/Graph/IMAP), sanitized iframe rendering, undo-send, signatures, attachments, conversation grouping, keyboard nav, command bar, local-first SQLite.

What separates us from the **AI-email leaders** (Superhuman, Shortwave, Notion Mail) and the **table-stakes** set (Gmail/Outlook/Apple/Proton) falls into three buckets:

1. **Automation & inbox organization** — we have fixed smart views but no _user-defined_ AI splits, no rules engine, no auto-archive, no bundling. This is the defining 2025 battleground and our biggest gap.
2. **Table-stakes sending/calendar** — no BCC, no scheduled send, no follow-up reminders, no snippets, calendar is demo-only (not wired to a real provider), no RSVP to invites.
3. **Always-on AI & background plumbing** — summaries are on-demand not always-on, drafts don't learn the user's voice, and there's no push/IMAP-IDLE, no notifications, no contacts/autocomplete.

---

## Feature matrix

Legend: ✅ have · 🟡 partial · ❌ missing

| Capability | Bharga | Superhuman | Shortwave | Gmail | Outlook | Apple Mail | Proton | Notion Mail |
|---|---|---|---|---|---|---|---|---|
| **AI-native** |
| BYO model (OpenAI/Anthropic/local) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Ask-my-inbox (RAG/chat) | ✅ | 🟡 | ✅ | ❌ | 🟡 | ❌ | ❌ | 🟡 |
| AI triage / priority | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | ❌ | ✅ |
| AI draft reply | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | ❌ | ✅ |
| Always-on 1-line thread summary | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | 🟡 |
| Voice-matched drafting ("Ghostwriter") | ❌ | ✅ | ✅ | ❌ | 🟡 | ❌ | ❌ | ✅ |
| Suggested 1-click quick replies | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Auto-drafts waiting for you | ❌ | ✅ | 🟡 | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Organization & automation** |
| User-defined AI splits / auto-labels | ❌ | ✅ | ✅ | 🟡 | ✅ | 🟡 | ❌ | ✅ |
| Rules / filters engine | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Auto-archive (marketing/cold) | ❌ | ✅ | ✅ | 🟡 | 🟡 | ❌ | ❌ | ✅ |
| Bundling (group newsletters into a row) | ❌ | 🟡 | ✅ | ✅ | ❌ | ❌ | ❌ | 🟡 |
| Sender screening (approve new senders) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ (Hey has it) |
| Snooze | 🟡 local | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| Move to folder (right-click) | ❌ (planned) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Spam / junk handling | 🟡 view only | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Sending / composition** |
| Rich text + signatures + attachments | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| CC | 🟡 1 field | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| BCC | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Undo send | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| Scheduled send / send later | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Follow-up reminders ("if no reply") | ❌ | ✅ | ✅ | 🟡 | 🟡 | ❌ | ❌ | ❌ |
| Snippets / templates | ❌ | ✅ | ✅ | ✅ | ✅ | 🟡 | ❌ | ✅ |
| Send-as / aliases | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Search** |
| Full-text + semantic | ✅ | ✅ | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | ✅ |
| Operators (from:/has:/before:) | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Calendar / tasks** |
| Tasks from email | ✅ | 🟡 | ✅ | 🟡 | ✅ | 🟡 | ❌ | ✅ |
| Real calendar (read/write) | ❌ demo | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| RSVP to .ics invites | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Scheduling links / availability | ❌ | ✅ | 🟡 | 🟡 | ✅ | ❌ | ❌ | ✅ |
| **Security / privacy** |
| Local-first storage | ✅ | ❌ | ❌ | ❌ | ❌ | 🟡 | ✅ | ❌ |
| Sanitized render + remote-image block | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| E2E / PGP / S-MIME | ❌ | ❌ | ❌ | 🟡 | ✅ | 🟡 | ✅ | ❌ |
| Encrypted local DB (SQLCipher) | ❌ | n/a | n/a | n/a | n/a | n/a | ✅ | n/a |
| Email aliases / hide-my-email | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| Phishing / link-safety warnings | 🟡 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 |
| **Accounts / protocols** |
| Gmail / Microsoft 365 / IMAP | ✅ | ✅ | 🟡 Gmail | ✅ | ✅ | ✅ | 🟡 | 🟡 Gmail |
| POP3 | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Exchange / EWS / on-prem | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ |
| Contacts / recipient autocomplete | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Unified inbox | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ | 🟡 |
| **Platform / plumbing** |
| Background sync / push (IDLE) | ❌ manual | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Native new-mail notifications | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Offline read | ✅ | 🟡 | 🟡 | 🟡 | ✅ | ✅ | ✅ | 🟡 |
| Keyboard-first / command bar | ✅ | ✅ | ✅ | 🟡 | 🟡 | ❌ | ❌ | ✅ |
| True mobile apps (iOS/Android) | 🟡 iPad | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Team collab (shared inbox/comments) | ❌ | 🟡 | 🟡 | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## Gaps by category (what we have → what's missing → effort)

### 1. Automation & inbox organization — _highest leverage, our biggest miss_
- **Have:** fixed smart views (Priority / Awaiting / Newsletters / Receipts), AI triage sort, labels, archive, snooze (local), conversation grouping.
- **Missing:**
  - **Split Inbox / Auto-Labels from natural-language prompts** — the signature feature of Superhuman, Shortwave, and Notion Mail. "Split out invoices," "label anything from my team," and the inbox reorganizes itself. We classify into _fixed_ buckets; users can't define their own AI splits. **(L)**
  - **Rules / filters engine** — no "if from X → move/label/archive." Backbone of Gmail/Outlook. **(M)**
  - **Auto-archive** of marketing/cold mail; **bundling** of newsletters into one row. **(M)**
  - **Server-side snooze** (ours is local-only, won't survive reinstall or sync to other devices). **(S)**
  - **Move-to-folder** (already planned via IMAP MOVE). **(S)**

### 2. Always-on AI
- **Have:** on-demand draft / summarize / triage / ask-inbox; entity highlights.
- **Missing:**
  - **Always-on 1-line thread summary** above every conversation, updating as mail arrives. **(M)**
  - **Voice-matched drafting** — learn from the user's Sent folder so drafts sound like them. **(M)**
  - **Suggested quick-reply chips** (one-click contextual replies). **(S–M)**
  - **Agentic inbox actions** — "archive all newsletters," "unsubscribe from X" executed by the assistant. **(M)**

### 3. Sending & composition — _table stakes_
- **Have:** rich text, multiple signatures, attachments, undo-send, reply/replyAll/forward, one combined CC field.
- **Missing:** **BCC** (entirely); **proper separate CC/BCC** with chips; **scheduled send**; **follow-up reminders**; **snippets/templates**; **send-as/aliases**. **(S–M each)**

### 4. Calendar & scheduling
- **Have:** Tasks-from-email; a Calendar _view_ that currently shows **demo events only** (`Calendar provider sync is Phase 1`).
- **Missing:** real Google/Graph/CalDAV calendar (read/write); **RSVP to .ics invites** inside the email; **AI scheduling** (detect a meeting ask → check calendar → propose times); scheduling links. **(L)**

### 5. Plumbing users feel immediately
- **Missing:** **background/push sync (IMAP IDLE / Gmail watch / Graph subscriptions)** — today sync is manual; **native new-mail notifications**; **contacts / recipient autocomplete** (no address book at all); **search operators** (`from:`, `has:attachment`, `before:`). **(M)**

### 6. Security / privacy — _positioning choice_
- **Have:** local-first store, keychain creds, sanitized iframe + remote-image blocking, BYO-AI (data stays with the user's chosen model).
- **Missing (optional, depends on positioning):** **PGP / S-MIME** encryption, **SQLCipher** for the local DB (secrets currently have a plaintext DB fallback), **email aliases / hide-my-email**, stronger **phishing/link-safety** banners, **spam classification + move-to-junk**. **(M–L)**

---

## Recommended priority order

**Now (table stakes — credibility):**
1. BCC + proper CC/BCC fields
2. Scheduled send + follow-up reminders
3. Move-to-folder (IMAP MOVE) + spam/junk move
4. Background sync (IMAP IDLE / provider push) + native notifications
5. Contacts + recipient autocomplete

**Next (where we win — lean into AI-native):**
6. Split Inbox / Auto-Labels from natural-language prompts
7. Always-on 1-line summaries + suggested quick replies
8. Voice-matched drafting (learn from Sent)
9. Rules engine + auto-archive + bundling
10. Search operators; snippets/templates

**Later (depth / positioning):**
11. Real calendar + RSVP + AI scheduling
12. SQLCipher / PGP / aliases (privacy story)
13. True mobile apps; team collaboration (only if we target teams)

---

## Where Bharga already leads

Worth protecting, because no mainstream competitor has all of these together: **bring-your-own-model** (privacy + cost control), **local-first SQLite** (offline, ownership), **semantic + full-text search**, **RAG ask-my-inbox**, and a **keyboard-first command-bar UX** — paired with cross-platform Tauri. The strategy isn't to copy Superhuman feature-for-feature; it's to reach table-stakes parity on sending/calendar/plumbing, then push the AI-native automation (splits, voice drafting, agentic actions) _on the user's own model_, which the cloud-only incumbents structurally can't match.

## Sources
- Superhuman — [AI features](https://superhuman.com/products/mail/ai), [updates](https://new.superhuman.com/)
- Shortwave — [site](https://www.shortwave.com/), [AI Assistant docs](https://www.shortwave.com/docs/guides/ai-assistant/)
- Notion Mail — [auto-labeling guide](https://www.notion.com/help/guides/organize-your-inbox-with-notion-ai-auto-labeling), [TechCrunch launch](https://techcrunch.com/2025/04/15/notion-releases-its-ai-driven-email-inbox/)
