//! Microsoft 365 provider: OAuth (PKCE) + Microsoft Graph sync into the store.
//!
//! Reuses the generic PKCE loopback flow (see `oauth.rs`). Set your Azure
//! "Mobile & desktop" app client id via `BHARGA_MS_CLIENT_ID` (public client,
//! no secret with PKCE; register `http://localhost` as a redirect URI).

use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::Value;

use super::oauth::{self, OAuthConfig, OAuthPurpose, TokenSet};
use super::{SyncError, provider_config, tokens};
use crate::store::{Message, Party, RemoteFolder, Store, Thread};

const GRAPH: &str = "https://graph.microsoft.com/v1.0";
const MESSAGE_SELECT: &str =
    "id,conversationId,subject,from,toRecipients,bodyPreview,body,isRead,receivedDateTime";
const FOLDER_SELECT: &str = "id,displayName,childFolderCount";
/// The inbox keeps the name every provider uses locally, whatever the mailbox
/// language calls it ("Posteingang", …).
const INBOX: &str = "INBOX";
/// Graph well-known folder name → the role names IMAP folders already use.
/// v1.0 mailFolder has no wellKnownName property, so each one is looked up by
/// its well-known name and matched to the listing by id.
const WELL_KNOWN_ROLES: [(&str, &str); 6] = [
    ("inbox", "inbox"),
    ("sentitems", "sent"),
    ("drafts", "drafts"),
    ("deleteditems", "trash"),
    ("junkemail", "junk"),
    ("archive", "archive"),
];
/// Separates the folder id from the conversation id in a folder-scoped thread id.
const THREAD_SEP: char = '\u{1}';
/// A listing larger than this is refused instead of mirrored half-read.
const MAX_FOLDERS: usize = 2000;

/// Graph allows only 4 concurrent requests per app per mailbox; bulk actions
/// (select all → mark read) fire one command per thread at once. Stay below it.
static GRAPH_SLOTS: std::sync::LazyLock<tokio::sync::Semaphore> =
    std::sync::LazyLock::new(|| tokio::sync::Semaphore::new(3));
const GRAPH_MAX_ATTEMPTS: u32 = 4;

fn config() -> OAuthConfig {
    OAuthConfig {
        auth_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize".into(),
        token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token".into(),
        client_id: provider_config::microsoft_client_id().unwrap_or_default().to_owned(),
        scopes: vec![
            "offline_access".into(),
            "User.Read".into(),
            // ReadWrite (not Read): mark-read and move PATCH/POST messages.
            "Mail.ReadWrite".into(),
            "Mail.Send".into(),
        ],
        purpose: OAuthPurpose::Mail,
        extra_auth_params: Vec::new(),
    }
}

/// Interactive connect: OAuth → store tokens → register account → initial sync.
pub async fn connect(store: &Store) -> Result<String, SyncError> {
    let cfg = config();
    if cfg.client_id.is_empty() {
        return Err(SyncError::NotConfigured("Microsoft sign-in is not configured in this build"));
    }
    let tok = oauth::run_pkce_flow(&cfg).await.map_err(SyncError::from)?;
    let email = fetch_email(&tok.access_token).await.unwrap_or_else(|| "me".into());
    let account_id = format!("ms:{email}");

    tokens::save(&account_id, &tok.access_token, tok.refresh_token.as_deref())
        .map_err(SyncError::Transient)?;
    store
        .upsert_account(&account_id, &email, "microsoft", &email)
        .map_err(|e| SyncError::Transient(e.to_string()))?;

    initial_sync(store, &account_id)
        .await
        .map_err(|_| SyncError::InitialSyncFailed { account_id: account_id.clone() })?;
    Ok(account_id)
}

async fn valid_token(account_id: &str) -> Result<String, SyncError> {
    if let Some(t) = tokens::access_token(account_id) {
        return Ok(t);
    }
    let refresh = tokens::refresh_token(account_id).ok_or(SyncError::AuthRequired)?;
    refresh_access(account_id, &refresh).await
}

async fn refresh_access(account_id: &str, refresh: &str) -> Result<String, SyncError> {
    let new: TokenSet = oauth::refresh(&config(), refresh).await.map_err(super::refresh_error)?;
    tokens::save(account_id, &new.access_token, new.refresh_token.as_deref())
        .map_err(SyncError::Transient)?;
    Ok(new.access_token)
}

async fn authenticated_json(
    account_id: &str,
    url: &str,
    operation: &str,
) -> Result<Value, SyncError> {
    let client = reqwest::Client::new();
    let mut access = valid_token(account_id).await?;
    for attempt in 0..2 {
        let response = client
            .get(url)
            .bearer_auth(&access)
            .send()
            .await
            .map_err(|error| SyncError::Transient(error.to_string()))?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            let refresh = tokens::refresh_token(account_id).ok_or(SyncError::AuthRequired)?;
            access = refresh_access(account_id, &refresh).await?;
            continue;
        }
        if !response.status().is_success() {
            return Err(super::http_status_error(response.status(), operation));
        }
        return response.json().await.map_err(|error| SyncError::Transient(error.to_string()));
    }
    Err(SyncError::AuthRequired)
}

