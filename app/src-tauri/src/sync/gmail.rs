//! Gmail provider: OAuth (PKCE) + REST sync into the local store.
//!
//! Initial sync pulls recent messages; incremental sync uses the History API
//! (`historyId`) to fetch only changes. Bodies are decoded from base64url MIME.
//! Set your OAuth client id via the `BHARGA_GMAIL_CLIENT_ID` env var (desktop
//! "installed app" client — no secret needed with PKCE).

use base64::{engine::general_purpose::URL_SAFE, Engine};
use serde_json::Value;

use super::oauth::{self, OAuthConfig, TokenSet};
use super::{tokens, SyncError};
use crate::store::{Message, Party, Store, Thread};

const GMAIL_API: &str = "https://gmail.googleapis.com/gmail/v1/users/me";

fn config() -> OAuthConfig {
    OAuthConfig {
        auth_url: "https://accounts.google.com/o/oauth2/v2/auth".into(),
        token_url: "https://oauth2.googleapis.com/token".into(),
        client_id: std::env::var("BHARGA_GMAIL_CLIENT_ID").unwrap_or_default(),
        scopes: vec![
            "https://www.googleapis.com/auth/gmail.readonly".into(),
            "https://www.googleapis.com/auth/gmail.send".into(),
            "https://www.googleapis.com/auth/userinfo.email".into(),
            "openid".into(),
        ],
    }
}

/// Interactive connect: run OAuth, store tokens, register the account, do an
/// initial sync. Returns the account id.
pub async fn connect(store: &Store) -> Result<String, SyncError> {
    let cfg = config();
    if cfg.client_id.is_empty() {
        return Err(SyncError::Transient("BHARGA_GMAIL_CLIENT_ID not set".into()));
    }
    let tokens_set = oauth::run_pkce_flow(&cfg).await.map_err(|e| SyncError::Transient(e.to_string()))?;
    let email = fetch_email(&tokens_set.access_token).await.unwrap_or_else(|| "me".into());
    let account_id = format!("gmail:{email}");

    tokens::save(&account_id, &tokens_set.access_token, tokens_set.refresh_token.as_deref());
    store
        .upsert_account(&account_id, &email, "gmail", &email)
        .map_err(|e| SyncError::Transient(e.to_string()))?;

    initial_sync(store, &account_id, &tokens_set.access_token).await?;
    Ok(account_id)
}

/// Ensure we have a valid access token, refreshing if needed.
async fn valid_token(account_id: &str) -> Result<String, SyncError> {
    if let Some(t) = tokens::access_token(account_id) {
        // Phase 1: check expiry; for now, try it and refresh on 401.
        return Ok(t);
    }
    let refresh = tokens::refresh_token(account_id).ok_or(SyncError::AuthRequired)?;
    let new: TokenSet = oauth::refresh(&config(), &refresh)
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?;
    tokens::save(account_id, &new.access_token, new.refresh_token.as_deref());
    Ok(new.access_token)
}

/// Pull the most recent messages and persist them.
pub async fn initial_sync(store: &Store, account_id: &str, access: &str) -> Result<(), SyncError> {
    let client = reqwest::Client::new();
    let list: Value = client
        .get(format!("{GMAIL_API}/messages?maxResults=50"))
        .bearer_auth(access)
        .send()
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?
        .json()
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?;

    let ids: Vec<String> = list["messages"]
        .as_array()
        .map(|a| a.iter().filter_map(|m| m["id"].as_str().map(String::from)).collect())
        .unwrap_or_default();

    for id in ids {
        if let Ok(full) = fetch_message(&client, access, &id).await {
            if let Some(thread) = parse_message(account_id, &full) {
                let _ = store.upsert_thread(&thread);
            }
        }
    }

    if let Some(hid) = list["historyId"].as_str() {
        let _ = store.set_sync_token(account_id, hid);
    }
    Ok(())
}

/// Send a message via the Gmail API (`messages.send` with a base64url raw MIME).
pub async fn send(account_id: &str, to: &str, cc: &str, bcc: &str, subject: &str, body_html: &str, attachments: &[crate::store::Attachment]) -> Result<(), SyncError> {
    let access = valid_token(account_id).await?;
    let from = account_id.strip_prefix("gmail:").unwrap_or("me");
    let raw = super::mime::build_raw(from, to, cc, bcc, subject, body_html, attachments);
    let resp = reqwest::Client::new()
        .post(format!("{GMAIL_API}/messages/send"))
        .bearer_auth(&access)
        .json(&serde_json::json!({ "raw": raw }))
        .send()
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(SyncError::Transient(format!("send HTTP {}", resp.status())))
    }
}

