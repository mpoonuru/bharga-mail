//! IMAP inbox fetch (rustls TLS) for plain IMAP/SMTP accounts. Pulls recent
//! messages and parses them into the store. Sending is handled by `smtp.rs`.

use imap::{ClientBuilder, ConnectionMode, TlsKind};
use mailparse::MailHeaderMap;

use super::{tokens, SyncError};
use crate::store::{Message, MessageMeta, Party, Security, Store, Thread};

/// Connect, select INBOX, fetch the most recent messages, persist them.
/// Runs blocking IMAP I/O; call via [`fetch_inbox_async`] from async code.
pub fn fetch_inbox(store: &Store, account_id: &str, limit: u32, group: bool) -> Result<usize, SyncError> {
    let acct = store
        .imap_account(account_id)
        .ok_or_else(|| SyncError::Transient(format!("no saved IMAP settings for {account_id} — re-add the account")))?;
    let password = tokens::secret(account_id, "imap-pass")
        .filter(|p| !p.is_empty())
        .ok_or_else(|| SyncError::Transient(format!("no saved password for {} — re-add the account", acct.email)))?;
    let mode = match acct.imap_security {
        Security::Ssl => ConnectionMode::Tls,
        Security::Starttls => ConnectionMode::StartTls,
        Security::None => ConnectionMode::Plaintext,
    };

    log::info!("imap: syncing {} via {}:{} ({:?})", acct.email, acct.imap_host, acct.imap_port, acct.imap_security);
    let client = ClientBuilder::new(acct.imap_host.clone(), acct.imap_port)
        .tls_kind(TlsKind::Rust)
        .mode(mode)
        .connect()
        .map_err(|e| {
            log::error!("imap connect to {}:{} failed: {e}", acct.imap_host, acct.imap_port);
            SyncError::Transient(format!("can't reach {}:{} — {e}", acct.imap_host, acct.imap_port))
        })?;
    let mut session = client
        .login(&acct.imap_username, &password)
        .map_err(|(e, _)| {
            log::error!("imap login for {} (user {}) failed: {e}", acct.email, acct.imap_username);
            SyncError::Transient(format!("login failed for {} — check the username/password — {e}", acct.imap_username))
        })?;

    let mailbox = session
        .select("INBOX")
        .map_err(|e| SyncError::Transient(format!("couldn't open INBOX for {} — {e}", acct.email)))?;
    let total = mailbox.exists;
    if total == 0 {
        let _ = session.logout();
        return Ok(0);
    }
    let start = total.saturating_sub(limit).saturating_add(1).max(1);
    let seq = format!("{start}:{total}");

    let fetches = session
        .fetch(seq, "(FLAGS BODY[])")
        .map_err(|e| SyncError::Transient(e.to_string()))?;

    let mut n = 0;
    let mut errors = 0;
    for f in fetches.iter() {
        let unread = !f.flags().iter().any(|fl| matches!(fl, imap::types::Flag::Seen));
        if let Some(raw) = f.body() {
            if let Some(thread) = parse_rfc822(account_id, raw, unread, group) {
                // Count only messages that actually persisted, and surface failures
                // (a silently-swallowed upsert error was hiding emails before).
                match store.upsert_thread(&thread) {
                    Ok(()) => n += 1,
                    Err(e) => {
                        errors += 1;
                        log::error!("imap: failed to store message: {e}");
                    }
                }
            }
        }
    }
    let _ = session.logout();
    log::info!("imap: stored {n} messages ({errors} failed) from INBOX");
    if n == 0 && errors > 0 {
        return Err(SyncError::Transient(format!("fetched mail but {errors} messages failed to save")));
    }
    Ok(n)
}

