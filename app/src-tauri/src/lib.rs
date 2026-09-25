//! Bharga Mail — Rust core.
//! Exposes typed Tauri commands the React UI calls via IPC. The UI only ever
//! talks to the local store; the sync engine reconciles it with providers.

pub mod ai;
pub mod store;
pub mod sync;

use std::sync::{Arc, Mutex};

use ai::{
    build_provider, default_profile, prompts, router::Router, AiProfile, ModelConfig, ProviderKind,
    Role, SaveProviderInput,
};
use store::{Attachment, CalEvent, ImapAccount, OutboxItem, Security, Store, Task, Thread};
use tauri::{Manager, State};

/// App-wide managed state: the local store + the AI profile.
/// `store` is an `Arc` so the background outbox task can own a clone rather than
/// borrow Tauri `State` across `.await` (which wouldn't be `Send`).
pub struct AppState {
    pub ai: Mutex<AiProfile>,
    pub store: Arc<Store>,
}

// ---- AI configuration commands ----

#[tauri::command]
fn get_ai_profile(state: State<'_, AppState>) -> AiProfile {
    let mut profile = state.ai.lock().unwrap().clone();
    refresh_ai_readiness(&mut profile);
    profile
}

#[tauri::command]
fn set_ai_privacy(privacy: ai::Privacy, state: State<'_, AppState>) -> Result<(), String> {
    // Every AI mutation holds the same lock through persistence. Privacy changes
    // own only this field and therefore cannot overwrite concurrent providers.
    let mut current = state.ai.lock().unwrap();
    let mut next = current.clone();
    next.privacy = privacy;
    persist_ai_profile(&state.store, &next)?;
    *current = next;
    Ok(())
}

fn persist_ai_profile(store: &Store, profile: &AiProfile) -> Result<(), String> {
    let json = serde_json::to_string(profile).map_err(|e| e.to_string())?;
    store
        .set_setting("ai_profile", &json)
        .map_err(|e| e.to_string())
}

fn refresh_ai_readiness(profile: &mut AiProfile) {
    for model in &mut profile.models {
        model.ready = match model.kind {
            ProviderKind::Local => model
                .endpoint
                .as_deref()
                .is_some_and(|v| !v.trim().is_empty()),
            ProviderKind::OpenAiCompatible | ProviderKind::Custom => {
                let endpoint = model.endpoint.as_deref().unwrap_or_default();
                !endpoint.trim().is_empty()
                    && (!endpoint.contains("api.openai.com")
                        || sync::tokens::ai_key(&model.id).is_some())
            }
            ProviderKind::Anthropic | ProviderKind::Google => {
                sync::tokens::ai_key(&model.id).is_some()
            }
        };
    }
}

fn validate_provider(input: &SaveProviderInput) -> Result<(), String> {
    if input.id.trim().is_empty() || input.label.trim().is_empty() {
        return Err("Provider id and name are required".into());
    }
    if input.id.len() > 128
        || !input
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err("Provider id is invalid".into());
    }
    if let Some(endpoint) = input.endpoint.as_deref().filter(|v| !v.trim().is_empty()) {
        if !(endpoint.starts_with("http://") || endpoint.starts_with("https://")) {
            return Err("Endpoint must start with http:// or https://".into());
        }
    }
    Ok(())
}

#[tauri::command]
fn save_ai_provider(
    input: SaveProviderInput,
    state: State<'_, AppState>,
) -> Result<AiProfile, String> {
    validate_provider(&input)?;
    // Serialize the credential + profile transaction with every other AI write.
    let mut current = state.ai.lock().unwrap();
    let previous_key = sync::tokens::ai_key(&input.id);
    let mut replaced_key = false;
    if let Some(key) = input
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
    {
        sync::tokens::save_ai_key(&input.id, key)?;
        replaced_key = true;
    }
    let mut profile = current.clone();
    let model = ModelConfig {
        id: input.id.clone(),
        label: input.label.trim().to_string(),
        kind: input.kind,
        roles: input.roles,
        ready: false,
        endpoint: input
            .endpoint
            .map(|value| value.trim().trim_end_matches('/').to_string())
            .filter(|value| !value.is_empty()),
        model: input
            .model
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        caps: input.caps,
    };
    if let Some(existing) = profile
        .models
        .iter_mut()
        .find(|existing| existing.id == model.id)
    {
        *existing = model;
    } else {
        profile.models.push(model);
    }
    refresh_ai_readiness(&mut profile);
    if let Err(error) = persist_ai_profile(&state.store, &profile) {
        if replaced_key {
            if let Some(previous) = previous_key {
                let _ = sync::tokens::save_ai_key(&input.id, &previous);
            } else {
                let _ = sync::tokens::delete_ai_key(&input.id);
            }
        }
        return Err(error);
    }
    *current = profile.clone();
    Ok(profile)
}

#[tauri::command]
async fn test_ai_provider(input: SaveProviderInput) -> Result<String, String> {
    validate_provider(&input)?;
    let api_key = input
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string)
        .or_else(|| sync::tokens::ai_key(&input.id));
    let model = ModelConfig {
        id: input.id,
        label: input.label,
        kind: input.kind,
        roles: input.roles,
        ready: true,
        endpoint: input.endpoint,
        model: input.model,
        caps: input.caps,
    };
    build_provider(&model, api_key)
        .chat(&[ai::ChatMessage {
            role: "user".into(),
            content: "Reply with OK.".into(),
        }])
        .await
        .map_err(|error| error.to_string())?;
    Ok("Connection verified.".into())
}

