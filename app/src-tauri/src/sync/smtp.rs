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
pub fn send(account: &ImapAccount, to: &str, cc: &str, bcc: &str, subject: &str, body_html: &str, attachments: &[Attachment], sent_folder: Option<&str>) -> Result<(), SyncError> {
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
    if let Some(folder) = sent_folder {
        let raw = email.formatted();
        if let Err(e) = append_to_sent(account, folder, &raw) {
            log::warn!("mail sent but couldn't save a copy to '{folder}': {e}");
        }
    }
    Ok(())
}

/// Build the exact message shared by SMTP delivery and the IMAP Sent copy.
fn build_message(from: &str, to: &str, cc: &str, bcc: &str, subject: &str, body_html: &str, attachments: &[Attachment]) -> Result<Message, SyncError> {
    let mut builder = Message::builder()
        .from(from.parse().map_err(|_| SyncError::Transient("bad from address".into()))?)
        .to(to.parse().map_err(|_| SyncError::Transient("bad to address".into()))?)
        .subject(subject)
        // lettre adds Date automatically, but Message-ID must be requested.
        .message_id(None);
    // Cc/Bcc may each be a comma-separated list; add every valid mailbox.
    for addr in cc.split(',').map(str::trim).filter(|a| !a.is_empty()) {
        builder = builder.cc(addr.parse().map_err(|_| SyncError::Transient(format!("bad cc address: {addr}")))?);
    }
    for addr in bcc.split(',').map(str::trim).filter(|a| !a.is_empty()) {
        builder = builder.bcc(addr.parse().map_err(|_| SyncError::Transient(format!("bad bcc address: {addr}")))?);
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
pub async fn send_async(account: ImapAccount, to: String, cc: String, bcc: String, subject: String, body_html: String, attachments: Vec<Attachment>, sent_folder: Option<String>) -> Result<(), SyncError> {
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
    let sent_folder = folders
        .iter()
        .find(|f| f.role.as_deref() == Some("sent"))
        .or_else(|| folders.iter().find(|f| f.name.to_ascii_lowercase().contains("sent")))
        .map(|f| f.name.clone());
    send_async(account, to.to_string(), cc.to_string(), bcc.to_string(), subject.to_string(), body_html.to_string(), attachments.to_vec(), sent_folder).await
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
