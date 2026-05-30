//! SMTP send for plain IMAP/SMTP accounts (via `lettre`, rustls TLS).
//! Config comes from the store; the password from the OS keychain.

use base64::{engine::general_purpose::STANDARD, Engine};
use lettre::message::header::ContentType;
use lettre::message::{Attachment as LettreAttachment, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Message, SmtpTransport, Transport};

use super::{tokens, SyncError};
use crate::store::{Attachment, ImapAccount, Security, Store};

/// Send one message through the account's SMTP relay, honoring its security mode.
pub fn send(account: &ImapAccount, to: &str, subject: &str, body_html: &str, attachments: &[Attachment]) -> Result<(), SyncError> {
    let password = tokens::secret(&account.account_id, "smtp-pass").ok_or(SyncError::AuthRequired)?;

    let builder = Message::builder()
        .from(account.email.parse().map_err(|_| SyncError::Transient("bad from address".into()))?)
        .to(to.parse().map_err(|_| SyncError::Transient("bad to address".into()))?)
        .subject(subject);

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
    Ok(())
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
pub async fn send_async(account: ImapAccount, to: String, subject: String, body_html: String, attachments: Vec<Attachment>) -> Result<(), SyncError> {
    tokio::task::spawn_blocking(move || send(&account, &to, &subject, &body_html, &attachments))
        .await
        .map_err(|e| SyncError::Transient(e.to_string()))?
}

/// Resolve the account config from the store and send.
pub async fn send_for(store: &Store, account_id: &str, to: &str, subject: &str, body_html: &str, attachments: &[Attachment]) -> Result<(), SyncError> {
    let account = store.imap_account(account_id).ok_or(SyncError::AuthRequired)?;
    send_async(account, to.to_string(), subject.to_string(), body_html.to_string(), attachments.to_vec()).await
}
