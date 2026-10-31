//! SMTP send for plain IMAP/SMTP accounts (via `lettre`, rustls TLS).
//! Config and encrypted credentials come from the store; the OS keychain holds
//! only the credential-database master key.

use base64::{engine::general_purpose::STANDARD, Engine};
use lettre::message::header::ContentType;
use lettre::message::{Attachment as LettreAttachment, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Message, SmtpTransport, Transport};

use imap::types::Flag;
use imap::{ClientBuilder, ConnectionMode, TlsKind};

use super::{tokens, SyncError};
use crate::store::{Attachment, ImapAccount, Security, Store};

/// Send one message through the account's SMTP relay, honoring its security mode.
/// When `sent_folder` is set, a copy of the sent message is saved to that IMAP
/// folder afterwards (SMTP itself never does this).
pub fn send(account: &ImapAccount, to: &str, cc: &str, bcc: &str, subject: &str, body_html: &str, attachments: &[Attachment], sent_folder: Option<&str>) -> Result<SendOutcome, SyncError> {
    let password = tokens::secret(&account.account_id, "smtp-pass").ok_or(SyncError::AuthRequired)?;
    let email = build_message(&account.email, to, cc, bcc, subject, body_html, attachments)?;

    let creds = Credentials::new(account.smtp_username.clone(), password);
    let builder = match account.smtp_security {
        Security::Ssl => SmtpTransport::relay(&account.smtp_host).map_err(|e| SyncError::Transient(e.to_string()))?,
        Security::Starttls => SmtpTransport::starttls_relay(&account.smtp_host).map_err(|e| SyncError::Transient(e.to_string()))?,
        Security::None => SmtpTransport::builder_dangerous(&account.smtp_host),
    };
    let mailer = builder.port(account.smtp_port).credentials(creds).build();

    mailer.send(&email).map_err(|e| SyncError::Transient(e.to_string()))?;

    // SMTP only delivers to the recipient — it does NOT put a copy in the
    // account's Sent folder. Save one ourselves via IMAP APPEND so sent mail
    // shows up on the server (and thus syncs to webmail / other devices / the
    // "latest sent" view). Best-effort: the message is already delivered, so a
    // failure here is logged, never surfaced as a send failure.
    let raw = email.formatted();
    let mut sent_copy_error = None;
    if let Some(folder) = sent_folder {
        if is_gmail(account) {
            // Gmail files sent mail itself; an APPEND would create a duplicate.
        } else if let Err(e) = append_to_sent(account, folder, &raw) {
            log::warn!("mail sent but couldn't save a copy to '{folder}': {e}");
            sent_copy_error = Some(e.to_string());
        }
    }
    Ok(SendOutcome { raw, sent_copy_error })
}

/// What a successful SMTP send leaves behind for the caller: the exact bytes
/// that were delivered (to mirror into the local store) and whether the IMAP
/// Sent copy failed (surfaced to the user instead of being swallowed).
pub struct SendOutcome {
    pub raw: Vec<u8>,
    pub sent_copy_error: Option<String>,
}

fn is_gmail(account: &ImapAccount) -> bool {
    let host = account.imap_host.to_ascii_lowercase();
    host.ends_with("gmail.com") || host.ends_with("googlemail.com")
}

