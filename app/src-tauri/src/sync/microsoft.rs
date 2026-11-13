//! Microsoft 365 provider: OAuth (PKCE) + Microsoft Graph sync into the store.
//!
//! Reuses the generic PKCE loopback flow (see `oauth.rs`). Set your Azure
//! "Mobile & desktop" app client id via `BHARGA_MS_CLIENT_ID` (public client,
//! no secret with PKCE; register `http://localhost` as a redirect URI).

use serde_json::Value;

use super::oauth::{self, OAuthConfig, OAuthPurpose, TokenSet};
use super::{SyncError, provider_config, tokens};
use crate::store::{Message, Party, Store, Thread};

const GRAPH: &str = "https://graph.microsoft.com/v1.0";

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

pub async fn initial_sync(store: &Store, account_id: &str) -> Result<(), SyncError> {
    let url = format!(
        "{GRAPH}/me/messages?$top=50&$select=id,conversationId,subject,from,bodyPreview,body,isRead,receivedDateTime"
    );
    let v = authenticated_json(account_id, &url, "Microsoft initial sync").await?;

    if let Some(items) = v["value"].as_array() {
        for msg in items {
            if let Some(thread) = parse_message(account_id, msg) {
                super::store_write(store.upsert_thread(&thread), "persist Microsoft message")?;
            }
        }
    }
    Ok(())
}

/// Incremental sync via Graph delta queries. Uses the stored deltaLink/nextLink
/// when present; otherwise starts a fresh delta enumeration. Persists the final
/// deltaLink (or a nextLink to resume paging next time).
pub async fn incremental(store: &Store, account_id: &str) -> Result<(), SyncError> {
    let mut url = store.sync_token(account_id).filter(|t| t.starts_with("http")).unwrap_or_else(|| {
        format!("{GRAPH}/me/mailFolders/inbox/messages/delta?$select=id,conversationId,subject,from,bodyPreview,body,isRead,receivedDateTime")
    });

    // Follow up to 5 pages per run to bound work; resume from the saved link next time.
    for _ in 0..5 {
        let v = authenticated_json(account_id, &url, "Microsoft incremental sync").await?;

        if let Some(items) = v["value"].as_array() {
            for msg in items {
                if let Some(thread) = parse_message(account_id, msg) {
                    super::store_write(store.upsert_thread(&thread), "persist Microsoft message")?;
                }
            }
        }

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

/// Mark every message in a conversation read/unread.
pub async fn set_read(
    account_id: &str,
    conversation_id: &str,
    unread: bool,
) -> Result<(), SyncError> {
    let access = valid_token(account_id).await?;
    let client = reqwest::Client::new();
    let body = serde_json::json!({ "isRead": !unread });
    for_each_message(&access, conversation_id, "Microsoft mark read", |id| {
        client.patch(format!("{GRAPH}/me/messages/{id}")).bearer_auth(&access).json(&body)
    })
    .await
}

/// Move a conversation to a well-known folder ("deleteditems" for trash,
/// "archive" for archive).
pub async fn move_conversation(
    account_id: &str,
    conversation_id: &str,
    destination: &str,
) -> Result<(), SyncError> {
    let access = valid_token(account_id).await?;
    let client = reqwest::Client::new();
    let body = serde_json::json!({ "destinationId": destination });
    for_each_message(&access, conversation_id, "Microsoft move", |id| {
        client.post(format!("{GRAPH}/me/messages/{id}/move")).bearer_auth(&access).json(&body)
    })
    .await
}

/// Send one request per message of a conversation. Every refused or failed
/// request is logged; the first failure is returned so callers never see a
/// silent success.
async fn for_each_message(
    access: &str,
    conversation_id: &str,
    operation: &str,
    request: impl Fn(&str) -> reqwest::RequestBuilder,
) -> Result<(), SyncError> {
    let mut first_error: Option<SyncError> = None;
    for id in message_ids(access, conversation_id).await? {
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

/// Resolve the Graph message ids that belong to a conversation.
async fn message_ids(access: &str, conversation_id: &str) -> Result<Vec<String>, SyncError> {
    let resp = send_throttled(
        reqwest::Client::new()
            .get(format!(
                "{GRAPH}/me/messages?$filter={}&$select=id&$top=50",
                urlencoding::encode(&conversation_filter(conversation_id))
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

/// Convert a Graph message into a store Thread (keyed by conversationId).
fn parse_message(account_id: &str, msg: &Value) -> Option<Thread> {
    let thread_id = msg["conversationId"].as_str().or_else(|| msg["id"].as_str())?.to_string();
    let msg_id = msg["id"].as_str()?.to_string();
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
        view: vec!["inbox".into()],
        folder: "INBOX".into(),
        ai_summary: None,
        ai_draft: None,
        messages: vec![Message {
            id: msg_id,
            from: Party { name: from_name, address: from_addr },
            to: vec![],
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
        let t = parse_message("ms:me", &v).unwrap();
        assert_eq!(t.id, "C1");
        assert_eq!(t.subject, "Quote");
        assert!(t.unread);
        assert_eq!(t.messages[0].from.address, "sam@contoso.com");
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