#[tauri::command]
fn remove_ai_provider(
    provider_id: String,
    state: State<'_, AppState>,
) -> Result<AiProfile, String> {
    let mut current = state.ai.lock().unwrap();
    let previous_key = sync::tokens::ai_key(&provider_id);
    sync::tokens::delete_ai_key(&provider_id)?;
    let mut profile = current.clone();
    profile.models.retain(|model| model.id != provider_id);
    if let Err(error) = persist_ai_profile(&state.store, &profile) {
        if let Some(previous) = previous_key {
            let _ = sync::tokens::save_ai_key(&provider_id, &previous);
        }
        refresh_ai_readiness(&mut current);
        return Err(error);
    }
    *current = profile.clone();
    Ok(profile)
}

fn model_for(state: &State<'_, AppState>, role: Role) -> Option<ai::ModelConfig> {
    let profile = state.ai.lock().unwrap();
    Router::new(&profile).resolve(role).cloned()
}

/// Embed text using the model assigned to the Embeddings role.
async fn embed_one(model: &ai::ModelConfig, text: &str) -> Option<Vec<f32>> {
    let provider = build_provider(model, sync::tokens::ai_key(&model.id));
    provider
        .embed(&[text.to_string()])
        .await
        .ok()?
        .into_iter()
        .next()
}

#[tauri::command]
async fn ai_draft_reply(
    thread_id: String,
    thread_text: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let model = model_for(&state, Role::Draft)
        .ok_or("No model assigned to the Draft role. Add one in Settings.")?;
    let provider = build_provider(&model, sync::tokens::ai_key(&model.id));
    let _ = thread_id;
    provider
        .chat(&prompts::draft_reply(&thread_text, None))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ai_summarize(thread_text: String, state: State<'_, AppState>) -> Result<String, String> {
    let model = model_for(&state, Role::Summarize).ok_or("No model assigned to Summarize.")?;
    let provider = build_provider(&model, sync::tokens::ai_key(&model.id));
    provider
        .chat(&prompts::summarize(&thread_text))
        .await
        .map_err(|e| e.to_string())
}

/// Phase-2 phishing verdict from the local Triage model (private, no API cost).
/// Returns the parsed verdict as JSON: { level, confidence, reason }.
#[tauri::command]
async fn ai_phishing_check(
    thread_text: String,
    links: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let model = model_for(&state, Role::Triage)
        .ok_or("No model assigned to Triage. Add one in Settings.")?;
    let out = build_provider(&model, sync::tokens::ai_key(&model.id))
        .chat(&prompts::phishing_check(&thread_text, &links))
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_string(&prompts::parse_phishing(&out)).map_err(|e| e.to_string())
}

/// Build a semantic index: embed any threads that don't yet have a vector.
/// Returns how many were indexed.
#[tauri::command]
async fn reindex_embeddings(state: State<'_, AppState>) -> Result<usize, String> {
    let model = model_for(&state, Role::Embeddings)
        .ok_or("No model assigned to the Embeddings role. Add one in Settings.")?;
    let threads = state.store.threads();
    let todo = state.store.unembedded_thread_ids();
    let mut indexed = 0;
    for t in threads.iter().filter(|t| todo.contains(&t.id)) {
        let text = format!("{}\n{}", t.subject, t.preview);
        if let Some(vec) = embed_one(&model, &text).await {
            if state.store.upsert_embedding(&t.id, &vec).is_ok() {
                indexed += 1;
            }
        }
    }
    Ok(indexed)
}

/// Self-organizing priority inbox: for each un-summarized thread, generate a
/// summary (Summarize model) and a triage classification (Triage model), then
/// persist both. Returns how many threads were processed.
#[tauri::command]
async fn ai_triage_inbox(state: State<'_, AppState>) -> Result<usize, String> {
    let summarize_model = model_for(&state, Role::Summarize);
    let triage_model = model_for(&state, Role::Triage);
    if summarize_model.is_none() && triage_model.is_none() {
        return Err("Assign Summarize/Triage models in Settings.".into());
    }

    let mut processed = 0;
    for t in state.store.unsummarized_threads() {
        let text = format!(
            "Subject: {}\n{}",
            t.subject,
            t.messages
                .iter()
                .map(|m| store::strip_html(&m.body_html))
                .collect::<Vec<_>>()
                .join("\n")
        );

        if let Some(m) = &summarize_model {
            if let Ok(summary) = build_provider(m, sync::tokens::ai_key(&m.id))
                .chat(&prompts::summarize(&text))
                .await
            {
                let _ = state.store.set_ai_artifacts(&t.id, Some(&summary), None);
            }
        }
        if let Some(m) = &triage_model {
            if let Ok(out) = build_provider(m, sync::tokens::ai_key(&m.id))
                .chat(&prompts::triage(&text))
                .await
            {
                let tri = prompts::parse_triage(&out);
                let _ = state.store.set_triage(&t.id, &tri.labels, tri.priority);
            }
        }
        processed += 1;
    }
    Ok(processed)
}

#[tauri::command]
async fn ai_ask_inbox(query: String, state: State<'_, AppState>) -> Result<String, String> {
    // Retrieval: prefer semantic (vector) search; fall back to FTS keyword search.
    let mut hit_ids: Vec<String> = Vec::new();
    if let Some(embed_model) = model_for(&state, Role::Embeddings) {
        if state.store.embedding_count() > 0 {
            if let Some(qv) = embed_one(&embed_model, &query).await {
                hit_ids = ai::search::top_k(&qv, &state.store.all_embeddings(), 8);
            }
        }
    }
    if hit_ids.is_empty() {
        hit_ids = state.store.search(&query); // FTS fallback
    }

    let threads = state.store.threads();
    let context = threads
        .iter()
        .filter(|t| hit_ids.is_empty() || hit_ids.contains(&t.id))
        .take(8)
        .map(|t| format!("[{}] {}: {}", t.id, t.subject, t.preview))
        .collect::<Vec<_>>()
        .join("\n");

    let model = model_for(&state, Role::Agent)
        .or_else(|| model_for(&state, Role::Summarize))
        .ok_or("No model available. Configure your AI engine in Settings.")?;
    let provider = build_provider(&model, sync::tokens::ai_key(&model.id));
    provider
        .chat(&prompts::ask_inbox(&query, &context))
        .await
        .map_err(|e| e.to_string())
}

// ---- Mail / data commands ----

#[tauri::command]
fn list_threads(state: State<'_, AppState>) -> Vec<Thread> {
    state.store.threads()
}

/// Full-text search over subject + body (FTS5). Returns ranked threads with
/// their messages — searches the whole email content, not just the preview.
#[tauri::command]
fn search_mail(query: String, state: State<'_, AppState>) -> Vec<Thread> {
    let q = query.trim();
    if q.is_empty() {
        return Vec::new();
    }
    state.store.search_threads(q)
}

/// All connected accounts (for the sidebar account switcher).
#[tauri::command]
fn list_accounts(state: State<'_, AppState>) -> Vec<store::AccountInfo> {
    state.store.accounts()
}

/// Durable user settings (theme, density, font, locale, …).
#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> std::collections::HashMap<String, String> {
    state.store.settings()
}