/// First connect: the newest inbox mail. (`/me/messages` would also return
/// sent, draft and deleted mail and file all of it under the inbox.)
pub async fn initial_sync(store: &Store, account_id: &str) -> Result<(), SyncError> {
    fetch_messages(store, account_id, INBOX, None, 50, 0).await.map(|_| ())
}

/// List the mailbox's folders (child folders included) and mirror them into
/// the `folders` table. Returns the folder names.
pub async fn list_folders(store: &Store, account_id: &str) -> Result<Vec<String>, SyncError> {
    let mut roles: HashMap<String, &'static str> = HashMap::new();
    for (well_known, role) in WELL_KNOWN_ROLES {
        let url = format!("{GRAPH}/me/mailFolders/{well_known}?$select=id");
        match authenticated_json(account_id, &url, "Microsoft folder lookup").await {
            Ok(v) => {
                if let Some(id) = v["id"].as_str() {
                    roles.insert(id.to_string(), role);
                }
            }
            // Not every mailbox has every well-known folder (e.g. no Archive).
            Err(SyncError::Transient(message)) if role != "inbox" && message.contains("404") => {
                log::info!("microsoft: {account_id} has no {well_known} folder");
            }
            Err(error) => return Err(error),
        }
    }

    // `/me/mailFolders` returns only the root's children; each folder that has
    // children is walked separately. Both collections page with @odata.nextLink.
    let mut listed: Vec<RemoteFolder> = Vec::new();
    let mut queue = VecDeque::from([(
        format!("{GRAPH}/me/mailFolders?$top=100&$select={FOLDER_SELECT}"),
        String::new(),
    )]);
    while let Some((mut url, parent)) = queue.pop_front() {
        loop {
            let v = authenticated_json(account_id, &url, "Microsoft folder list").await?;
            for (id, path) in collect_folders(&v, &parent, &roles, &mut listed) {
                queue.push_back((
                    format!(
                        "{GRAPH}/me/mailFolders/{}/childFolders?$top=100&$select={FOLDER_SELECT}",
                        urlencoding::encode(&id)
                    ),
                    path,
                ));
            }
            if listed.len() > MAX_FOLDERS {
                return Err(SyncError::Transient(format!(
                    "Microsoft folder list: more than {MAX_FOLDERS} folders"
                )));
            }
            match v["@odata.nextLink"].as_str() {
                Some(next) => url = next.to_string(),
                None => break,
            }
        }
    }

    super::store_write(
        store.sync_remote_folders(account_id, &listed),
        "persist Microsoft folders",
    )?;
    log::info!("microsoft: {} folders for {account_id}", listed.len());
    Ok(listed.into_iter().map(|f| f.name).collect())
}

/// Add one page of a mailFolders / childFolders response to `listed` and return
/// the (id, path) of every folder on it that has children still to be listed.
fn collect_folders(
    page: &Value,
    parent: &str,
    roles: &HashMap<String, &'static str>,
    listed: &mut Vec<RemoteFolder>,
) -> Vec<(String, String)> {
    let mut with_children = Vec::new();
    for folder in page["value"].as_array().map(Vec::as_slice).unwrap_or_default() {
        let Some(id) = folder["id"].as_str() else { continue };
        let role = roles.get(id).copied();
        let mut name = folder_path(parent, folder["displayName"].as_str().unwrap_or(""), role);
        // Names are the local key. Two folders can only collide when a custom
        // top-level folder is itself called "INBOX"; keep both visible.
        while listed.iter().any(|f| f.name == name) {
            name.push_str(" (2)");
        }
        if folder["childFolderCount"].as_u64().unwrap_or(0) > 0 {
            with_children.push((id.to_string(), name.clone()));
        }
        listed.push(RemoteFolder { name, role: role.map(String::from), remote_id: id.to_string() });
    }
    with_children
}

/// Local name of a Graph folder: its display-name path joined with "/". A "/"
/// inside a display name becomes U+2215 so it cannot read as a level.
fn folder_path(parent: &str, display_name: &str, role: Option<&str>) -> String {
    if parent.is_empty() && role == Some("inbox") {
        return INBOX.to_string();
    }
    let segment = match display_name.trim() {
        "" => "(unnamed)".to_string(),
        name => name.replace('/', "\u{2215}"),
    };
    if parent.is_empty() { segment } else { format!("{parent}/{segment}") }
}

/// Sync one folder on demand. The inbox keeps its delta cursor; any other
/// folder gets its newest `limit` messages. `older` fetches the next `limit`
/// messages below the ones already stored ("load older").
pub async fn fetch_folder(
    store: &Store,
    account_id: &str,
    folder: &str,
    limit: u32,
    older: bool,
) -> Result<usize, SyncError> {
    let skip = if older { store.message_count_for_folder(account_id, folder) } else { 0 };
    if folder == INBOX {
        if older {
            return fetch_messages(store, account_id, INBOX, None, limit, skip).await;
        }
        return incremental(store, account_id).await.map(|_| 0);
    }
    let folder_id = store.folder_remote_id(account_id, folder).ok_or_else(|| {
        SyncError::Transient(format!("unknown folder {folder} — refresh the folder list"))
    })?;
    fetch_messages(store, account_id, folder, Some(&folder_id), limit, skip).await
}