/// Mark a whole Gmail thread read/unread by toggling the UNREAD label.
pub async fn set_read(account_id: &str, thread_id: &str, unread: bool) -> Result<(), SyncError> {
    let access = valid_token(account_id).await?;
    let body = if unread {
        serde_json::json!({ "addLabelIds": ["UNREAD"] })
    } else {
        serde_json::json!({ "removeLabelIds": ["UNREAD"] })
    };
    modify_thread(&access, thread_id, body).await
}

/// Archive a thread (Gmail archive = remove the INBOX label).
pub async fn archive(account_id: &str, thread_id: &str) -> Result<(), SyncError> {
    let access = valid_token(account_id).await?;
    modify_thread(&access, thread_id, serde_json::json!({ "removeLabelIds": ["INBOX"] })).await
}

/// Report a thread as spam (Gmail: add SPAM, remove INBOX).
pub async fn spam(account_id: &str, thread_id: &str) -> Result<(), SyncError> {
    let access = valid_token(account_id).await?;
    modify_thread(&access, thread_id, serde_json::json!({ "addLabelIds": ["SPAM"], "removeLabelIds": ["INBOX"] })).await
}

/// Move a thread to Trash.
pub async fn trash(account_id: &str, thread_id: &str) -> Result<(), SyncError> {
    let access = valid_token(account_id).await?;
    let resp = reqwest::Client::new()
        .post(format!("{GMAIL_API}/threads/{thread_id}/trash"))
        .bearer_auth(&access)
        .send()
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?;
    http_ok(resp, "trash")
}

async fn modify_thread(access: &str, thread_id: &str, body: Value) -> Result<(), SyncError> {
    let resp = reqwest::Client::new()
        .post(format!("{GMAIL_API}/threads/{thread_id}/modify"))
        .bearer_auth(access)
        .json(&body)
        .send()
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?;
    http_ok(resp, "modify")
}

fn http_ok(resp: reqwest::Response, what: &str) -> Result<(), SyncError> {
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(SyncError::Transient(format!("{what} HTTP {}", resp.status())))
    }
}

/// Incremental sync via the History API: fetch only messages added since the
/// stored historyId. Falls back to a full sync if there's no cursor or the
/// cursor has expired (Gmail returns 404 for history older than ~1 week).
pub async fn incremental(store: &Store, account_id: &str) -> Result<(), SyncError> {
    let access = valid_token(account_id).await?;
    let Some(start) = store.sync_token(account_id) else {
        return initial_sync(store, account_id, &access).await;
    };

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{GMAIL_API}/history?startHistoryId={start}&historyTypes=messageAdded"))
        .bearer_auth(&access)
        .send()
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return initial_sync(store, account_id, &access).await; // cursor expired
    }
    let v: Value = resp.json().await.map_err(|e| SyncError::Transient(e.to_string()))?;

    // Collect newly-added message ids from the history records.
    let mut ids: Vec<String> = Vec::new();
    if let Some(hist) = v["history"].as_array() {
        for h in hist {
            if let Some(added) = h["messagesAdded"].as_array() {
                for m in added {
                    if let Some(id) = m["message"]["id"].as_str() {
                        ids.push(id.to_string());
                    }
                }
            }
        }
    }
    ids.sort();
    ids.dedup();

    for id in ids {
        if let Ok(full) = fetch_message(&client, &access, &id).await {
            if let Some(thread) = parse_message(account_id, &full) {
                let _ = store.upsert_thread(&thread);
            }
        }
    }

    if let Some(h) = v["historyId"].as_str() {
        let _ = store.set_sync_token(account_id, h);
    }
    Ok(())
}

async fn fetch_email(access: &str) -> Option<String> {
    let v: Value = reqwest::Client::new()
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .bearer_auth(access)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    v["email"].as_str().map(String::from)
}

async fn fetch_message(client: &reqwest::Client, access: &str, id: &str) -> Result<Value, SyncError> {
    client
        .get(format!("{GMAIL_API}/messages/{id}?format=full"))
        .bearer_auth(access)
        .send()
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?
        .json()
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))
}