/// Fetch a single attachment's decoded bytes by Message-ID + filename. IMAP has
/// no stored UID yet, so we SEARCH the INBOX by the Message-ID header, re-fetch
/// the full message, and extract the named part.
pub fn fetch_attachment(store: &Store, account_id: &str, message_id: &str, filename: &str) -> Result<Vec<u8>, SyncError> {
    let acct = store.imap_account(account_id).ok_or(SyncError::AuthRequired)?;
    let password = tokens::secret(account_id, "imap-pass").ok_or(SyncError::AuthRequired)?;
    let mode = match acct.imap_security {
        Security::Ssl => ConnectionMode::Tls,
        Security::Starttls => ConnectionMode::StartTls,
        Security::None => ConnectionMode::Plaintext,
    };
    let client = ClientBuilder::new(acct.imap_host.clone(), acct.imap_port)
        .tls_kind(TlsKind::Rust)
        .mode(mode)
        .connect()
        .map_err(|e| SyncError::Transient(e.to_string()))?;
    let mut session = client
        .login(&acct.imap_username, &password)
        .map_err(|(e, _)| SyncError::Transient(e.to_string()))?;
    session.select("INBOX").map_err(|e| SyncError::Transient(e.to_string()))?;

    let query = format!("HEADER Message-ID \"{message_id}\"");
    let seqs = session.search(query).map_err(|e| SyncError::Transient(e.to_string()))?;
    let seq = seqs.into_iter().next().ok_or_else(|| SyncError::Transient("message not found on server".into()))?;

    let raw = {
        let fetches = session.fetch(seq.to_string(), "BODY[]").map_err(|e| SyncError::Transient(e.to_string()))?;
        fetches
            .iter()
            .next()
            .and_then(|f| f.body())
            .ok_or_else(|| SyncError::Transient("empty message body".into()))?
            .to_vec()
    };
    let _ = session.logout();

    let mail = mailparse::parse_mail(&raw).map_err(|e| SyncError::Transient(e.to_string()))?;
    extract_attachment_bytes(&mail, filename).ok_or_else(|| SyncError::Transient(format!("attachment '{filename}' not found")))
}

/// Find a named attachment in the MIME tree and return its transfer-decoded bytes.
fn extract_attachment_bytes(mail: &mailparse::ParsedMail, filename: &str) -> Option<Vec<u8>> {
    let cd = mail.get_content_disposition();
    if matches!(cd.disposition, mailparse::DispositionType::Attachment) {
        let name = cd.params.get("filename").map(String::as_str).unwrap_or("attachment");
        if name == filename {
            return mail.get_body_raw().ok();
        }
    }
    for p in &mail.subparts {
        if let Some(b) = extract_attachment_bytes(p, filename) {
            return Some(b);
        }
    }
    None
}

pub async fn fetch_attachment_async(store: std::sync::Arc<Store>, account_id: String, message_id: String, filename: String) -> Result<Vec<u8>, SyncError> {
    tokio::task::spawn_blocking(move || fetch_attachment(&store, &account_id, &message_id, &filename))
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?
}

/// Test IMAP credentials without saving: connect, login, logout.
pub fn test_login(host: &str, port: u16, security: Security, user: &str, pass: &str) -> Result<(), SyncError> {
    let mode = match security {
        Security::Ssl => ConnectionMode::Tls,
        Security::Starttls => ConnectionMode::StartTls,
        Security::None => ConnectionMode::Plaintext,
    };
    log::info!("IMAP test: connecting to {host}:{port} (security={security:?})");
    let client = ClientBuilder::new(host.to_string(), port)
        .tls_kind(TlsKind::Rust)
        .mode(mode)
        .connect()
        .map_err(|e| {
            log::error!("IMAP connect to {host}:{port} failed: {e}");
            SyncError::Transient(format!("IMAP connect failed: {e}"))
        })?;
    log::info!("IMAP test: connected, logging in as {user}");
    let mut session = client.login(user, pass).map_err(|(e, _)| {
        log::error!("IMAP login for {user} failed: {e}");
        SyncError::Transient(format!("IMAP login failed: {e}"))
    })?;
    log::info!("IMAP test: login OK for {user}");
    let _ = session.logout();
    Ok(())
}