/// Read up to `limit` messages of a folder, newest first, starting `skip`
/// messages down, and store them. `folder_id` None = the inbox.
async fn fetch_messages(
    store: &Store,
    account_id: &str,
    folder: &str,
    folder_id: Option<&str>,
    limit: u32,
    skip: usize,
) -> Result<usize, SyncError> {
    let limit = limit.max(1) as usize;
    let mut url = format!(
        "{}?$top={}&$orderby=receivedDateTime%20desc&$select={MESSAGE_SELECT}",
        messages_url(folder_id.or(Some("inbox"))),
        limit.min(100)
    );
    if skip > 0 {
        url.push_str(&format!("&$skip={skip}"));
    }
    let mut messages: Vec<Value> = Vec::new();
    while messages.len() < limit {
        let v = authenticated_json(account_id, &url, "Microsoft folder sync").await?;
        let items = v["value"].as_array().map(Vec::as_slice).unwrap_or_default();
        messages.extend(items.iter().cloned());
        match v["@odata.nextLink"].as_str() {
            Some(next) if !items.is_empty() => url = next.to_string(),
            _ => break,
        }
    }
    let whole_folder = skip == 0 && messages.len() < limit;
    messages.truncate(limit);
    let stored = store_messages(store, account_id, &messages, folder, folder_id)?;
    // The inbox learns about removals from its delta feed; other folders have
    // no cursor, so a fresh newest-first read is compared with what is stored.
    if folder_id.is_some() && skip == 0 {
        drop_missing_messages(store, account_id, folder, &messages, whole_folder)?;
    }
    log::info!("microsoft: stored {stored} messages from {folder} for {account_id}");
    Ok(stored)
}

/// Persist fetched messages under `folder`. Oldest first, so the newest message
/// is written last and gives the conversation row its subject, preview and time.
fn store_messages(
    store: &Store,
    account_id: &str,
    messages: &[Value],
    folder: &str,
    folder_id: Option<&str>,
) -> Result<usize, SyncError> {
    let mut stored = 0;
    for msg in messages.iter().rev() {
        if let Some(thread) = parse_message(account_id, msg, folder, folder_id) {
            super::store_write(store.upsert_thread(&thread), "persist Microsoft message")?;
            stored += 1;
        }
    }
    store.prune_empty_threads(); // a message re-filed under its real folder can empty its old row
    Ok(stored)
}

/// Remove stored messages of `folder` that the server no longer has there:
/// everything not in `fetched` when that is the whole folder, otherwise only
/// messages newer than the oldest fetched one (older ones were not looked at).
fn drop_missing_messages(
    store: &Store,
    account_id: &str,
    folder: &str,
    fetched: &[Value],
    whole_folder: bool,
) -> Result<(), SyncError> {
    let present: HashSet<&str> = fetched.iter().filter_map(|m| m["id"].as_str()).collect();
    // Graph timestamps are ISO 8601 UTC, so they order as plain strings.
    let oldest = fetched.iter().filter_map(|m| m["receivedDateTime"].as_str()).min();
    let mut removed = false;
    for (id, when) in store.folder_messages(account_id, folder) {
        let covered = whole_folder || oldest.is_some_and(|oldest| when.as_str() > oldest);
        if covered && !present.contains(id.as_str()) {
            super::store_write(store.delete_message(&id), "remove Microsoft message")?;
            removed = true;
        }
    }
    if removed {
        store.prune_empty_threads();
    }
    Ok(())
}

/// Apply one page of the inbox delta feed: `@removed` entries (deleted, or
/// moved out of the inbox) drop the stored message, the rest are upserted.
fn apply_inbox_delta(store: &Store, account_id: &str, page: &Value) -> Result<(), SyncError> {
    let mut removed = false;
    for msg in page["value"].as_array().map(Vec::as_slice).unwrap_or_default() {
        if msg.get("@removed").is_some() {
            if let Some(id) = msg["id"].as_str() {
                super::store_write(store.delete_message(id), "remove Microsoft message")?;
                removed = true;
            }
        } else if let Some(thread) = parse_message(account_id, msg, INBOX, None) {
            super::store_write(store.upsert_thread(&thread), "persist Microsoft message")?;
        }
    }
    if removed {
        store.prune_empty_threads();
    }
    Ok(())
}

/// Thread id of a conversation as seen in one folder. The inbox keeps the bare
/// conversationId it always had; every other folder is scoped by its folder id
/// so the same conversation in Inbox and in Sent stays two rows (as with IMAP).
fn thread_id_for(folder_id: Option<&str>, conversation_id: &str) -> String {
    match folder_id {
        Some(folder_id) => format!("{folder_id}{THREAD_SEP}{conversation_id}"),
        None => conversation_id.to_string(),
    }
}

/// (folder id if the thread is folder-scoped, conversationId).
fn split_thread_id(thread_id: &str) -> (Option<&str>, &str) {
    match thread_id.split_once(THREAD_SEP) {
        Some((folder_id, conversation_id)) => (Some(folder_id), conversation_id),
        None => (None, thread_id),
    }
}

/// The messages collection of one folder (id or well-known name), or of the
/// whole mailbox.
fn messages_url(folder_id: Option<&str>) -> String {
    match folder_id {
        Some(id) => format!("{GRAPH}/me/mailFolders/{}/messages", urlencoding::encode(id)),
        None => format!("{GRAPH}/me/messages"),
    }
}

