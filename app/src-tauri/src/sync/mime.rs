//! Minimal RFC 822 / MIME assembly for outgoing mail. Plain HTML body, plus
//! multipart/mixed when there are attachments. base64url-encoded for Gmail's
//! `messages.send`.

use base64::{engine::general_purpose::URL_SAFE, Engine};

use crate::store::Attachment;

/// Build a raw RFC822 message (with attachments if any) and base64url-encode it.
/// `cc`/`bcc` are comma-separated address lists (empty string = omit the header).
/// Gmail honours a `Bcc:` header and strips it from the delivered copy.
pub fn build_raw(from: &str, to: &str, cc: &str, bcc: &str, subject: &str, body_html: &str, attachments: &[Attachment]) -> String {
    let cc_hdr = if cc.trim().is_empty() { String::new() } else { format!("Cc: {cc}\r\n") };
    let bcc_hdr = if bcc.trim().is_empty() { String::new() } else { format!("Bcc: {bcc}\r\n") };
    let raw = if attachments.is_empty() {
        format!(
            "From: {from}\r\nTo: {to}\r\n{cc_hdr}{bcc_hdr}Subject: {subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n{body_html}"
        )
    } else {
        let boundary = "aether_boundary_b7f3c2";
        let mut s = format!(
            "From: {from}\r\nTo: {to}\r\n{cc_hdr}{bcc_hdr}Subject: {subject}\r\nMIME-Version: 1.0\r\n\
             Content-Type: multipart/mixed; boundary=\"{boundary}\"\r\n\r\n"
        );
        // body part
        s.push_str(&format!("--{boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n{body_html}\r\n"));
        // attachment parts
        for a in attachments {
            s.push_str(&format!(
                "--{boundary}\r\nContent-Type: {mime}; name=\"{name}\"\r\n\
                 Content-Disposition: attachment; filename=\"{name}\"\r\n\
                 Content-Transfer-Encoding: base64\r\n\r\n{data}\r\n",
                mime = a.mime,
                name = a.name,
                data = wrap76(&a.data_b64),
            ));
        }
        s.push_str(&format!("--{boundary}--"));
        s
    };
    URL_SAFE.encode(raw.as_bytes())
}

/// Wrap a base64 string at 76 chars per line (RFC 2045).
fn wrap76(b64: &str) -> String {
    b64.as_bytes()
        .chunks(76)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect::<Vec<_>>()
        .join("\r\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE, Engine};

    #[test]
    fn plain_body_round_trips() {
        let raw = build_raw("me@x.co", "you@y.io", "", "", "Hi", "<p>hello</p>", &[]);
        let decoded = String::from_utf8(URL_SAFE.decode(raw).unwrap()).unwrap();
        assert!(decoded.contains("To: you@y.io"));
        assert!(decoded.contains("<p>hello</p>"));
        assert!(!decoded.contains("multipart"));
        // no Cc/Bcc headers when those are empty
        assert!(!decoded.contains("Cc:"));
        assert!(!decoded.contains("Bcc:"));
    }

    #[test]
    fn cc_and_bcc_headers_present_when_set() {
        let raw = build_raw("me@x.co", "you@y.io", "cc@y.io", "bcc@y.io", "Hi", "<p>hi</p>", &[]);
        let decoded = String::from_utf8(URL_SAFE.decode(raw).unwrap()).unwrap();
        assert!(decoded.contains("Cc: cc@y.io"));
        assert!(decoded.contains("Bcc: bcc@y.io"));
    }

    #[test]
    fn with_attachment_is_multipart() {
        let att = Attachment { name: "a.txt".into(), mime: "text/plain".into(), data_b64: "aGk=".into() };
        let raw = build_raw("me@x.co", "you@y.io", "", "", "Hi", "<p>hi</p>", &[att]);
        let decoded = String::from_utf8(URL_SAFE.decode(raw).unwrap()).unwrap();
        assert!(decoded.contains("multipart/mixed"));
        assert!(decoded.contains("filename=\"a.txt\""));
        assert!(decoded.contains("aGk="));
    }
}
