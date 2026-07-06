//! SMTP send for plain IMAP/SMTP accounts (via `lettre`, rustls TLS).
//! Config comes from the store; the password from the OS keychain.

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

    let mut builder = Message::builder()
        .from(account.email.parse().map_err(|_| SyncError::Transient("bad from address".into()))?)
        .to(to.parse().map_err(|_| SyncError::Transient("bad to address".into()))?)
        .subject(subject);
    // Cc/Bcc may each be a comma-separated list; add every valid mailbox.
    for addr in cc.split(',').map(str::trim).filter(|a| !a.is_empty()) {
        builder = builder.cc(addr.parse().map_err(|_| SyncError::Transient(format!("bad cc address: {addr}")))?);
    }
    for addr in bcc.split(',').map(str::trim).filter(|a| !a.is_empty()) {
        builder = builder.bcc(addr.parse().map_err(|_| SyncError::Transient(format!("bad bcc address: {addr}")))?);
    }

    let email = if attachments.is_empty() {
        builder
            .header(ContentType::TEXT_HTML)
            .body(body_html.to_string())
            .map_err(|e| SyncError::Transient(e.to_string()))?
    } else {
        let mut mp = MultiPart::mixed().singlepart(SinglePart::html(body_html.to_string()));
        for a in attachments {
            let bytes = STANDARD.decode(&a.data_b64).map_err(|e| SyncError::Transient(e.to_string()))?;
            let ct = ContentType::parse(&a.mime).unwrap_or(ContentType::parse("application/octet-stream").unwrap());
            mp = mp.singlepart(LettreAttachment::new(a.name.clone()).body(bytes, ct));
        }
        builder.multipart(mp).map_err(|e| SyncError::Transient(e.to_string()))?
    };

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