/// Incremental sync via Graph delta queries. Uses the stored deltaLink/nextLink
/// when present; otherwise starts a fresh delta enumeration. Persists the final
/// deltaLink (or a nextLink to resume paging next time).
pub async fn incremental(store: &Store, account_id: &str) -> Result<(), SyncError> {
    let mut url =
        store.sync_token(account_id).filter(|t| t.starts_with("http")).unwrap_or_else(|| {
            format!("{}/delta?$select={MESSAGE_SELECT}", messages_url(Some("inbox")))
        });

    // Follow up to 5 pages per run to bound work; resume from the saved link next time.
    for _ in 0..5 {
        let v = authenticated_json(account_id, &url, "Microsoft incremental sync").await?;

        apply_inbox_delta(store, account_id, &v)?;

        if let Some(delta) = v["@odata.deltaLink"].as_str() {
            super::store_write(
                store.set_sync_token(account_id, delta),
                "persist Microsoft sync cursor",
            )?; // caught up
            break;
        } else if let Some(next) = v["@odata.nextLink"].as_str() {
            url = next.to_string();
            super::store_write(
                store.set_sync_token(account_id, next),
                "persist Microsoft sync cursor",
            )?; // resume here next run
        } else {
            break;
        }
    }
    Ok(())
}

/// Send via Graph `sendMail` (with optional file attachments).
pub async fn send(
    account_id: &str,
    to: &str,
    cc: &str,
    bcc: &str,
    subject: &str,
    body_html: &str,
    attachments: &[crate::store::Attachment],
) -> Result<(), SyncError> {
    let access = valid_token(account_id).await?;
    let atts: Vec<Value> = attachments
        .iter()
        .map(|a| {
            serde_json::json!({
                "@odata.type": "#microsoft.graph.fileAttachment",
                "name": a.name,
                "contentType": a.mime,
                "contentBytes": a.data_b64,
            })
        })
        .collect();
    // Graph wants one recipient object per address; split comma-separated lists.
    let recipients = |list: &str| -> Vec<Value> {
        list.split(',')
            .map(str::trim)
            .filter(|a| !a.is_empty())
            .map(|a| serde_json::json!({ "emailAddress": { "address": a } }))
            .collect()
    };
    let payload = serde_json::json!({
        "message": {
            "subject": subject,
            "body": { "contentType": "HTML", "content": body_html },
            "toRecipients": recipients(to),
            "ccRecipients": recipients(cc),
            "bccRecipients": recipients(bcc),
            "attachments": atts
        },
        "saveToSentItems": true
    });
    let resp = reqwest::Client::new()
        .post(format!("{GRAPH}/me/sendMail"))
        .bearer_auth(&access)
        .json(&payload)
        .send()
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(SyncError::Transient(format!("sendMail HTTP {}", resp.status())))
    }
}

/// Mark every message of a thread read/unread.
pub async fn set_read(account_id: &str, thread_id: &str, unread: bool) -> Result<(), SyncError> {
    let (folder_id, conversation_id) = split_thread_id(thread_id);
    let access = valid_token(account_id).await?;
    let client = reqwest::Client::new();
    let body = serde_json::json!({ "isRead": !unread });
    // Only touch messages not already in the wanted state: a bulk "mark read"
    // over mostly-read mail then sends a handful of writes instead of hundreds.
    let filter = format!("{} and isRead eq {}", conversation_filter(conversation_id), unread);
    for_each_message(&access, folder_id, conversation_id, &filter, "Microsoft mark read", |id| {
        client.patch(format!("{GRAPH}/me/messages/{id}")).bearer_auth(&access).json(&body)
    })
    .await
}

/// Move a thread to one of the account's folders, by its local name.
pub async fn move_to_folder(
    store: &Store,
    account_id: &str,
    thread_id: &str,
    folder: &str,
) -> Result<(), SyncError> {
    let destination = if folder == INBOX {
        "inbox".to_string()
    } else {
        store.folder_remote_id(account_id, folder).ok_or_else(|| {
            SyncError::Transient(format!("unknown folder {folder} — refresh the folder list"))
        })?
    };
    move_conversation(account_id, thread_id, &destination).await
}

/// Move a thread to a folder id or well-known folder name ("deleteditems" for
/// trash, "archive" for archive). An inbox thread moves the whole conversation;
/// a folder-scoped thread moves only its messages in that folder.
pub async fn move_conversation(
    account_id: &str,
    thread_id: &str,
    destination: &str,
) -> Result<(), SyncError> {
    let (folder_id, conversation_id) = split_thread_id(thread_id);
    let access = valid_token(account_id).await?;
    let client = reqwest::Client::new();
    let body = serde_json::json!({ "destinationId": destination });
    let filter = conversation_filter(conversation_id);
    for_each_message(&access, folder_id, conversation_id, &filter, "Microsoft move", |id| {
        client.post(format!("{GRAPH}/me/messages/{id}/move")).bearer_auth(&access).json(&body)
    })
    .await
}