/// Build the exact message shared by SMTP delivery and the IMAP Sent copy.
fn build_message(from: &str, to: &str, cc: &str, bcc: &str, subject: &str, body_html: &str, attachments: &[Attachment]) -> Result<Message, SyncError> {
    let mut builder = Message::builder()
        .from(from.parse().map_err(|_| SyncError::Permanent("bad from address".into()))?)
        .subject(subject)
        // lettre adds Date automatically, but Message-ID must be requested.
        .message_id(None);
    // `To` is a comma-separated list ("a@x, Name <b@y>") exactly like Cc/Bcc.
    // It used to be parsed as ONE mailbox, which silently lost every email
    // addressed to two or more people.
    let to_list: lettre::message::Mailboxes = to
        .parse()
        .map_err(|_| SyncError::Permanent(format!("bad to address: {to}")))?;
    let mut any_to = false;
    for mb in to_list.into_iter() {
        builder = builder.to(mb);
        any_to = true;
    }
    if !any_to {
        return Err(SyncError::Permanent("no recipient".into()));
    }
    // Cc/Bcc may each be a comma-separated list; add every valid mailbox.
    for addr in cc.split(',').map(str::trim).filter(|a| !a.is_empty()) {
        builder = builder.cc(addr.parse().map_err(|_| SyncError::Permanent(format!("bad cc address: {addr}")))?);
    }
    for addr in bcc.split(',').map(str::trim).filter(|a| !a.is_empty()) {
        builder = builder.bcc(addr.parse().map_err(|_| SyncError::Permanent(format!("bad bcc address: {addr}")))?);
    }

    if attachments.is_empty() {
        builder
            // The MIME builder declares MIME-Version as well as Content-Type.
            .singlepart(SinglePart::html(body_html.to_string()))
            .map_err(|e| SyncError::Transient(e.to_string()))
    } else {
        let mut mp = MultiPart::mixed().singlepart(SinglePart::html(body_html.to_string()));
        for a in attachments {
            let bytes = STANDARD.decode(&a.data_b64).map_err(|e| SyncError::Transient(e.to_string()))?;
            let ct = ContentType::parse(&a.mime).unwrap_or(ContentType::parse("application/octet-stream").unwrap());
            mp = mp.singlepart(LettreAttachment::new(a.name.clone()).body(bytes, ct));
        }
        builder.multipart(mp).map_err(|e| SyncError::Transient(e.to_string()))
    }
}

/// Save an already-sent message into the account's Sent folder via IMAP APPEND,
/// flagged `\Seen`. Without this, mail sent over SMTP never appears on the
/// server, so it won't sync to webmail or other devices.
fn append_to_sent(account: &ImapAccount, sent_folder: &str, raw: &[u8]) -> Result<(), SyncError> {
    let password = tokens::secret(&account.account_id, "imap-pass")
        .filter(|p| !p.is_empty())
        .ok_or(SyncError::AuthRequired)?;
    let mode = match account.imap_security {
        Security::Ssl => ConnectionMode::Tls,
        Security::Starttls => ConnectionMode::StartTls,
        Security::None => ConnectionMode::Plaintext,
    };
    let client = ClientBuilder::new(account.imap_host.clone(), account.imap_port)
        .tls_kind(TlsKind::Rust)
        .mode(mode)
        .connect()
        .map_err(|e| SyncError::Transient(format!("imap connect for Sent copy failed — {e}")))?;
    let mut session = client
        .login(&account.imap_username, &password)
        .map_err(|(e, _)| SyncError::Transient(format!("imap login for Sent copy failed — {e}")))?;
    let result = session
        .append(sent_folder, raw)
        .flag(Flag::Seen)
        .finish()
        .map(|_| ())
        .map_err(|e| SyncError::Transient(format!("IMAP APPEND to '{sent_folder}' failed — {e}")));
    let _ = session.logout();
    result
}

/// Test SMTP connectivity (handshake + greeting) without sending a message.
pub fn test_conn(host: &str, port: u16, security: Security) -> Result<(), SyncError> {
    let builder = match security {
        Security::Ssl => SmtpTransport::relay(host).map_err(|e| SyncError::Transient(e.to_string()))?,
        Security::Starttls => SmtpTransport::starttls_relay(host).map_err(|e| SyncError::Transient(e.to_string()))?,
        Security::None => SmtpTransport::builder_dangerous(host),
    };
    let mailer = builder.port(port).build();
    log::info!("SMTP test: connecting to {host}:{port} (security={security:?})");
    match mailer.test_connection() {
        Ok(true) => {
            log::info!("SMTP test: server reachable at {host}:{port}");
            Ok(())
        }
        Ok(false) => {
            log::error!("SMTP test: {host}:{port} not reachable");
            Err(SyncError::Transient("SMTP server not reachable".into()))
        }
        Err(e) => {
            log::error!("SMTP connect to {host}:{port} failed: {e}");
            Err(SyncError::Transient(format!("SMTP connect failed: {e}")))
        }
    }
}