pub async fn fetch_inbox_async(store: std::sync::Arc<Store>, account_id: String, limit: u32, group: bool) -> Result<usize, SyncError> {
    tokio::task::spawn_blocking(move || fetch_inbox(&store, &account_id, limit, group))
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?
}

/// Parse a raw RFC822 message into a store Thread (one message per thread,
/// keyed by Message-ID). Pure + unit-tested.
fn parse_rfc822(account_id: &str, raw: &[u8], unread: bool, group: bool) -> Option<Thread> {
    let mail = mailparse::parse_mail(raw).ok()?;
    let h = |name: &str| mail.headers.get_first_value(name);

    let subject = h("Subject").filter(|s| !s.is_empty()).unwrap_or_else(|| "(no subject)".into());
    let from_raw = h("From").unwrap_or_default();
    let (from_name, from_addr) = split_addr(&from_raw);
    let when = h("Date").unwrap_or_default();
    let msg_id = h("Message-ID").filter(|s| !s.is_empty()).unwrap_or_else(|| format!("imapmsg-{}", subject.len()));

    // When grouping is on, the thread is keyed by the conversation root — the
    // first id in References, else In-Reply-To, else this message itself — so
    // replies land in the same thread. When off, every message is its own thread.
    let thread_id = if group {
        h("References")
            .and_then(|r| r.split_whitespace().next().map(str::to_string))
            .or_else(|| h("In-Reply-To").and_then(|r| r.split_whitespace().next().map(str::to_string)))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| msg_id.clone())
    } else {
        msg_id.clone()
    };

    // Provenance: recipients, originating IP (from the earliest Received hop),
    // and SPF/DKIM/DMARC results — surfaced in the message Details panel.
    let to = parse_addrs(&h("To").unwrap_or_default());
    let auth = parse_auth(&mail.headers.get_all_values("Authentication-Results").join(" "));
    let meta = MessageMeta {
        cc: parse_addrs(&h("Cc").unwrap_or_default()),
        reply_to: h("Reply-To").filter(|s| !s.is_empty()),
        message_id: Some(msg_id.clone()),
        origin_ip: origin_ip(&mail.headers.get_all_values("Received")),
        auth: if auth.is_empty() { None } else { Some(auth) },
    };

    // Inline images embedded in the message (Content-ID parts referenced as
    // `cid:...` in the HTML) become data: URIs so they actually render.
    let body_html = inline_cid_images(&mail, extract_html(&mail).unwrap_or_default());
    let preview = {
        let text = crate::store::strip_html(&body_html);
        text.chars().take(140).collect::<String>()
    };

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
        ai_summary: None,
        ai_draft: None,
        messages: vec![Message {
            id: msg_id,
            from: Party { name: from_name, address: from_addr },
            to,
            when,
            body_html,
            attachments: imap_attachments(&mail),
            meta: Some(meta),
        }],
    })
}

/// Parse a comma-separated address header into parties.
fn parse_addrs(raw: &str) -> Vec<Party> {
    raw.split(',')
        .filter_map(|a| {
            let a = a.trim();
            if a.is_empty() {
                return None;
            }
            let (name, address) = split_addr(a);
            Some(Party { name, address })
        })
        .collect()
}

/// The originating client IP: scan Received hops from earliest (last) to latest
/// for a bracketed/parenthesised IP literal.
fn origin_ip(received: &[String]) -> Option<String> {
    received.iter().rev().find_map(|r| find_ip(r))
}

fn find_ip(s: &str) -> Option<String> {
    for (open, close) in [('[', ']'), ('(', ')')] {
        let mut start: Option<usize> = None;
        for (i, c) in s.char_indices() {
            if c == open {
                start = Some(i + 1);
            } else if c == close {
                if let Some(st) = start {
                    let cand = s[st..i].trim();
                    if looks_like_ip(cand) {
                        return Some(cand.to_string());
                    }
                    start = None;
                }
            }
        }
    }
    None
}