/// Send one request per message of a conversation. Every refused or failed
/// request is logged; the first failure is returned so callers never see a
/// silent success.
async fn for_each_message(
    access: &str,
    folder_id: Option<&str>,
    conversation_id: &str,
    filter: &str,
    operation: &str,
    request: impl Fn(&str) -> reqwest::RequestBuilder,
) -> Result<(), SyncError> {
    let mut first_error: Option<SyncError> = None;
    for id in message_ids(access, folder_id, filter).await? {
        let error = match send_throttled(request(&id)).await {
            Ok(resp) if resp.status().is_success() => continue,
            Ok(resp) => super::http_status_error(resp.status(), operation),
            Err(e) => SyncError::Transient(format!("{operation}: {e}")),
        };
        log::warn!("{operation} failed for a message in {conversation_id}: {error}");
        first_error.get_or_insert(error);
    }
    first_error.map_or(Ok(()), Err)
}

/// Send a Graph write/lookup while holding one of the shared concurrency slots.
/// A 429/503 is retried after the server's `Retry-After` (bounded), so a bulk
/// action is slowed down instead of half-applied.
async fn send_throttled(request: reqwest::RequestBuilder) -> reqwest::Result<reqwest::Response> {
    let _slot = GRAPH_SLOTS.acquire().await.expect("Graph semaphore is never closed");
    let mut attempt = 1;
    loop {
        // JSON/empty bodies always clone; fall back to a single plain send if not.
        let Some(this_try) = request.try_clone() else { return request.send().await };
        let resp = this_try.send().await?;
        let status = resp.status();
        let throttled = status == reqwest::StatusCode::TOO_MANY_REQUESTS
            || status == reqwest::StatusCode::SERVICE_UNAVAILABLE;
        if !throttled || attempt >= GRAPH_MAX_ATTEMPTS {
            return Ok(resp);
        }
        let wait = retry_delay(
            resp.headers().get(reqwest::header::RETRY_AFTER).and_then(|v| v.to_str().ok()),
            attempt,
        );
        log::info!("Microsoft Graph HTTP {status}; retrying in {}s", wait.as_secs());
        tokio::time::sleep(wait).await;
        attempt += 1;
    }
}

/// Seconds from `Retry-After` when present, else exponential (2, 4, 8 s);
/// capped at 30 s so a UI action never hangs for minutes.
fn retry_delay(retry_after: Option<&str>, attempt: u32) -> std::time::Duration {
    let secs = retry_after
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or_else(|| 2u64.saturating_pow(attempt));
    std::time::Duration::from_secs(secs.clamp(1, 30))
}

/// OData `$filter` for one conversation. Single quotes are doubled (OData
/// string-literal escaping) so an id can never break out of the literal; the
/// caller percent-encodes it so `+`, `/` and `=` are percent-encoded.
fn conversation_filter(conversation_id: &str) -> String {
    format!("conversationId eq '{}'", conversation_id.replace('\'', "''"))
}