#[tauri::command]
fn set_setting(key: String, value: String, state: State<'_, AppState>) -> Result<(), String> {
    state
        .store
        .set_setting(&key, &value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_tasks(state: State<'_, AppState>) -> Vec<Task> {
    state.store.tasks()
}

#[tauri::command]
fn list_events(state: State<'_, AppState>) -> Vec<CalEvent> {
    state.store.events()
}

#[tauri::command]
fn set_task_done(id: String, done: bool, state: State<'_, AppState>) -> Result<(), String> {
    state
        .store
        .set_task_done(&id, done)
        .map_err(|e| e.to_string())
}

/// Create a task, optionally linked to the email thread it came from.
#[tauri::command]
fn create_task(
    title: String,
    source_thread_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let id = format!("k-{}", chrono::Utc::now().timestamp_millis());
    state
        .store
        .add_task(
            &Task {
                id: id.clone(),
                title,
                due: None,
                done: false,
            },
            source_thread_id.as_deref(),
        )
        .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Queue an outgoing message. `delay_seconds` is the Undo-Send window — the
/// message isn't sent until then, and `cancel_send` before it removes the row.
#[tauri::command]
fn queue_send(
    account_id: String,
    thread_id: Option<String>,
    to: String,
    cc: Option<String>,
    bcc: Option<String>,
    subject: String,
    body: String,
    attachments: Option<Vec<Attachment>>,
    delay_seconds: i64,
    // Absolute epoch-seconds to send at (scheduled "send later"). When set and in
    // the future it wins over `delay_seconds`; otherwise the undo-window delay is used.
    send_at: Option<i64>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let id = format!("ob-{}", chrono::Utc::now().timestamp_millis());
    let now = chrono::Utc::now().timestamp();
    let scheduled_ts = match send_at {
        Some(at) if at > now => at,
        _ => now + delay_seconds.max(0),
    };
    let item = OutboxItem {
        id: id.clone(),
        account_id,
        thread_id,
        to,
        cc: cc.unwrap_or_default(),
        bcc: bcc.unwrap_or_default(),
        subject,
        body,
        attachments: attachments.unwrap_or_default(),
        scheduled_ts,
        status: "queued".into(),
    };
    state
        .store
        .enqueue_outbox(&item)
        .map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
fn cancel_send(id: String, state: State<'_, AppState>) -> Result<bool, String> {
    state.store.cancel_outbox(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_outbox(state: State<'_, AppState>) -> Vec<OutboxItem> {
    state.store.list_outbox()
}

#[tauri::command]
async fn flush_outbox(state: State<'_, AppState>) -> Result<usize, String> {
    Ok(sync::outbox::flush(&state.store).await)
}

// ---- Account / sync commands ----

#[tauri::command]
async fn connect_gmail(state: State<'_, AppState>) -> Result<String, String> {
    sync::gmail::connect(&state.store)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn connect_microsoft(state: State<'_, AppState>) -> Result<String, String> {
    sync::microsoft::connect(&state.store)
        .await
        .map_err(|e| e.to_string())
}

/// Full IMAP/SMTP account setup with separate incoming/outgoing servers,
/// security modes, and (optionally distinct) credentials.
fn default_same_credentials() -> bool {
    true
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImapAccountInput {
    account_id: Option<String>,
    email: String,
    display_name: Option<String>,
    imap_host: String,
    imap_port: u16,
    imap_security: String,
    imap_username: Option<String>,
    imap_password: String,
    smtp_host: String,
    smtp_port: u16,
    smtp_security: String,
    #[serde(default = "default_same_credentials")]
    same_credentials: bool,
    smtp_username: Option<String>,
    smtp_password: Option<String>,
}

/// Test IMAP + SMTP connectivity with the entered settings, without saving.
#[tauri::command]
async fn test_imap_account(input: ImapAccountInput) -> Result<String, String> {
    if !input.same_credentials
        && (input.smtp_username.as_deref().map(str::trim).unwrap_or_default().is_empty()
            || input.smtp_password.as_deref().map(str::trim).unwrap_or_default().is_empty())
    {
        return Err("Separate SMTP credentials require a username and password".into());
    }
    let imap_user = input
        .imap_username
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| input.email.clone());
    let imap_host = input.imap_host.clone();
    let imap_port = input.imap_port;
    let imap_sec = Security::parse(&input.imap_security);
    let imap_pass = input.imap_password.clone();
    tokio::task::spawn_blocking(move || {
        sync::imap::test_login(&imap_host, imap_port, imap_sec, &imap_user, &imap_pass)
    })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    let smtp_host = input.smtp_host.clone();
    let smtp_port = input.smtp_port;
    let smtp_sec = Security::parse(&input.smtp_security);
    tokio::task::spawn_blocking(move || sync::smtp::test_conn(&smtp_host, smtp_port, smtp_sec))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    Ok("IMAP login and SMTP connection OK".into())
}

fn plan_imap_secret_updates(
    editing: bool,
    previous_same_credentials: bool,
    previous_smtp_username: Option<&str>,
    same_credentials: bool,
    smtp_username: &str,
    imap_password: &str,
    smtp_password: Option<&str>,
    stored_imap_password: Option<&str>,
    has_stored_smtp_password: bool,
) -> Result<Vec<(&'static str, String)>, String> {
    if !editing && imap_password.is_empty() {
        return Err("An IMAP password is required".into());
    }
    if editing && imap_password.is_empty() && stored_imap_password.is_none() {
        return Err("The saved IMAP credential is unavailable; enter it again".into());
    }

    let mut updates = Vec::new();
    if !imap_password.is_empty() {
        updates.push(("imap-pass", imap_password.to_string()));
    }

    if same_credentials {
        if !imap_password.is_empty() || !previous_same_credentials || !has_stored_smtp_password {
            let effective_imap = if imap_password.is_empty() {
                stored_imap_password.ok_or("The saved IMAP credential is unavailable; enter it again")?
            } else {
                imap_password
            };
            updates.push(("smtp-pass", effective_imap.to_string()));
        }
    } else {
        if smtp_username.trim().is_empty() {
            return Err("A separate SMTP username is required".into());
        }
        if let Some(password) = smtp_password.map(str::trim).filter(|value| !value.is_empty()) {
            updates.push(("smtp-pass", password.to_string()));
        } else {
            let can_preserve = editing
                && !previous_same_credentials
                && previous_smtp_username.is_some_and(|previous| previous == smtp_username.trim())
                && has_stored_smtp_password;
            if !can_preserve {
                return Err("A separate SMTP password is required".into());
            }
        }
    }

    Ok(updates)
}

fn compare_legacy_imap_credentials(
    imap_password: Option<&str>,
    smtp_password: Option<&str>,
) -> Result<bool, String> {
    match (imap_password, smtp_password) {
        (Some(imap), Some(smtp)) => Ok(imap == smtp),
        _ => Err("Saved credentials could not be read safely; unlock the keychain and try again".into()),
    }
}

fn resolve_imap_credential_mode(store: &Store, account: &mut ImapAccount) -> Result<(), String> {
    if let Some(explicit) = store
        .imap_same_credentials(&account.account_id)
        .map_err(|error| error.to_string())?
    {
        account.same_credentials = explicit;
        return Ok(());
    }
    let imap_password = sync::tokens::secret(&account.account_id, "imap-pass");
    let smtp_password = sync::tokens::secret(&account.account_id, "smtp-pass");
    let resolved = compare_legacy_imap_credentials(imap_password.as_deref(), smtp_password.as_deref())?;
    store
        .set_setting(
            &format!("imap_same_credentials:{}", account.account_id),
            &resolved.to_string(),
        )
        .map_err(|error| error.to_string())?;
    account.same_credentials = resolved;
    Ok(())
}

#[tauri::command]
fn save_imap_account(
    input: ImapAccountInput,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let existing = if let Some(existing_id) = input.account_id.as_deref() {
        let mut account = state
            .store
            .imap_account(existing_id)
            .ok_or_else(|| "The account being edited no longer exists".to_string())?;
        resolve_imap_credential_mode(&state.store, &mut account)?;
        if account.email != input.email {
            return Err("An account email address cannot be changed in place".into());
        }
        Some(account)
    } else {
        None
    };
    let account_id = existing
        .as_ref()
        .map(|account| account.account_id.clone())
        .unwrap_or_else(|| format!("imap:{}", input.email));
    let imap_user = input
        .imap_username
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| input.email.clone());
    let smtp_user = if input.same_credentials {
        imap_user.clone()
    } else {
        input
            .smtp_username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "A separate SMTP username is required".to_string())?
            .to_string()
    };
    let previous_same_credentials = existing
        .as_ref()
        .map_or(true, |account| account.same_credentials);
    let stored_imap_password = if existing.is_some() && input.imap_password.is_empty() {
        sync::tokens::secret(&account_id, "imap-pass")
    } else {
        None
    };
    let has_stored_smtp_password = existing.is_some()
        && input.smtp_password.as_deref().map(str::trim).unwrap_or_default().is_empty()
        && sync::tokens::secret(&account_id, "smtp-pass").is_some();
    let plain_updates = plan_imap_secret_updates(
        existing.is_some(),
        previous_same_credentials,
        existing.as_ref().map(|account| account.smtp_username.as_str()),
        input.same_credentials,
        &smtp_user,
        &input.imap_password,
        input.smtp_password.as_deref(),
        stored_imap_password.as_deref(),
        has_stored_smtp_password,
    )?;

    let acct = ImapAccount {
        account_id: account_id.clone(),
        email: input.email.clone(),
        display_name: input.display_name.unwrap_or_default(),
        imap_host: input.imap_host,
        imap_port: input.imap_port,
        imap_security: Security::parse(&input.imap_security),
        imap_username: imap_user,
        smtp_host: input.smtp_host,
        smtp_port: input.smtp_port,
        smtp_security: Security::parse(&input.smtp_security),
        smtp_username: smtp_user,
        same_credentials: input.same_credentials,
    };
    // Encrypt the complete credential transition before committing config and
    // ciphertext together, so the account can never retain a mismatched secret.
    let update_refs = plain_updates
        .iter()
        .map(|(kind, value)| (*kind, value.as_str()))
        .collect::<Vec<_>>();
    let encrypted_updates = sync::tokens::prepare_secret_updates(&update_refs)?;
    state
        .store
        .save_imap_account_atomic(&acct, &encrypted_updates)
        .map_err(|e| e.to_string())?;
    for (kind, _) in &encrypted_updates {
        let _ = sync::tokens::delete_legacy_secret(&account_id, kind);
    }
    Ok(account_id)
}

/// Saved IMAP/SMTP settings for an account (no password — used to pre-fill the
/// edit form).
#[tauri::command]
fn get_imap_account(account_id: String, state: State<'_, AppState>) -> Result<Option<ImapAccount>, String> {
    let Some(mut account) = state.store.imap_account(&account_id) else {
        return Ok(None);
    };
    resolve_imap_credential_mode(&state.store, &mut account)?;
    Ok(Some(account))
}

/// Remove an account and all of its data (threads, messages, embeddings, config),
/// and clear its stored credentials.
#[tauri::command]
fn rename_account(
    account_id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Account name can't be empty.".into());
    }
    state
        .store
        .set_account_name(&account_id, &name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_account(account_id: String, state: State<'_, AppState>) -> Result<(), String> {
    remove_account_from_store(&state.store, &account_id, sync::tokens::clear)
}

fn remove_account_from_store<F>(
    store: &store::Store,
    account_id: &str,
    clear_credentials: F,
) -> Result<(), String>
where
    F: FnOnce(&str) -> Result<(), String>,
{
    // Credentials go first. If local-data cleanup later fails, the account row
    // remains visible and removal can be retried; no orphaned secret is hidden.
    clear_credentials(account_id)?;
    store
        .delete_account(&account_id)
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn sync_failure_status(error: &impl std::fmt::Display) -> &'static str {
    let message = error.to_string().to_ascii_lowercase();
    if ["auth", "unauthorized", "401", "credential", "login"]
        .iter()
        .any(|needle| message.contains(needle))
    {
        "Authentication required"
    } else {
        "Sync needs attention"
    }
}

/// Sync an account's inbox. Returns the number of messages stored (so the UI can
/// distinguish "synced 0" from a connection failure).
#[tauri::command]
async fn sync_now(
    account_id: String,
    group: Option<bool>,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let result = if account_id.starts_with("ms:") {
        sync::microsoft::incremental(&state.store, &account_id)
            .await
            .map(|_| 0)
    } else if account_id.starts_with("imap:") {
        sync::imap::fetch_folder_async(
            state.store.clone(),
            account_id.clone(),
            "INBOX".into(),
            75,
            group.unwrap_or(true),
            false,
        )
            .await
    } else {
        sync::gmail::incremental(&state.store, &account_id)
            .await
            .map(|_| 0)
    };

    let result = match result {
        Ok(result) => result,
        Err(error) => {
            let _ = state
                .store
                .record_sync_failure(&account_id, sync_failure_status(&error));
            return Err(error.to_string());
        }
    };

    state
        .store
        .record_sync_success(&account_id, "INBOX", chrono::Utc::now().timestamp())
        .map_err(|error| error.to_string())?;
    Ok(result)
}

/// Backfill: pull OLDER messages for a folder by re-seeding the most-recent
/// `count` (force_full bypasses the incremental cursor). Returns messages stored.
#[tauri::command]
async fn load_older(
    account_id: String,
    folder: String,
    count: u32,
    group: Option<bool>,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    if account_id.starts_with("imap:") {
        sync::imap::fetch_folder_async(
            state.store.clone(),
            account_id,
            folder,
            count,
            group.unwrap_or(true),
            true,
        )
            .await
            .map_err(|e| e.to_string())
    } else {
        Err("Loading older mail is currently available for IMAP accounts.".into())
    }
}

/// Enumerate an IMAP account's folders (mailboxes) and return them.
#[tauri::command]
async fn list_folders(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    if account_id.starts_with("imap:") {
        sync::imap::list_folders_async(state.store.clone(), account_id)
            .await
            .map_err(|e| e.to_string())
    } else {
        Ok(vec!["INBOX".into()]) // Gmail/Graph folder browsing is a later milestone.
    }
}

/// Create a new IMAP mailbox (folder).
#[tauri::command]
async fn create_folder(
    account_id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Folder name can't be empty.".into());
    }
    if !account_id.starts_with("imap:") {
        return Err("Folder management is currently available for IMAP accounts.".into());
    }
    sync::imap::manage_folder_async(
        state.store.clone(),
        account_id,
        sync::imap::FolderAction::Create(name),
    )
    .await
    .map_err(|e| e.to_string())
}

/// Rename an IMAP mailbox (folder).
#[tauri::command]
async fn rename_folder(
    account_id: String,
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let to = to.trim().to_string();
    if to.is_empty() {
        return Err("Folder name can't be empty.".into());
    }
    if !account_id.starts_with("imap:") {
        return Err("Folder management is currently available for IMAP accounts.".into());
    }
    sync::imap::manage_folder_async(
        state.store.clone(),
        account_id,
        sync::imap::FolderAction::Rename(from, to),
    )
    .await
    .map_err(|e| e.to_string())
}

/// Delete an IMAP mailbox (folder). The server removes the mailbox and its mail.
#[tauri::command]
async fn delete_folder(
    account_id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if name.eq_ignore_ascii_case("INBOX") {
        return Err("The Inbox can't be deleted.".into());
    }
    if !account_id.starts_with("imap:") {
        return Err("Folder management is currently available for IMAP accounts.".into());
    }
    sync::imap::manage_folder_async(
        state.store.clone(),
        account_id,
        sync::imap::FolderAction::Delete(name),
    )
    .await
    .map_err(|e| e.to_string())
}

/// Sync a specific folder for an IMAP account. Returns messages stored.
#[tauri::command]
async fn sync_folder(
    account_id: String,
    folder: String,
    group: Option<bool>,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    if account_id.starts_with("imap:") {
        let result = sync::imap::fetch_folder_async(
            state.store.clone(),
            account_id.clone(),
            folder.clone(),
            75,
            group.unwrap_or(true),
            false,
        )
            .await;
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                let _ = state
                    .store
                    .record_sync_failure(&account_id, sync_failure_status(&error));
                return Err(error.to_string());
            }
        };
        state
            .store
            .record_sync_success(&account_id, &folder, chrono::Utc::now().timestamp())
            .map_err(|error| error.to_string())?;
        Ok(result)
    } else {
        Err("Folder sync is currently available for IMAP accounts.".into())
    }
}

/// Folders with per-folder unread/total counts for the sidebar.
#[tauri::command]
fn folders(account_id: String, state: State<'_, AppState>) -> Vec<store::FolderInfo> {
    state.store.folders(&account_id)
}

/// Mark a thread read/unread. Persists locally, then best-effort pushes to the
/// provider (Gmail UNREAD label / Graph isRead). Provider failures don't fail the
/// action — the local store is the source of truth.
#[tauri::command]
async fn set_thread_read(
    thread_id: String,
    account_id: String,
    unread: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .store
        .set_thread_read(&thread_id, unread)
        .map_err(|e| e.to_string())?;
    if account_id.starts_with("gmail:") {
        let _ = sync::gmail::set_read(&account_id, &thread_id, unread).await;
    } else if account_id.starts_with("ms:") {
        let _ = sync::microsoft::set_read(&account_id, &thread_id, unread).await;
    }
    Ok(())
}

/// Archive a thread (remove from all smart views; Gmail removes INBOX, Graph moves
/// to the Archive folder).
#[tauri::command]
async fn archive_thread(
    thread_id: String,
    account_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .store
        .set_thread_views(&thread_id, &[])
        .map_err(|e| e.to_string())?;
    if account_id.starts_with("gmail:") {
        let _ = sync::gmail::archive(&account_id, &thread_id).await;
    } else if account_id.starts_with("ms:") {
        let _ = sync::microsoft::move_conversation(&account_id, &thread_id, "archive").await;
    }
    Ok(())
}

/// Snooze: a client-side smart view (no provider concept), persisted locally.
#[tauri::command]
fn snooze_thread(thread_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state
        .store
        .set_thread_views(&thread_id, &["snoozed".to_string()])
        .map_err(|e| e.to_string())
}

/// Delete a thread: soft-delete tombstone locally (survives re-sync), then
/// best-effort move to the provider's Trash.
#[tauri::command]
async fn delete_thread(
    thread_id: String,
    account_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .store
        .tombstone_thread(&thread_id)
        .map_err(|e| e.to_string())?;
    if account_id.starts_with("gmail:") {
        let _ = sync::gmail::trash(&account_id, &thread_id).await;
    } else if account_id.starts_with("ms:") {
        let _ = sync::microsoft::move_conversation(&account_id, &thread_id, "deleteditems").await;
    }
    Ok(())
}

/// Move a thread to another mailbox. Local-first: the folder is updated locally
/// immediately (so it leaves the current view), then the IMAP server move runs
/// best-effort. Currently real folders exist only for IMAP accounts.
#[tauri::command]
async fn move_thread(
    thread_id: String,
    account_id: String,
    to_folder: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Run the server move FIRST (it needs the thread's source folder + Message-IDs,
    // which it reads from the still-present row), then tombstone locally so the
    // thread leaves the current view without leaving a stale duplicate behind —
    // the destination folder shows it again on its next sync.
    let mut server_err: Option<String> = None;
    if account_id.starts_with("imap:") {
        if let Err(e) = sync::imap::move_thread_async(
            state.store.clone(),
            account_id,
            thread_id.clone(),
            to_folder,
        )
        .await
        {
            server_err = Some(e.to_string());
        }
    }
    state
        .store
        .tombstone_thread(&thread_id)
        .map_err(|e| e.to_string())?;
    match server_err {
        Some(e) => Err(format!(
            "Removed from this folder, but the server move failed: {e}"
        )),
        None => Ok(()),
    }
}

/// Report a thread as spam/junk: tombstone locally, then best-effort move to the
/// provider's junk mailbox (Gmail SPAM label / Graph junkemail / IMAP Junk folder).
#[tauri::command]
async fn mark_spam(
    thread_id: String,
    account_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .store
        .tombstone_thread(&thread_id)
        .map_err(|e| e.to_string())?;
    if account_id.starts_with("gmail:") {
        let _ = sync::gmail::spam(&account_id, &thread_id).await;
    } else if account_id.starts_with("ms:") {
        let _ = sync::microsoft::move_conversation(&account_id, &thread_id, "junkemail").await;
    } else if account_id.starts_with("imap:") {
        // Find the account's Junk mailbox (by role), default to "Junk".
        let junk = state
            .store
            .folders(&account_id)
            .into_iter()
            .find(|f| f.role.as_deref() == Some("junk"))
            .map(|f| f.name)
            .unwrap_or_else(|| "Junk".into());
        let _ =
            sync::imap::move_thread_async(state.store.clone(), account_id, thread_id, junk).await;
    }
    Ok(())
}

/// Flag / unflag a thread: update the local flag mirror and, for IMAP accounts,
/// push the `\Flagged` keyword to the server so the star round-trips with other
/// mail clients. The local flag is always set first, so it works offline.
#[tauri::command]
async fn flag_thread(
    thread_id: String,
    account_id: String,
    flagged: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if account_id.starts_with("imap:") {
        sync::imap::flag_thread_async(state.store.clone(), account_id, thread_id, flagged)
            .await
            .map_err(|e| e.to_string())?;
    } else {
        state
            .store
            .set_thread_flag(&thread_id, flagged)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// All flagged thread ids (local mirror, which the IMAP sync keeps in step with
/// the server's `\Flagged` keyword). The frontend merges these into its view.
#[tauri::command]
fn flagged_ids(state: State<'_, AppState>) -> Vec<String> {
    state.store.flagged_thread_ids()
}

/// The build id baked into the CURRENT binary's embedded `index.html`. The loaded
/// frontend compares this with its own compiled-in `__BUILD_ID__`; a mismatch
/// means the WebView replayed a stale cached shell, so the frontend triggers one
/// cache-busting reload. Returns None in dev (assets are served by the vite dev
/// server, not embedded), where the check is intentionally skipped.
#[tauri::command]
fn expected_build_id(app: tauri::AppHandle) -> Option<String> {
    let asset = app
        .asset_resolver()
        .get("index.html".to_string())
        .or_else(|| app.asset_resolver().get("/index.html".to_string()))?;
    let html = String::from_utf8_lossy(&asset.bytes);
    let anchor = html.find("name=\"bharga-build\"")?;
    let after = &html[anchor..];
    let start = after.find("content=\"")? + "content=\"".len();
    let rest = &after[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// Fetch an attachment and return it as a data: URL for inline preview
/// (images/PDF rendered in a modal without writing to disk).
#[tauri::command]
async fn preview_attachment(
    account_id: String,
    message_id: String,
    name: String,
    mime: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if !account_id.starts_with("imap:") {
        return Err("Preview is currently available for IMAP accounts.".into());
    }
    let bytes =
        sync::imap::fetch_attachment_async(state.store.clone(), account_id, message_id, name)
        .await
        .map_err(|e| e.to_string())?;
    use base64::{engine::general_purpose::STANDARD, Engine};
    Ok(format!("data:{};base64,{}", mime, STANDARD.encode(&bytes)))
}

/// Download an inbound attachment's bytes from the provider, save it to the OS
/// Downloads folder, and open it. Returns the saved path.
#[tauri::command]
async fn download_attachment(
    app: tauri::AppHandle,
    account_id: String,
    message_id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let bytes = if account_id.starts_with("imap:") {
        sync::imap::fetch_attachment_async(
            state.store.clone(),
            account_id.clone(),
            message_id,
            name.clone(),
        )
            .await
            .map_err(|e| e.to_string())?
    } else {
        return Err("Attachment download is currently available for IMAP accounts.".into());
    };
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir())
        .unwrap_or_else(|_| std::env::temp_dir());
    std::fs::create_dir_all(&dir).ok();
    // SECURITY: `name` is attacker-controlled (the sender sets the attachment's
    // Content-Disposition filename). `Path::join` would let an *absolute* name
    // replace the download dir entirely, and `../` segments would traverse out —
    // a malicious email could otherwise write arbitrary bytes anywhere and (via
    // the `open` below) get them executed. Reduce to a bare basename and confirm
    // the result stays inside the download dir.
    let safe_name = std::path::Path::new(&name)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty() && s != "." && s != "..")
        .unwrap_or_else(|| "attachment".to_string());
    let path = dir.join(&safe_name);
    if path.parent() != Some(dir.as_path()) {
        return Err("Invalid attachment name.".into());
    }
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    // Only auto-open well-known, non-executable document/image types. Anything
    // else is merely revealed in Finder so we never execute untrusted content.
    #[cfg(target_os = "macos")]
    {
        const OPENABLE: &[&str] = &[
            "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "txt", "md", "csv", "doc",
            "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key", "ics", "vcf",
        ];
        let ext = std::path::Path::new(&safe_name)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let mut cmd = std::process::Command::new("open");
        if !OPENABLE.contains(&ext.as_str()) {
            cmd.arg("-R"); // reveal in Finder instead of executing
        }
        let _ = cmd.arg(&path).spawn();
    }
    Ok(path.to_string_lossy().to_string())
}

/// Open the local store, but never let a bad/incompatible on-disk database crash
/// the whole app at launch. If the first open fails (corrupt file, a migration
/// error, an incompatible legacy schema), we move the old DB aside and start
/// fresh — the cache re-syncs from the server, and the app stays open.
fn open_store_resilient(dir: &std::path::Path) -> Store {
    let db = dir.join("bharga.db");
    match Store::open(db.clone()) {
        Ok(s) => return s,
        Err(e) => log::error!("store open failed ({e}); moving DB aside and recreating"),
    }
    // Move the unreadable DB (and its WAL/SHM sidecars) out of the way.
    let stamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
    for suffix in ["", "-wal", "-shm"] {
        let from = dir.join(format!("bharga.db{suffix}"));
        if from.exists() {
            let _ = std::fs::rename(
                &from,
                dir.join(format!("bharga.corrupt-{stamp}.db{suffix}")),
            );
        }
    }
    Store::open(db).expect("failed to create a fresh local database")
}

/// Validate untrusted email links again at the native boundary before handing
/// them to the operating system. The WebView is never allowed to navigate.
fn normalized_external_web_url(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.chars().any(|character| character.is_control() || character == '\\') {
        return Err("External link contains disallowed characters".into());
    }
    let (scheme, authority_and_path) = value
        .split_once("://")
        .ok_or_else(|| "External link must be an absolute web URL".to_string())?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Err("External link scheme is not allowed".into());
    }
    let authority = authority_and_path
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    if authority.is_empty() || authority.chars().any(char::is_whitespace) {
        return Err("External link host is invalid".into());
    }
    let url = reqwest::Url::parse(value).map_err(|_| "External link is malformed".to_string())?;
    if url.host_str().is_none()
        || !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("External link host or scheme is invalid".into());
    }
    Ok(url.to_string())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let destination = normalized_external_web_url(&url)?;
    open::that(destination).map_err(|error| format!("Could not open link: {error}"))
}

#[cfg(test)]
mod external_url_tests {
    use super::normalized_external_web_url;

    #[test]
    fn accepts_only_absolute_http_and_https_urls() {
        assert_eq!(
            normalized_external_web_url("https://Example.com/path").unwrap(),
            "https://example.com/path"
        );
        assert!(normalized_external_web_url("http://example.test/path").is_ok());
        assert!(normalized_external_web_url("http://[::1]:8080/path").is_ok());
        assert!(normalized_external_web_url("https://xn--bcher-kva.example/").is_ok());
        for blocked in [
            "javascript:alert(1)",
            "data:text/html,hello",
            "file:///tmp/private",
            "mailto:person@example.test",
            "/relative/path",
            "not a URL",
            "https://user:password@example.test/private",
            "https://example.test\\@evil.test/path",
            "https://exa\tmple.test/path",
            "https://example.test/path\nfragment",
        ] {
            assert!(normalized_external_web_url(blocked).is_err(), "accepted {blocked}");
        }
    }
}

#[cfg(test)]
mod account_removal_tests {
    use super::{compare_legacy_imap_credentials, plan_imap_secret_updates, remove_account_from_store};
    use crate::store::Store;

    #[test]
    fn credential_failure_leaves_account_visible_for_retry() {
        let store = Store::in_memory().unwrap();
        store
            .upsert_account("imap:test@example.test", "test@example.test", "imap", "Test")
            .unwrap();

        let result = remove_account_from_store(&store, "imap:test@example.test", |_| {
            Err("credential cleanup failed".into())
        });

        assert!(result.is_err());
        assert_eq!(store.accounts().len(), 1);
    }

    #[test]
    fn verified_cleanup_allows_account_deletion() {
        let store = Store::in_memory().unwrap();
        store
            .upsert_account("imap:test@example.test", "test@example.test", "imap", "Test")
            .unwrap();

        remove_account_from_store(&store, "imap:test@example.test", |_| Ok(())).unwrap();

        assert!(store.accounts().is_empty());
    }

    #[test]
    fn new_separate_smtp_credentials_require_a_password() {
        let result = plan_imap_secret_updates(
            false,
            false,
            None,
            false,
            "smtp-user",
            "imap-password",
            None,
            None,
            false,
        );
        assert_eq!(result.unwrap_err(), "A separate SMTP password is required");
    }

    #[test]
    fn switching_to_shared_credentials_replaces_the_old_smtp_password() {
        let updates = plan_imap_secret_updates(
            true,
            false,
            Some("old-smtp-user"),
            true,
            "imap-user",
            "",
            None,
            Some("saved-imap-password"),
            true,
        )
        .unwrap();
        assert_eq!(updates, vec![("smtp-pass", "saved-imap-password".to_string())]);
    }

    #[test]
    fn changing_a_separate_smtp_username_requires_a_new_password() {
        let result = plan_imap_secret_updates(
            true,
            false,
            Some("old-smtp-user"),
            false,
            "new-smtp-user",
            "",
            None,
            Some("saved-imap-password"),
            true,
        );
        assert_eq!(result.unwrap_err(), "A separate SMTP password is required");
    }

    #[test]
    fn legacy_same_username_with_distinct_passwords_remains_separate() {
        assert!(!compare_legacy_imap_credentials(Some("incoming"), Some("outgoing")).unwrap());
        assert!(compare_legacy_imap_credentials(Some("shared"), Some("shared")).unwrap());
        assert!(compare_legacy_imap_credentials(Some("incoming"), None).is_err());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("bharga".into()),
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            std::fs::create_dir_all(&dir).ok();
            let store = Arc::new(open_store_resilient(&dir));
            // DB-backed secret fallback so credentials survive unsigned-app rebuilds.
            sync::tokens::init_db(store.clone());
            // Restore the saved AI profile (models/roles/endpoints) from the DB;
            // fall back to defaults on first run.
            let mut ai_profile = store
                .settings()
                .get("ai_profile")
                .and_then(|s| serde_json::from_str::<AiProfile>(s).ok())
                .unwrap_or_else(default_profile);
            refresh_ai_readiness(&mut ai_profile);
            app.manage(AppState {
                ai: Mutex::new(ai_profile),
                store: store.clone(),
            });

            // Background outbox flusher: owns an Arc<Store> clone (Send), so the
            // future is Send and nothing borrows Tauri State across .await.
            let flush_store = store.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    let _ = sync::outbox::flush(&flush_store).await;
                }
            });

            // Background live-sync: polls every account's inbox and emits
            // `mail:sync` / `mail:new` events so the UI refreshes and can notify.
            let live_store = store.clone();
            let live_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                sync::live::run(live_app, live_store).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_ai_profile,
            set_ai_privacy,
            save_ai_provider,
            test_ai_provider,
            remove_ai_provider,
            ai_draft_reply,
            ai_summarize,
            ai_phishing_check,
            ai_ask_inbox,
            ai_triage_inbox,
            reindex_embeddings,
            list_threads,
            search_mail,
            expected_build_id,
            list_accounts,
            get_settings,
            set_setting,
            list_tasks,
            list_events,
            set_task_done,
            create_task,
            queue_send,
            cancel_send,
            list_outbox,
            flush_outbox,
            connect_gmail,
            connect_microsoft,
            test_imap_account,
            save_imap_account,
            get_imap_account,
            remove_account,
            rename_account,
            sync_now,
            load_older,
            list_folders,
            create_folder,
            rename_folder,
            delete_folder,
            sync_folder,
            folders,
            set_thread_read,
            archive_thread,
            snooze_thread,
            delete_thread,
            move_thread,
            mark_spam,
            flag_thread,
            flagged_ids,
            download_attachment,
            preview_attachment,
            open_external_url,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // macOS convention: the red "close" button hides the window and
                // leaves the app running in the Dock — only ⌘Q (or the app menu's
                // Quit) terminates. The window is re-shown when the user clicks the
                // Dock icon (RunEvent::Reopen, below). Other platforms keep the
                // default (closing the last window quits).
                #[cfg(target_os = "macos")]
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Bharga Mail")
        .run(|_app, _event| {
            // Dock-icon click after the window was closed → bring it back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                if let Some(window) = _app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
}