fn looks_like_ip(s: &str) -> bool {
    let s = s.trim_start_matches("IPv6:");
    if s.split('.').count() == 4 && s.split('.').all(|o| o.parse::<u8>().is_ok()) {
        return true;
    }
    s.contains(':') && s.len() >= 3 && s.chars().all(|c| c.is_ascii_hexdigit() || c == ':')
}

/// Extract a compact SPF/DKIM/DMARC summary from Authentication-Results.
fn parse_auth(s: &str) -> String {
    let lower = s.to_lowercase();
    let mut parts = Vec::new();
    for key in ["spf", "dkim", "dmarc"] {
        if let Some(pos) = lower.find(&format!("{key}=")) {
            let rest = &lower[pos + key.len() + 1..];
            let val: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
            if !val.is_empty() {
                parts.push(format!("{key}={val}"));
            }
        }
    }
    parts.join("; ")
}

/// Replace `cid:` references to embedded images with self-contained data: URIs,
/// so inline images render without any network access.
fn inline_cid_images(mail: &mailparse::ParsedMail, html: String) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    fn collect(part: &mailparse::ParsedMail, out: &mut Vec<(String, String, Vec<u8>)>) {
        if part.ctype.mimetype.starts_with("image/") {
            if let Some(cid) = part.headers.get_first_value("Content-ID") {
                let id = cid.trim().trim_start_matches('<').trim_end_matches('>').to_string();
                if !id.is_empty() {
                    if let Ok(bytes) = part.get_body_raw() {
                        out.push((id, part.ctype.mimetype.clone(), bytes));
                    }
                }
            }
        }
        for p in &part.subparts {
            collect(p, out);
        }
    }
    let mut images = Vec::new();
    collect(mail, &mut images);
    if images.is_empty() {
        return html;
    }
    let mut out = html;
    for (cid, mime, bytes) in images {
        let data = format!("data:{};base64,{}", mime, STANDARD.encode(&bytes));
        out = out.replace(&format!("cid:{cid}"), &data);
    }
    out
}

/// Walk the MIME tree for text/html (preferred) or text/plain.
fn extract_html(mail: &mailparse::ParsedMail) -> Option<String> {
    if mail.ctype.mimetype == "text/html" {
        return mail.get_body().ok();
    }
    if mail.ctype.mimetype == "text/plain" && mail.subparts.is_empty() {
        return mail.get_body().ok().map(|t| format!("<p>{}</p>", t.replace('\n', "<br>")));
    }
    for part in &mail.subparts {
        if let Some(html) = extract_html(part) {
            return Some(html);
        }
    }
    None
}

/// Collect attachment metadata from MIME parts marked `Content-Disposition: attachment`.
fn imap_attachments(mail: &mailparse::ParsedMail) -> Vec<crate::store::AttachmentMeta> {
    let mut out = Vec::new();
    fn walk(part: &mailparse::ParsedMail, out: &mut Vec<crate::store::AttachmentMeta>) {
        let cd = part.get_content_disposition();
        if matches!(cd.disposition, mailparse::DispositionType::Attachment) {
            let name = cd.params.get("filename").cloned().unwrap_or_else(|| "attachment".to_string());
            let size = part.get_body_raw().map(|b| b.len() as u64).unwrap_or(0);
            out.push(crate::store::AttachmentMeta { name, mime: part.ctype.mimetype.clone(), size });
        }
        for p in &part.subparts {
            walk(p, out);
        }
    }
    walk(mail, &mut out);
    out
}