/// Resolve the Graph message ids matching an OData filter (built from
/// `conversation_filter`, which escapes the id), in one folder or mailbox-wide.
async fn message_ids(
    access: &str,
    folder_id: Option<&str>,
    filter: &str,
) -> Result<Vec<String>, SyncError> {
    let resp = send_throttled(
        reqwest::Client::new()
            .get(format!(
                "{}?$filter={}&$select=id&$top=50",
                messages_url(folder_id),
                urlencoding::encode(filter)
            ))
            .bearer_auth(access),
    )
    .await
    .map_err(|e| SyncError::Transient(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(super::http_status_error(resp.status(), "Microsoft conversation lookup"));
    }
    let v: Value = resp.json().await.map_err(|e| SyncError::Transient(e.to_string()))?;
    Ok(v["value"]
        .as_array()
        .map(|a| a.iter().filter_map(|m| m["id"].as_str().map(String::from)).collect())
        .unwrap_or_default())
}

async fn fetch_email(access: &str) -> Option<String> {
    let v: Value = reqwest::Client::new()
        .get(format!("{GRAPH}/me"))
        .bearer_auth(access)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    v["mail"].as_str().or_else(|| v["userPrincipalName"].as_str()).map(String::from)
}

/// Convert a Graph message into a store Thread (keyed by conversationId) filed
/// under `folder`. `folder_id` None = the inbox. A delta `@removed` entry is not
/// a message.
fn parse_message(
    account_id: &str,
    msg: &Value,
    folder: &str,
    folder_id: Option<&str>,
) -> Option<Thread> {
    if msg.get("@removed").is_some() {
        return None;
    }
    let conversation_id = msg["conversationId"].as_str().or_else(|| msg["id"].as_str())?;
    let thread_id = thread_id_for(folder_id, conversation_id);
    let msg_id = msg["id"].as_str()?.to_string();
    let to = msg["toRecipients"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|r| {
            let address = r["emailAddress"]["address"].as_str()?.to_string();
            let name = r["emailAddress"]["name"].as_str().unwrap_or("").to_string();
            Some(Party { name, address })
        })
        .collect();
    let subject =
        msg["subject"].as_str().filter(|s| !s.is_empty()).unwrap_or("(no subject)").to_string();
    let from_name = msg["from"]["emailAddress"]["name"].as_str().unwrap_or("").to_string();
    let from_addr = msg["from"]["emailAddress"]["address"].as_str().unwrap_or("").to_string();
    let preview = msg["bodyPreview"].as_str().unwrap_or("").to_string();
    let body_html = match msg["body"]["contentType"].as_str() {
        Some("html") => msg["body"]["content"].as_str().unwrap_or("").to_string(),
        _ => format!("<p>{}</p>", msg["body"]["content"].as_str().unwrap_or(&preview)),
    };
    let unread = !msg["isRead"].as_bool().unwrap_or(true);
    let when = msg["receivedDateTime"].as_str().unwrap_or("").to_string();

    Some(Thread {
        id: thread_id,
        account_id: account_id.to_string(),
        subject,
        preview,
        participants: vec![if from_name.is_empty() {
            from_addr.clone()
        } else {
            from_name.clone()
        }],
        last_time: when.clone(),
        unread,
        labels: vec![],
        // Smart views (All Inbox, Priority) are inbox views; other folders are
        // reached through the folder list only.
        view: if folder_id.is_none() { vec!["inbox".into()] } else { vec![] },
        folder: folder.to_string(),
        ai_summary: None,
        ai_draft: None,
        messages: vec![Message {
            id: msg_id,
            from: Party { name: from_name, address: from_addr },
            to,
            when,
            body_html,
            attachments: vec![], // Graph: fetched via /messages/{id}/attachments on demand
            meta: None,
        }],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_graph_message() {
        let v = serde_json::json!({
            "id": "AAA", "conversationId": "C1", "subject": "Quote",
            "from": { "emailAddress": { "name": "Sam", "address": "sam@contoso.com" } },
            "bodyPreview": "hi", "body": { "contentType": "html", "content": "<p>hi</p>" },
            "isRead": false, "receivedDateTime": "2026-05-29T10:00:00Z"
        });
        let t = parse_message("ms:me", &v, INBOX, None).unwrap();
        assert_eq!(t.id, "C1");
        assert_eq!(t.folder, "INBOX");
        assert_eq!(t.view, vec!["inbox".to_string()]);
        assert_eq!(t.subject, "Quote");
        assert!(t.unread);
        assert_eq!(t.messages[0].from.address, "sam@contoso.com");
    }

    fn graph_message(id: &str, conversation: &str, received: &str) -> Value {
        serde_json::json!({
            "id": id, "conversationId": conversation, "subject": format!("Subject {id}"),
            "from": { "emailAddress": { "name": "Sam", "address": "sam@contoso.com" } },
            "toRecipients": [
                { "emailAddress": { "name": "Me", "address": "me@contoso.com" } },
                { "emailAddress": { "address": "other@contoso.com" } }
            ],
            "bodyPreview": "hi", "body": { "contentType": "html", "content": "<p>hi</p>" },
            "isRead": true, "receivedDateTime": received
        })
    }

    fn ms_store() -> Store {
        let store = Store::in_memory().unwrap();
        store.upsert_account("ms:me", "me@contoso.com", "microsoft", "Me").unwrap();
        store
    }

    fn folders_of(store: &Store) -> Vec<(String, Option<String>)> {
        store.folders("ms:me").into_iter().map(|f| (f.name, f.role)).collect()
    }

    #[test]
    fn folder_message_is_filed_under_its_folder_with_a_scoped_thread_id() {
        let msg = graph_message("M1", "C1", "2026-05-29T10:00:00Z");
        let t = parse_message("ms:me", &msg, "Sent Items", Some("F-SENT")).unwrap();
        assert_eq!(t.folder, "Sent Items");
        assert_eq!(t.id, "F-SENT\u{1}C1");
        assert_eq!(split_thread_id(&t.id), (Some("F-SENT"), "C1"));
        assert!(t.view.is_empty(), "only inbox mail belongs to the inbox smart views");
        let to: Vec<&str> = t.messages[0].to.iter().map(|p| p.address.as_str()).collect();
        assert_eq!(to, ["me@contoso.com", "other@contoso.com"]);

        assert_eq!(split_thread_id("C1"), (None, "C1"));
        assert_eq!(thread_id_for(None, "C1"), "C1");
    }

    #[test]
    fn delta_removed_entry_is_not_a_message() {
        let removed = serde_json::json!({ "id": "M1", "@removed": { "reason": "deleted" } });
        assert!(parse_message("ms:me", &removed, INBOX, None).is_none());
    }

    // Shape of the List mailFolders response (Graph v1.0 docs): no wellKnownName,
    // roles come from matching ids of the well-known folders.
    #[test]
    fn mail_folders_page_maps_roles_and_reports_folders_with_children() {
        let roles: HashMap<String, &'static str> = HashMap::from([
            ("id-inbox".to_string(), "inbox"),
            ("id-sent".to_string(), "sent"),
            ("id-trash".to_string(), "trash"),
        ]);
        let page = serde_json::json!({
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders?$skip=10",
            "value": [
                { "id": "id-inbox", "displayName": "Posteingang", "parentFolderId": "root",
                  "childFolderCount": 1, "unreadItemCount": 2, "totalItemCount": 9, "isHidden": false },
                { "id": "id-sent", "displayName": "Gesendete Elemente", "childFolderCount": 0 },
                { "id": "id-trash", "displayName": "Deleted Items", "childFolderCount": 0 },
                { "id": "id-proj", "displayName": "Projects", "childFolderCount": 2 },
                { "id": "id-user-inbox", "displayName": "INBOX", "childFolderCount": 0 },
                { "displayName": "no id is skipped" }
            ]
        });
        let mut listed = Vec::new();
        let parents = collect_folders(&page, "", &roles, &mut listed);

        let got: Vec<(&str, Option<&str>, &str)> = listed
            .iter()
            .map(|f| (f.name.as_str(), f.role.as_deref(), f.remote_id.as_str()))
            .collect();
        assert_eq!(
            got,
            [
                ("INBOX", Some("inbox"), "id-inbox"),
                ("Gesendete Elemente", Some("sent"), "id-sent"),
                ("Deleted Items", Some("trash"), "id-trash"),
                ("Projects", None, "id-proj"),
                ("INBOX (2)", None, "id-user-inbox"),
            ]
        );
        assert_eq!(
            parents,
            [
                ("id-inbox".to_string(), "INBOX".to_string()),
                ("id-proj".to_string(), "Projects".to_string())
            ]
        );

        // A childFolders page nests under its parent's path.
        let children = serde_json::json!({ "value": [
            { "id": "id-2026", "displayName": "2026 / Q1 v2.0", "childFolderCount": 0 }
        ]});
        assert!(collect_folders(&children, "Projects", &roles, &mut listed).is_empty());
        assert_eq!(listed.last().unwrap().name, "Projects/2026 \u{2215} Q1 v2.0");
    }

    #[test]
    fn well_known_folders_map_to_the_roles_imap_uses() {
        let role = |name: &str| WELL_KNOWN_ROLES.iter().find(|(w, _)| *w == name).map(|(_, r)| *r);
        assert_eq!(role("inbox"), Some("inbox"));
        assert_eq!(role("sentitems"), Some("sent"));
        assert_eq!(role("drafts"), Some("drafts"));
        assert_eq!(role("deleteditems"), Some("trash"));
        assert_eq!(role("junkemail"), Some("junk"));
        assert_eq!(role("archive"), Some("archive"));
        assert_eq!(folder_path("", "Posteingang", Some("inbox")), "INBOX");
        assert_eq!(folder_path("INBOX", "Inbox", Some("inbox")), "INBOX/Inbox");
        assert_eq!(folder_path("", " ", None), "(unnamed)");
    }

    #[test]
    fn listed_folders_are_stored_and_follow_server_renames_and_deletions() {
        let store = ms_store();
        let folder = |name: &str, role: Option<&str>, id: &str| RemoteFolder {
            name: name.into(),
            role: role.map(String::from),
            remote_id: id.into(),
        };
        store
            .sync_remote_folders(
                "ms:me",
                &[
                    folder("INBOX", Some("inbox"), "id-inbox"),
                    folder("Sent Items", Some("sent"), "id-sent"),
                    folder("Projects", None, "id-proj"),
                    folder("Old", None, "id-old"),
                ],
            )
            .unwrap();
        assert_eq!(store.folder_remote_id("ms:me", "Projects").as_deref(), Some("id-proj"));
        assert_eq!(store.folder_remote_id("ms:me", "Nope"), None);
        for (name, id) in [("Projects", "id-proj"), ("Old", "id-old")] {
            let msg = graph_message(&format!("M-{id}"), "C1", "2026-05-29T10:00:00Z");
            store_messages(&store, "ms:me", &[msg], name, Some(id)).unwrap();
        }

        // Renamed on the server (same id), and "Old" deleted there.
        store
            .sync_remote_folders(
                "ms:me",
                &[
                    folder("INBOX", Some("inbox"), "id-inbox"),
                    folder("Sent Items", Some("sent"), "id-sent"),
                    folder("Clients", None, "id-proj"),
                ],
            )
            .unwrap();
        let mut folders = folders_of(&store);
        folders.sort();
        assert_eq!(
            folders,
            [
                ("Clients".to_string(), None),
                ("INBOX".to_string(), Some("inbox".to_string())),
                ("Sent Items".to_string(), Some("sent".to_string())),
            ]
        );
        let threads = store.threads();
        assert_eq!(threads.len(), 1, "mail of the deleted folder is gone");
        assert_eq!(threads[0].folder, "Clients", "mail follows the renamed folder");
    }

    #[test]
    fn synced_folder_mail_is_recorded_under_that_folder_only() {
        let store = ms_store();
        let inbox = graph_message("M-in", "C1", "2026-05-29T09:00:00Z");
        store_messages(&store, "ms:me", &[inbox], INBOX, None).unwrap();
        // Newest first, as Graph returns them with $orderby=receivedDateTime desc.
        let sent = [
            graph_message("M-s2", "C1", "2026-05-29T11:00:00Z"),
            graph_message("M-s1", "C1", "2026-05-29T10:00:00Z"),
            graph_message("M-s0", "C2", "2026-05-28T10:00:00Z"),
        ];
        assert_eq!(
            store_messages(&store, "ms:me", &sent, "Sent Items", Some("F-SENT")).unwrap(),
            3
        );

        let mut by_folder: Vec<(String, String, String)> =
            store.threads().into_iter().map(|t| (t.folder, t.id, t.subject)).collect();
        by_folder.sort();
        assert_eq!(
            by_folder,
            [
                ("INBOX".to_string(), "C1".to_string(), "Subject M-in".to_string()),
                // The newest message names the conversation row.
                ("Sent Items".to_string(), "F-SENT\u{1}C1".to_string(), "Subject M-s2".to_string()),
                ("Sent Items".to_string(), "F-SENT\u{1}C2".to_string(), "Subject M-s0".to_string()),
            ]
        );
        assert_eq!(store.message_count_for_folder("ms:me", "Sent Items"), 3);
        assert_eq!(store.message_count_for_folder("ms:me", INBOX), 1);
    }

    #[test]
    fn mail_filed_under_the_inbox_by_the_old_sync_moves_to_its_real_folder() {
        let store = ms_store();
        // Before folders existed every message, sent ones included, landed in INBOX.
        let msg = graph_message("M-s1", "C1", "2026-05-29T10:00:00Z");
        store_messages(&store, "ms:me", std::slice::from_ref(&msg), INBOX, None).unwrap();
        store_messages(&store, "ms:me", &[msg], "Sent Items", Some("F-SENT")).unwrap();

        let threads = store.threads();
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].folder, "Sent Items");
    }

    #[test]
    fn folder_resync_drops_mail_the_server_no_longer_has_there() {
        let store = ms_store();
        let all = [
            graph_message("M3", "C3", "2026-05-29T12:00:00Z"),
            graph_message("M2", "C2", "2026-05-29T11:00:00Z"),
            graph_message("M1", "C1", "2026-05-29T10:00:00Z"),
        ];
        store_messages(&store, "ms:me", &all, "Drafts", Some("F-D")).unwrap();

        // A partial (page-limited) read without M2: only mail newer than the
        // oldest fetched message was looked at, so M1 must survive.
        let page = [graph_message("M3", "C3", "2026-05-29T12:00:00Z")];
        drop_missing_messages(&store, "ms:me", "Drafts", &page, false).unwrap();
        assert_eq!(store.threads().len(), 3);
        let page = [all[0].clone(), all[2].clone()];
        drop_missing_messages(&store, "ms:me", "Drafts", &page, false).unwrap();
        let mut ids: Vec<String> =
            store.threads().into_iter().map(|t| t.messages[0].id.clone()).collect();
        ids.sort();
        assert_eq!(ids, ["M1", "M3"]);

        // A read of the whole folder: everything not returned is gone.
        drop_missing_messages(&store, "ms:me", "Drafts", &all[..1], true).unwrap();
        let ids: Vec<String> =
            store.threads().into_iter().map(|t| t.messages[0].id.clone()).collect();
        assert_eq!(ids, ["M3"]);
    }

    #[test]
    fn inbox_delta_stores_new_mail_and_removes_mail_that_left_the_inbox() {
        let store = ms_store();
        let page = serde_json::json!({ "value": [
            graph_message("M1", "C1", "2026-05-29T10:00:00Z"),
            graph_message("M2", "C2", "2026-05-29T11:00:00Z"),
        ]});
        apply_inbox_delta(&store, "ms:me", &page).unwrap();
        assert_eq!(store.threads().len(), 2);

        let page = serde_json::json!({ "value": [
            { "@odata.type": "#microsoft.graph.message", "id": "M1", "@removed": { "reason": "deleted" } }
        ]});
        apply_inbox_delta(&store, "ms:me", &page).unwrap();
        let threads = store.threads();
        assert_eq!(threads.len(), 1, "no placeholder row for the removed entry");
        assert_eq!(threads[0].id, "C2");
        assert_eq!(threads[0].folder, "INBOX");
    }

    #[test]
    fn folder_requests_use_documented_urls() {
        assert_eq!(messages_url(None), "https://graph.microsoft.com/v1.0/me/messages");
        assert_eq!(
            messages_url(Some("inbox")),
            "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages"
        );
        // Folder ids are base64 and may hold "=", "+" or "/".
        assert_eq!(
            messages_url(Some("AA+/=")),
            "https://graph.microsoft.com/v1.0/me/mailFolders/AA%2B%2F%3D/messages"
        );
    }

    #[test]
    fn conversation_filter_escapes_quotes() {
        assert_eq!(conversation_filter("AAQk+/="), "conversationId eq 'AAQk+/='");
        assert_eq!(
            conversation_filter("x' or subject eq 'y"),
            "conversationId eq 'x'' or subject eq ''y'"
        );
    }

    #[test]
    fn retry_delay_honours_retry_after_with_bounds() {
        assert_eq!(retry_delay(Some("5"), 1).as_secs(), 5);
        assert_eq!(retry_delay(Some("600"), 1).as_secs(), 30);
        assert_eq!(retry_delay(Some("0"), 1).as_secs(), 1);
        assert_eq!(retry_delay(None, 1).as_secs(), 2);
        assert_eq!(retry_delay(Some("soon"), 3).as_secs(), 8);
    }

    #[test]
    fn requests_write_scope_for_read_and_move() {
        let scopes = config().scopes;
        assert!(scopes.iter().any(|s| s == "Mail.ReadWrite"));
        assert!(!scopes.iter().any(|s| s == "Mail.Read"));
    }
}
