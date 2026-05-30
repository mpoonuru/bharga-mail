//! OAuth 2.0 with PKCE via a loopback redirect (the desktop-app pattern Google
//! recommends). No client secret is shipped; PKCE protects the exchange.
//!
//! Flow: build the auth URL → open the system browser → run a tiny localhost
//! server to catch the `?code=` redirect → exchange code+verifier for tokens.
//! Tokens are stored in the OS keychain (see `tokens.rs`).

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::Rng;
use sha2::{Digest, Sha256};

#[derive(Debug, thiserror::Error)]
pub enum OAuthError {
    #[error("browser open failed: {0}")]
    Browser(String),
    #[error("loopback server: {0}")]
    Loopback(String),
    #[error("token exchange failed: {0}")]
    Exchange(String),
    #[error("no authorization code received")]
    NoCode,
}

pub struct OAuthConfig {
    pub auth_url: String,
    pub token_url: String,
    pub client_id: String,
    pub scopes: Vec<String>,
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
    let auth = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        cfg.auth_url,
        urlencoding::encode(&cfg.client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(&scope),
        challenge,
        state,
    );
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
    resp.json::<TokenSet>().await.map_err(|e| OAuthError::Exchange(e.to_string()))
}

fn capture_code(server: &tiny_http::Server, expected_state: &str) -> Result<String, OAuthError> {
    // Handle one request: parse ?code=&state= from the path, reply with a friendly page.
    for request in server.incoming_requests() {
        let url = request.url().to_string();
        let (code, state) = parse_query(&url);
        let body = "<html><body style='font-family:sans-serif;text-align:center;padding:60px'>\
                    <h2>Aether Mail</h2><p>You can close this tab and return to the app.</p></body></html>";
        let _ = request.respond(
            tiny_http::Response::from_string(body)
                .with_header("Content-Type: text/html".parse::<tiny_http::Header>().unwrap()),
        );
        if state.as_deref() != Some(expected_state) {
            continue; // ignore mismatched/extra hits (favicon etc.)
        }
        return code.ok_or(OAuthError::NoCode);
    }
    Err(OAuthError::NoCode)
}

fn parse_query(url: &str) -> (Option<String>, Option<String>) {
    let q = url.split('?').nth(1).unwrap_or("");
    let mut code = None;
    let mut state = None;
    for pair in q.split('&') {
        let mut it = pair.splitn(2, '=');
        match (it.next(), it.next()) {
            (Some("code"), Some(v)) => code = Some(urlencoding::decode(v).map(|c| c.into_owned()).unwrap_or_default()),
            (Some("state"), Some(v)) => state = Some(urlencoding::decode(v).map(|c| c.into_owned()).unwrap_or_default()),
            _ => {}
        }
    }
    (code, state)
}