fn split_addr(raw: &str) -> (String, String) {
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
    fn parses_plain_and_html() {
        let raw = b"Subject: Hello\r\nFrom: Sam <sam@x.io>\r\nDate: Fri, 29 May 2026 10:00:00 +0000\r\nMessage-ID: <abc@x.io>\r\nContent-Type: text/html\r\n\r\n<p>Hi there</p>";
        let t = parse_rfc822("imap:me", raw, true, true).unwrap();
        assert_eq!(t.subject, "Hello");
        assert_eq!(t.id, "<abc@x.io>");
        assert_eq!(t.messages[0].from.address, "sam@x.io");
        assert!(t.unread);
        assert!(t.messages[0].body_html.contains("Hi there"));
    }

    #[test]
    fn extracts_attachment_metadata() {
        let raw = b"Subject: Doc\r\nFrom: A <a@b.c>\r\nContent-Type: multipart/mixed; boundary=\"bnd\"\r\n\r\n--bnd\r\nContent-Type: text/html\r\n\r\n<p>see attached</p>\r\n--bnd\r\nContent-Type: application/pdf; name=\"report.pdf\"\r\nContent-Disposition: attachment; filename=\"report.pdf\"\r\n\r\nPDFDATA\r\n--bnd--";
        let t = parse_rfc822("imap:me", raw, false, true).unwrap();
        assert_eq!(t.messages[0].attachments.len(), 1);
        assert_eq!(t.messages[0].attachments[0].name, "report.pdf");
        assert_eq!(t.messages[0].attachments[0].mime, "application/pdf");
    }

    #[test]
    fn captures_provenance() {
        let raw = b"Subject: Hi\r\nFrom: A <a@b.c>\r\nTo: Me <me@x.de>\r\nCc: C <c@y.de>\r\nReceived: from mail.x.de (mail.x.de [203.0.113.7]) by mx.x.de\r\nAuthentication-Results: mx.x.de; spf=pass; dkim=pass; dmarc=pass\r\nMessage-ID: <m1@x.de>\r\nContent-Type: text/html\r\n\r\n<p>hi</p>";
        let t = parse_rfc822("imap:me", raw, false, true).unwrap();
        let m = &t.messages[0];
        assert_eq!(m.to[0].address, "me@x.de");
        let meta = m.meta.as_ref().unwrap();
        assert_eq!(meta.cc[0].address, "c@y.de");
        assert_eq!(meta.origin_ip.as_deref(), Some("203.0.113.7"));
        assert_eq!(meta.auth.as_deref(), Some("spf=pass; dkim=pass; dmarc=pass"));
    }

    #[test]
    fn inlines_cid_images() {
        // multipart/related: an HTML part referencing cid:img1 + the image part.
        let raw = b"Subject: Pic\r\nFrom: A <a@b.c>\r\nContent-Type: multipart/related; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/html\r\n\r\n<p><img src=\"cid:img1\"></p>\r\n--b\r\nContent-Type: image/png\r\nContent-ID: <img1>\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8=\r\n--b--";
        let t = parse_rfc822("imap:me", raw, false, true).unwrap();
        let html = &t.messages[0].body_html;
        assert!(html.contains("data:image/png;base64,SGVsbG8="), "cid should be inlined: {html}");
        assert!(!html.contains("cid:img1"), "raw cid ref should be gone");
    }

    #[test]
    fn extracts_attachment_bytes_base64() {
        // "Hello" base64 = SGVsbG8=
        let raw = b"Subject: D\r\nFrom: A <a@b.c>\r\nContent-Type: multipart/mixed; boundary=\"bnd\"\r\n\r\n--bnd\r\nContent-Type: text/html\r\n\r\n<p>x</p>\r\n--bnd\r\nContent-Type: application/octet-stream; name=\"f.bin\"\r\nContent-Disposition: attachment; filename=\"f.bin\"\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8=\r\n--bnd--";
        let mail = mailparse::parse_mail(raw).unwrap();
        let bytes = extract_attachment_bytes(&mail, "f.bin").unwrap();
        assert_eq!(bytes, b"Hello");
        assert!(extract_attachment_bytes(&mail, "missing.bin").is_none());
    }
}
