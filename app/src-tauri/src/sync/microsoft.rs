//! Microsoft 365 provider: OAuth (PKCE) + Microsoft Graph sync into the store.
//!
//! Reuses the generic PKCE loopback flow (see `oauth.rs`). Set your Azure
//! "Mobile & desktop" app client id via `AETHER_MS_CLIENT_ID` (public client,
//! no secret with PKCE; register `http://localhost` as a redirect URI).

use serde_json::Value;

use super::oauth::{self, OAuthConfig, TokenSet};
use super::{tokens, SyncError};
use crate::store::{Message, Party, Store, Thread};

const GRAPH: &str = "https://graph.microsoft.com/v1.0";

fn config() -> OAuthConfig {
    OAuthConfig {
        auth_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize".into(),
        token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token".into(),
        client_id: std::env::var("AETHER_MS_CLIENT_ID").unwrap_or_default(),
        scopes: vec![
            "offline_access".into(),
            "User.Read".into(),
            "Mail.Read".into(),
            "Mail.Send".into(),
        ],
    }
}

/// Interactive connect: OAuth → store tokens → register account → initial sync.
pub async fn connect(store: &Store) -> Result<String, SyncError> {
    let cfg = config();
    if cfg.client_id.is_empty() {
        return Err(SyncError::Transient("AETHER_MS_CLIENT_ID not set".into()));
    }
    let tok = oauth::run_pkce_flow(&cfg).await.map_err(|e| SyncError::Transient(e.to_string()))?;
    let email = fetch_email(&tok.access_token).await.unwrap_or_else(|| "me".into());
    let account_id = format!("ms:{email}");

    tokens::save(&account_id, &tok.access_token, tok.refresh_token.as_deref());
    store
        .upsert_account(&account_id, &email, "microsoft", &email)
        .map_err(|e| SyncError::Transient(e.to_string()))?;

    initial_sync(store, &account_id, &tok.access_token).await?;
    Ok(account_id)
}

async fn valid_token(account_id: &str) -> Result<String, SyncError> {
    if let Some(t) = tokens::access_token(account_id) {
        return Ok(t);
    }
    let refresh = tokens::refresh_token(account_id).ok_or(SyncError::AuthRequired)?;
    let new: TokenSet = oauth::refresh(&config(), &refresh)
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?;
    tokens::save(account_id, &new.access_token, new.refresh_token.as_deref());
    Ok(new.access_token)
}

pub async fn initial_sync(store: &Store, account_id: &str, access: &str) -> Result<(), SyncError> {
    let url = format!(
        "{GRAPH}/me/messages?$top=50&$select=id,conversationId,subject,from,bodyPreview,body,isRead,receivedDateTime"
    );
    let v: Value = reqwest::Client::new()
        .get(url)
        .bearer_auth(access)
        .send()
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?
        .json()
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?;

    if let Some(items) = v["value"].as_array() {
        for msg in items {
            if let Some(thread) = parse_message(account_id, msg) {
                let _ = store.upsert_thread(&thread);
            }
        }
    }
    Ok(())
}

/// Incremental sync via Graph delta queries. Uses the stored deltaLink/nextLink
/// when present; otherwise starts a fresh delta enumeration. Persists the final
/// deltaLink (or a nextLink to resume paging next time).
pub async fn incremental(store: &Store, account_id: &str) -> Result<(), SyncError> {
    let access = valid_token(account_id).await?;
    let client = reqwest::Client::new();

    let mut url = store.sync_token(account_id).filter(|t| t.starts_with("http")).unwrap_or_else(|| {
        format!("{GRAPH}/me/mailFolders/inbox/messages/delta?$select=id,conversationId,subject,from,bodyPreview,body,isRead,receivedDateTime")
    });

    // Follow up to 5 pages per run to bound work; resume from the saved link next time.
    for _ in 0..5 {
        let v: Value = client
            .get(&url)
            .bearer_auth(&access)
            .send()
            .await
            .map_err(|e| SyncError::Transient(e.to_string()))?
            .json()
            .await
            .map_err(|e| SyncError::Transient(e.to_string()))?;

        if let Some(items) = v["value"].as_array() {
            for msg in items {
                if let Some(thread) = parse_message(account_id, msg) {
                    let _ = store.upsert_thread(&thread);
                }
            }
        }

        if let Some(delta) = v["@odata.deltaLink"].as_str() {
            let _ = store.set_sync_token(account_id, delta); // caught up
            break;
        } else if let Some(next) = v["@odata.nextLink"].as_str() {
            url = next.to_string();
            let _ = store.set_sync_token(account_id, next); // resume here next run
        } else {
            break;
        }
    }
    Ok(())
}

/// Send via Graph `sendMail` (with optional file attachments).
pub async fn send(account_id: &str, to: &str, cc: &str, bcc: &str, subject: &str, body_html: &str, attachments: &[crate::store::Attachment]) -> Result<(), SyncError> {
    let access = valid_token(account_id).await?;
    let atts: Vec<Value> = attachments
        .iter()
        .map(|a| serde_json::json!({
            "@odata.type": "#microsoft.graph.fileAttachment",
            "name": a.name,
            "contentType": a.mime,
            "contentBytes": a.data_b64,
        }))
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
pub async fn set_read(account_id: &str, conversation_id: &str, unread: bool) -> Result<(), SyncError> {
    let access = valid_token(account_id).await?;
    let client = reqwest::Client::new();
    for id in message_ids(&access, conversation_id).await? {
        let _ = client
            .patch(format!("{GRAPH}/me/messages/{id}"))
            .bearer_auth(&access)
            .json(&serde_json::json!({ "isRead": !unread }))
            .send()
            .await;
    }
    Ok(())
}

/// Move a conversation to a well-known folder ("deleteditems" for trash,
/// "archive" for archive).
pub async fn move_conversation(account_id: &str, conversation_id: &str, destination: &str) -> Result<(), SyncError> {
    let access = valid_token(account_id).await?;
    let client = reqwest::Client::new();
    for id in message_ids(&access, conversation_id).await? {
        let _ = client
            .post(format!("{GRAPH}/me/messages/{id}/move"))
            .bearer_auth(&access)
            .json(&serde_json::json!({ "destinationId": destination }))
            .send()
            .await;
    }
    Ok(())
}

/// Resolve the Graph message ids that belong to a conversation.
async fn message_ids(access: &str, conversation_id: &str) -> Result<Vec<String>, SyncError> {
    let url = format!("{GRAPH}/me/messages?$filter=conversationId eq '{conversation_id}'&$select=id&$top=50");
    let v: Value = reqwest::Client::new()
        .get(url)
        .bearer_auth(access)
        .send()
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?
        .json()
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?;
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
    let subject = msg["subject"].as_str().filter(|s| !s.is_empty()).unwrap_or("(no subject)").to_string();
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
        participants: vec![if from_name.is_empty() { from_addr.clone() } else { from_name.clone() }],
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
}