/// Convert a Gmail `messages.get` payload into a store Thread (one message).
/// Real threading groups by `threadId`; here each message maps to a thread row
/// keyed by threadId so replies coalesce.
fn parse_message(account_id: &str, msg: &Value) -> Option<Thread> {
    let thread_id = msg["threadId"].as_str()?.to_string();
    let msg_id = msg["id"].as_str()?.to_string();
    let headers = &msg["payload"]["headers"];
    let h = |name: &str| header(headers, name);

    let subject = h("Subject").unwrap_or_else(|| "(no subject)".into());
    let from_raw = h("From").unwrap_or_default();
    let (from_name, from_addr) = split_addr(&from_raw);
    let snippet = msg["snippet"].as_str().unwrap_or("").to_string();
    let body_html = extract_body(&msg["payload"]).unwrap_or_else(|| format!("<p>{snippet}</p>"));
    let labels: Vec<String> = msg["labelIds"]
        .as_array()
        .map(|a| a.iter().filter_map(|l| l.as_str().map(|s| s.to_lowercase())).collect())
        .unwrap_or_default();
    let unread = labels.iter().any(|l| l == "unread");

    Some(Thread {
        id: thread_id,
        account_id: account_id.to_string(),
        subject,
        preview: snippet,
        participants: vec![if from_name.is_empty() { from_addr.clone() } else { from_name.clone() }],
        last_time: h("Date").unwrap_or_default(),
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
            when: h("Date").unwrap_or_default(),
            body_html,
            attachments: gmail_attachments(&msg["payload"]),
            meta: None,
        }],
    })
}

/// Collect attachment metadata from the MIME tree (parts with a filename).
fn gmail_attachments(payload: &Value) -> Vec<crate::store::AttachmentMeta> {
    fn walk(part: &Value, out: &mut Vec<crate::store::AttachmentMeta>) {
        let filename = part["filename"].as_str().unwrap_or("");
        if !filename.is_empty() {
            out.push(crate::store::AttachmentMeta {
                name: filename.to_string(),
                mime: part["mimeType"].as_str().unwrap_or("application/octet-stream").to_string(),
                size: part["body"]["size"].as_u64().unwrap_or(0),
            });
        }
        if let Some(parts) = part["parts"].as_array() {
            for p in parts {
                walk(p, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(payload, &mut out);
    out
}

fn header(headers: &Value, name: &str) -> Option<String> {
    headers.as_array()?.iter().find_map(|hh| {
        if hh["name"].as_str()?.eq_ignore_ascii_case(name) {
            hh["value"].as_str().map(String::from)
        } else {
            None
        }
    })
}

/// Walk the MIME tree for text/html (preferred) or text/plain, base64url-decoded.
fn extract_body(payload: &Value) -> Option<String> {
    fn walk(part: &Value, want: &str) -> Option<String> {
        if part["mimeType"].as_str() == Some(want) {
            if let Some(data) = part["body"]["data"].as_str() {
                if let Ok(bytes) = URL_SAFE.decode(data.replace('-', "+").replace('_', "/")) {
                    return String::from_utf8(bytes).ok();
                }
            }
        }
        if let Some(parts) = part["parts"].as_array() {
            for p in parts {
                if let Some(found) = walk(p, want) {
                    return Some(found);
                }
            }
        }
        None
    }
    walk(payload, "text/html").or_else(|| walk(payload, "text/plain").map(|t| format!("<p>{t}</p>")))
}

fn split_addr(raw: &str) -> (String, String) {
    // "Name <addr@host>" or "addr@host"
    if let Some(open) = raw.find('<') {
        let name = raw[..open].trim().trim_matches('"').to_string();
        let addr = raw[open + 1..].trim_end_matches('>').trim().to_string();
        (name, addr)
    } else {
        (String::new(), raw.trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_addr_handles_both_forms() {
        assert_eq!(split_addr("Lena <lena@x.co>"), ("Lena".into(), "lena@x.co".into()));
        assert_eq!(split_addr("bob@y.io"), (String::new(), "bob@y.io".into()));
    }

    #[test]
    fn parse_minimal_message() {
        let v = serde_json::json!({
            "id": "m1", "threadId": "th1", "snippet": "hello",
            "labelIds": ["INBOX","UNREAD"],
            "payload": { "mimeType": "text/plain",
                "headers": [{"name":"Subject","value":"Hi"},{"name":"From","value":"A <a@b.c>"}],
                "body": {} }
        });
        let t = parse_message("gmail:me", &v).unwrap();
        assert_eq!(t.subject, "Hi");
        assert!(t.unread);
        assert_eq!(t.messages[0].from.address, "a@b.c");
    }
}
