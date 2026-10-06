//! OAuth 2.0 with PKCE via a loopback redirect (the desktop-app pattern Google
//! recommends). No client secret is shipped; PKCE protects the exchange.
//!
//! Flow: build the auth URL → open the system browser → run a tiny localhost
//! server to catch the `?code=` redirect → exchange code+verifier for tokens.
//! Tokens are encrypted in the local store under a Keychain-held master key.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::Rng;
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};

const AUTHORIZATION_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, thiserror::Error)]
pub enum OAuthError {
    #[error("browser open failed: {0}")]
    Browser(String),
    #[error("loopback server: {0}")]
    Loopback(String),
    #[error("token exchange failed: {0}")]
    Exchange(String),
    #[error("authorization was cancelled")]
    Cancelled,
    #[error("authorization callback state did not match")]
    StateMismatch,
    #[error("authorization timed out")]
    Timeout,
    #[error("no authorization code received")]
    NoCode,
}

#[derive(Debug, PartialEq, Eq)]
enum CallbackOutcome {
    Code(String),
    Ignore,
}

pub struct OAuthConfig {
    pub auth_url: String,
    pub token_url: String,
    pub client_id: String,
    pub scopes: Vec<String>,
    pub purpose: OAuthPurpose,
    pub extra_auth_params: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OAuthPurpose {
    Mail,
    Calendar,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct TokenSet {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_in: Option<i64>,
}

fn pkce_pair() -> (String, String) {
    let verifier: String = {
        let bytes: [u8; 32] = rand::thread_rng().gen();
        URL_SAFE_NO_PAD.encode(bytes)
    };
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

/// Run the interactive auth flow and return tokens.
pub async fn run_pkce_flow(cfg: &OAuthConfig) -> Result<TokenSet, OAuthError> {
    // 1. bind a loopback port first so we know the redirect URI.
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| OAuthError::Loopback(e.to_string()))?;
    let port = match server.server_addr() {
        tiny_http::ListenAddr::IP(addr) => addr.port(),
        _ => return Err(OAuthError::Loopback("non-ip listen addr".into())),
    };
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let (verifier, challenge) = pkce_pair();
    let state: String = URL_SAFE_NO_PAD.encode(rand::thread_rng().gen::<[u8; 16]>());

    // 2. build the consent URL and open the browser.
    let scope = cfg.scopes.join(" ");
    let mut auth = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        cfg.auth_url,
        urlencoding::encode(&cfg.client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(&scope),
        challenge,
        state,
    );
    for (name, value) in &cfg.extra_auth_params {
        auth.push('&');
        auth.push_str(&urlencoding::encode(name));
        auth.push('=');
        auth.push_str(&urlencoding::encode(value));
    }
    open::that(&auth).map_err(|e| OAuthError::Browser(e.to_string()))?;

    // 3. block (on a worker thread) for the redirect carrying ?code=.
    let code = tokio::task::spawn_blocking(move || capture_code(&server, &state))
        .await
        .map_err(|e| OAuthError::Loopback(e.to_string()))??;

    // 4. exchange code + verifier for tokens.
    let params = [
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("client_id", &cfg.client_id),
        ("redirect_uri", &redirect_uri),
        ("code_verifier", &verifier),
    ];
    let resp = reqwest::Client::new()
        .post(&cfg.token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| OAuthError::Exchange(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(OAuthError::Exchange(format!("HTTP {}", resp.status())));
    }
    resp.json::<TokenSet>().await.map_err(|e| OAuthError::Exchange(e.to_string()))
}

/// Refresh an access token using a stored refresh token.
pub async fn refresh(cfg: &OAuthConfig, refresh_token: &str) -> Result<TokenSet, OAuthError> {
    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", &cfg.client_id),
    ];
    let resp = reqwest::Client::new()
        .post(&cfg.token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| OAuthError::Exchange(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(OAuthError::Exchange(format!("HTTP {}", resp.status())));
    }
    resp.json::<TokenSet>().await.map_err(|e| OAuthError::Exchange(e.to_string()))
}

fn capture_code(server: &tiny_http::Server, expected_state: &str) -> Result<String, OAuthError> {
    let deadline = Instant::now() + AUTHORIZATION_TIMEOUT;
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(OAuthError::Timeout);
        }
        let wait = deadline
            .saturating_duration_since(now)
            .min(Duration::from_secs(1));
        let Some(request) = server
            .recv_timeout(wait)
            .map_err(|error| OAuthError::Loopback(error.to_string()))?
        else {
            continue;
        };
        let url = request.url().to_string();
        let outcome = parse_callback(&url, expected_state);
        let body = "<html><body style='font-family:sans-serif;text-align:center;padding:60px'>\
                    <h2>Bharga Mail</h2><p>You can close this tab and return to the app.</p></body></html>";
        let _ = request.respond(
            tiny_http::Response::from_string(body)
                .with_header("Content-Type: text/html".parse::<tiny_http::Header>().unwrap()),
        );
        match outcome? {
            CallbackOutcome::Code(code) => return Ok(code),
            CallbackOutcome::Ignore => continue,
        }
    }
}

fn parse_callback(url: &str, expected_state: &str) -> Result<CallbackOutcome, OAuthError> {
    let q = url.split('?').nth(1).unwrap_or("");
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for pair in q.split('&') {
        let mut it = pair.splitn(2, '=');
        match (it.next(), it.next()) {
            (Some("code"), Some(v)) => code = Some(urlencoding::decode(v).map(|c| c.into_owned()).unwrap_or_default()),
            (Some("state"), Some(v)) => state = Some(urlencoding::decode(v).map(|c| c.into_owned()).unwrap_or_default()),
            (Some("error"), Some(v)) => error = Some(urlencoding::decode(v).map(|c| c.into_owned()).unwrap_or_default()),
            _ => {}
        }
    }
    if code.is_none() && state.is_none() && error.is_none() {
        return Ok(CallbackOutcome::Ignore);
    }
    if state.as_deref() != Some(expected_state) {
        return Err(OAuthError::StateMismatch);
    }
    if error.as_deref() == Some("access_denied") {
        return Err(OAuthError::Cancelled);
    }
    if error.is_some() {
        return Err(OAuthError::Exchange("authorization failed".into()));
    }
    code.map(CallbackOutcome::Code).ok_or(OAuthError::NoCode)
}

#[cfg(test)]
mod tests {
    use super::{parse_callback, CallbackOutcome, OAuthError};

    #[test]
    fn callback_denial_is_cancelled() {
        assert!(matches!(
            parse_callback("/?error=access_denied&state=expected", "expected"),
            Err(OAuthError::Cancelled)
        ));
    }

    #[test]
    fn callback_state_mismatch_is_rejected() {
        assert!(matches!(
            parse_callback("/?code=secret&state=wrong", "expected"),
            Err(OAuthError::StateMismatch)
        ));
    }

    #[test]
    fn callback_without_authorization_fields_is_ignored() {
        assert!(matches!(
            parse_callback("/favicon.ico", "expected"),
            Ok(CallbackOutcome::Ignore)
        ));
    }
}