/// Async wrapper: lettre's `SmtpTransport` is blocking, so run it off the async runtime.
pub async fn send_async(account: ImapAccount, to: String, cc: String, bcc: String, subject: String, body_html: String, attachments: Vec<Attachment>, sent_folder: Option<String>) -> Result<SendOutcome, SyncError> {
    tokio::task::spawn_blocking(move || send(&account, &to, &cc, &bcc, &subject, &body_html, &attachments, sent_folder.as_deref()))
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?
}

/// Resolve the account config from the store and send.
pub async fn send_for(store: &Store, account_id: &str, to: &str, cc: &str, bcc: &str, subject: &str, body_html: &str, attachments: &[Attachment]) -> Result<(), SyncError> {
    let account = store.imap_account(account_id).ok_or(SyncError::AuthRequired)?;
    // Resolve the server's Sent folder for the sent copy: prefer the special-use
    // role, else any folder whose name looks like "Sent". None → skip the copy
    // (e.g. folders not listed yet); the send itself still succeeds.
    let folders = store.folders(account_id);
    // Where the sent copy goes, most authoritative first:
    //  1. the user's explicit override (Settings → account → Sent folder),
    //  2. the folder the SERVER flagged \\Sent (RFC 6154 SPECIAL-USE),
    //  3. a folder whose "sent" role we inferred from its name,
    //  4. any folder whose name contains "sent".
    // Servers commonly expose two sent-like folders (e.g. "INBOX.Sent" and
    // "INBOX.Sent Messages"); only (1)/(2) reliably pick the one the user uses.
    let sent_folder = account
        .sent_folder
        .clone()
        .filter(|f| !f.trim().is_empty())
        .or_else(|| folders.iter().find(|f| f.special_use && f.role.as_deref() == Some("sent")).map(|f| f.name.clone()))
        .or_else(|| folders.iter().find(|f| f.role.as_deref() == Some("sent")).map(|f| f.name.clone()))
        .or_else(|| folders.iter().find(|f| f.name.to_ascii_lowercase().contains("sent")).map(|f| f.name.clone()));
    let group = store.setting("group").ok().flatten().map(|v| v != "0").unwrap_or(true);
    let outcome = send_async(account, to.to_string(), cc.to_string(), bcc.to_string(), subject.to_string(), body_html.to_string(), attachments.to_vec(), sent_folder.clone()).await?;
    // Per-account send warning the UI shows (cleared on a clean send).
    let warn_key = format!("send_warning:{account_id}");
    match (&sent_folder, &outcome.sent_copy_error) {
        (Some(folder), None) => {
            // Mirror the copy locally right away so it appears in Sent without a sync.
            match crate::sync::imap::parse_rfc822(account_id, &outcome.raw, false, group, folder) {
                Ok(thread) => {
                    if let Err(e) = store.upsert_thread(&thread) {
                        log::warn!("sent copy saved on the server but not locally: {e}");
                    }
                }
                Err(e) => log::warn!("could not parse our own sent message for the local copy: {e}"),
            }
            let _ = store.set_setting(&warn_key, "");
        }
        (Some(folder), Some(err)) => {
            let _ = store.set_setting(&warn_key, &format!("Sent, but the copy to “{folder}” failed: {err}"));
        }
        (None, _) => {
            let _ = store.set_setting(&warn_key, "Sent, but no Sent folder is known for this account — pick one under Settings → Accounts.");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mailparse::MailHeaderMap;

    const HTML: &str = "<p>Grüße — message body</p>";

    fn attachment() -> Attachment {
        Attachment {
            name: "report.bin".into(),
            mime: "application/octet-stream".into(),
            data_b64: STANDARD.encode([0, 1, 2, 128, 255]),
        }
    }

    fn message(attachments: &[Attachment]) -> Message {
        build_message(
            "sender@example.com", "recipient@example.net", "", "",
            "Header regression", HTML, attachments,
        ).expect("valid message")
    }

    fn header(message: &Message, name: &str) -> Option<String> {
        mailparse::parse_mail(&message.formatted()).unwrap().headers.get_first_value(name)
    }

    fn assert_message_id(message: &Message) {
        let id = header(message, "Message-ID").expect("outgoing message needs Message-ID");
        assert!(id.starts_with('<') && id.ends_with('>') && id.contains('@'), "invalid Message-ID: {id}");
    }

    #[test]
    fn html_message_has_message_id() {
        assert_message_id(&message(&[]));
    }

    #[test]
    fn attachment_message_has_message_id() {
        assert_message_id(&message(&[attachment()]));
    }

    #[test]
    fn html_message_declares_mime_version() {
        assert_eq!(header(&message(&[]), "MIME-Version").as_deref(), Some("1.0"));
    }

    #[test]
    fn attachment_message_declares_mime_version() {
        assert_eq!(header(&message(&[attachment()]), "MIME-Version").as_deref(), Some("1.0"));
    }

    #[test]
    fn separately_built_messages_have_distinct_ids() {
        let first = header(&message(&[]), "Message-ID").expect("first ID");
        let second = header(&message(&[]), "Message-ID").expect("second ID");
        assert_ne!(first, second);
    }

    #[test]
    fn smtp_and_sent_serialization_remain_identical() {
        for attachments in [vec![], vec![attachment()]] {
            let email = message(&attachments);
            assert_eq!(email.formatted(), email.formatted());
            assert_message_id(&email);
        }
    }

    #[test]
    fn html_body_round_trips_with_utf8() {
        let raw = message(&[]).formatted();
        let parsed = mailparse::parse_mail(&raw).unwrap();
        assert_eq!(parsed.ctype.mimetype, "text/html");
        assert_eq!(parsed.ctype.charset.to_ascii_lowercase(), "utf-8");
        assert_eq!(parsed.get_body().unwrap().trim_end(), HTML);
    }

    #[test]
    fn attachment_message_preserves_html_and_binary_payload() {
        let raw = message(&[attachment()]).formatted();
        let parsed = mailparse::parse_mail(&raw).unwrap();
        assert_eq!(parsed.ctype.mimetype, "multipart/mixed");
        assert_eq!(parsed.subparts.len(), 2);
        assert_eq!(parsed.subparts[0].ctype.mimetype, "text/html");
        assert_eq!(parsed.subparts[0].get_body().unwrap().trim_end(), HTML);
        assert_eq!(parsed.subparts[1].get_body_raw().unwrap(), [0, 1, 2, 128, 255]);
        assert_eq!(parsed.subparts[1].get_content_disposition().params.get("filename").map(String::as_str), Some("report.bin"));
    }

    #[test]
    fn to_accepts_a_comma_separated_recipient_list() {
        // Regression: real emails were dead-lettered with "bad to address" because a
        // multi-recipient To was parsed as a single mailbox.
        let msg = build_message("me@example.de", "a@example.de, Name <b@example.org>", "", "", "s", "<p>hi</p>", &[])
            .expect("two recipients must build");
        let to = header(&msg, "To").expect("To header");
        assert!(to.contains("a@example.de"), "To was: {to}");
        assert!(to.contains("b@example.org"), "To was: {to}");
    }

    #[test]
    fn malformed_to_is_a_permanent_error() {
        let err = build_message("me@example.de", "not an address", "", "", "s", "<p>hi</p>", &[])
            .err()
            .expect("malformed To must fail");
        assert!(err.is_permanent(), "got {err}");
    }

    #[test]
    fn cc_and_bcc_recipients_stay_in_envelope_bcc_stays_private() {
        let email = build_message(
            "sender@example.com", "recipient@example.net",
            "copy@example.net, copy2@example.net", "hidden@example.org, hidden2@example.org",
            "Recipients", HTML, &[],
        ).unwrap();
        let recipients: Vec<_> = email.envelope().to().iter().map(ToString::to_string).collect();
        assert_eq!(recipients, ["recipient@example.net", "copy@example.net", "copy2@example.net", "hidden@example.org", "hidden2@example.org"]);
        assert!(header(&email, "Cc").unwrap().contains("copy2@example.net"));
        assert_eq!(header(&email, "Bcc"), None);
        assert!(!String::from_utf8(email.formatted()).unwrap().contains("hidden@example.org"));
    }
}
