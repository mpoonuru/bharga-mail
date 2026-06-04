//! Bharga Mail — Rust core.
//! Exposes typed Tauri commands the React UI calls via IPC. The UI only ever
//! talks to the local store; the sync engine reconciles it with providers.

pub mod ai;
pub mod store;
pub mod sync;

use std::sync::{Arc, Mutex};

use ai::{build_provider, default_profile, prompts, router::Router, AiProfile, Role};
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
    state.ai.lock().unwrap().clone()
}

#[tauri::command]
fn set_ai_profile(profile: AiProfile, state: State<'_, AppState>) -> Result<(), String> {
    // Persist to the durable settings store so the AI engine config survives
    // restarts (UI prefs and AI config both live in the DB, not just in memory).
    if let Ok(json) = serde_json::to_string(&profile) {
        let _ = state.store.set_setting("ai_profile", &json);
    }
    *state.ai.lock().unwrap() = profile;
    Ok(())
}

fn model_for(state: &State<'_, AppState>, role: Role) -> Option<ai::ModelConfig> {
    let profile = state.ai.lock().unwrap();
    Router::new(&profile).resolve(role).cloned()
}

/// Embed text using the model assigned to the Embeddings role.
async fn embed_one(model: &ai::ModelConfig, text: &str) -> Option<Vec<f32>> {
    let provider = build_provider(model);
    provider.embed(&[text.to_string()]).await.ok()?.into_iter().next()
}

#[tauri::command]
async fn ai_draft_reply(thread_id: String, thread_text: String, state: State<'_, AppState>) -> Result<String, String> {
    let model = model_for(&state, Role::Draft).ok_or("No model assigned to the Draft role. Add one in Settings.")?;
    let provider = build_provider(&model);
    let _ = thread_id;
    provider.chat(&prompts::draft_reply(&thread_text, None)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn ai_summarize(thread_text: String, state: State<'_, AppState>) -> Result<String, String> {
    let model = model_for(&state, Role::Summarize).ok_or("No model assigned to Summarize.")?;
    let provider = build_provider(&model);
    provider.chat(&prompts::summarize(&thread_text)).await.map_err(|e| e.to_string())
}

/// Phase-2 phishing verdict from the local Triage model (private, no API cost).
/// Returns the parsed verdict as JSON: { level, confidence, reason }.
#[tauri::command]
async fn ai_phishing_check(thread_text: String, links: String, state: State<'_, AppState>) -> Result<String, String> {
    let model = model_for(&state, Role::Triage)
        .or_else(|| model_for(&state, Role::Summarize))
        .ok_or("No model assigned to Triage. Add one in Settings.")?;
    let out = build_provider(&model)
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
    let summarize_model = model_for(&state, Role::Summarize).or_else(|| model_for(&state, Role::Agent));
    let triage_model = model_for(&state, Role::Triage).or_else(|| model_for(&state, Role::Summarize));
    if summarize_model.is_none() && triage_model.is_none() {
        return Err("Assign Summarize/Triage models in Settings.".into());
    }

    let mut processed = 0;
    for t in state.store.unsummarized_threads() {
        let text = format!(
            "Subject: {}\n{}",
            t.subject,
            t.messages.iter().map(|m| store::strip_html(&m.body_html)).collect::<Vec<_>>().join("\n")
        );

        if let Some(m) = &summarize_model {
            if let Ok(summary) = build_provider(m).chat(&prompts::summarize(&text)).await {
                let _ = state.store.set_ai_artifacts(&t.id, Some(&summary), None);
            }
        }
        if let Some(m) = &triage_model {
            if let Ok(out) = build_provider(m).chat(&prompts::triage(&text)).await {
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
    let provider = build_provider(&model);
    provider.chat(&prompts::ask_inbox(&query, &context)).await.map_err(|e| e.to_string())
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
    state.store.set_setting(&key, &value).map_err(|e| e.to_string())
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
    state.store.set_task_done(&id, done).map_err(|e| e.to_string())
}

/// Create a task, optionally linked to the email thread it came from.
#[tauri::command]
fn create_task(title: String, source_thread_id: Option<String>, state: State<'_, AppState>) -> Result<String, String> {
    let id = format!("k-{}", chrono::Utc::now().timestamp_millis());
    state
        .store
        .add_task(&Task { id: id.clone(), title, due: None, done: false }, source_thread_id.as_deref())
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
    state.store.enqueue_outbox(&item).map_err(|e| e.to_string())?;
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
    sync::gmail::connect(&state.store).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn connect_microsoft(state: State<'_, AppState>) -> Result<String, String> {
    sync::microsoft::connect(&state.store).await.map_err(|e| e.to_string())
}

/// Full IMAP/SMTP account setup with separate incoming/outgoing servers,
/// security modes, and (optionally distinct) credentials.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImapAccountInput {
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
    smtp_username: Option<String>,
    smtp_password: Option<String>,
}

/// Test IMAP + SMTP connectivity with the entered settings, without saving.
#[tauri::command]
async fn test_imap_account(input: ImapAccountInput) -> Result<String, String> {
    let imap_user = input.imap_username.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| input.email.clone());
    let imap_host = input.imap_host.clone();
    let imap_port = input.imap_port;
    let imap_sec = Security::parse(&input.imap_security);
    let imap_pass = input.imap_password.clone();
    tokio::task::spawn_blocking(move || sync::imap::test_login(&imap_host, imap_port, imap_sec, &imap_user, &imap_pass))
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

#[tauri::command]
fn save_imap_account(input: ImapAccountInput, state: State<'_, AppState>) -> Result<String, String> {
    let account_id = format!("imap:{}", input.email);
    let imap_user = input.imap_username.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| input.email.clone());
    let smtp_user = input.smtp_username.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| imap_user.clone());
    // SMTP password defaults to the IMAP password when not provided separately.
    let smtp_pass = input.smtp_password.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| input.imap_password.clone());

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
    };
    state.store.upsert_imap_account(&acct).map_err(|e| e.to_string())?;
    state.store.upsert_account(&account_id, &input.email, "imap", &acct.display_name).map_err(|e| e.to_string())?;
    // On edit, an empty password means "keep the existing one" — don't overwrite.
    if !input.imap_password.is_empty() {
        sync::tokens::save_secret(&account_id, "imap-pass", &input.imap_password);
    }
    if !smtp_pass.is_empty() {
        sync::tokens::save_secret(&account_id, "smtp-pass", &smtp_pass);
    }
    Ok(account_id)
}

/// Saved IMAP/SMTP settings for an account (no password — used to pre-fill the
/// edit form).
#[tauri::command]
fn get_imap_account(account_id: String, state: State<'_, AppState>) -> Option<ImapAccount> {
    state.store.imap_account(&account_id)
}

/// Remove an account and all of its data (threads, messages, embeddings, config),
/// and clear its stored credentials.
#[tauri::command]
fn remove_account(account_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.store.delete_account(&account_id).map_err(|e| e.to_string())?;
    sync::tokens::clear(&account_id);
    Ok(())
}

/// Sync an account's inbox. Returns the number of messages stored (so the UI can
/// distinguish "synced 0" from a connection failure).
#[tauri::command]
async fn sync_now(account_id: String, group: Option<bool>, state: State<'_, AppState>) -> Result<usize, String> {
    if account_id.starts_with("ms:") {
        sync::microsoft::incremental(&state.store, &account_id).await.map(|_| 0).map_err(|e| e.to_string())
    } else if account_id.starts_with("imap:") {
        sync::imap::fetch_folder_async(state.store.clone(), account_id, "INBOX".into(), 75, group.unwrap_or(true), false)
            .await
            .map_err(|e| e.to_string())
    } else {
        sync::gmail::incremental(&state.store, &account_id).await.map(|_| 0).map_err(|e| e.to_string())
    }
}

/// Backfill: pull OLDER messages for a folder by re-seeding the most-recent
/// `count` (force_full bypasses the incremental cursor). Returns messages stored.
#[tauri::command]
async fn load_older(account_id: String, folder: String, count: u32, group: Option<bool>, state: State<'_, AppState>) -> Result<usize, String> {
    if account_id.starts_with("imap:") {
        sync::imap::fetch_folder_async(state.store.clone(), account_id, folder, count, group.unwrap_or(true), true)
            .await
            .map_err(|e| e.to_string())
    } else {
        Err("Loading older mail is currently available for IMAP accounts.".into())
    }
}

/// Enumerate an IMAP account's folders (mailboxes) and return them.
#[tauri::command]
async fn list_folders(account_id: String, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    if account_id.starts_with("imap:") {
        sync::imap::list_folders_async(state.store.clone(), account_id).await.map_err(|e| e.to_string())
    } else {
        Ok(vec!["INBOX".into()]) // Gmail/Graph folder browsing is a later milestone.
    }
}

/// Create a new IMAP mailbox (folder).
#[tauri::command]
async fn create_folder(account_id: String, name: String, state: State<'_, AppState>) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Folder name can't be empty.".into());
    }
    if !account_id.starts_with("imap:") {
        return Err("Folder management is currently available for IMAP accounts.".into());
    }
    sync::imap::manage_folder_async(state.store.clone(), account_id, sync::imap::FolderAction::Create(name))
        .await.map_err(|e| e.to_string())
}

/// Rename an IMAP mailbox (folder).
#[tauri::command]
async fn rename_folder(account_id: String, from: String, to: String, state: State<'_, AppState>) -> Result<(), String> {
    let to = to.trim().to_string();
    if to.is_empty() {
        return Err("Folder name can't be empty.".into());
    }
    if !account_id.starts_with("imap:") {
        return Err("Folder management is currently available for IMAP accounts.".into());
    }
    sync::imap::manage_folder_async(state.store.clone(), account_id, sync::imap::FolderAction::Rename(from, to))
        .await.map_err(|e| e.to_string())
}

/// Delete an IMAP mailbox (folder). The server removes the mailbox and its mail.
#[tauri::command]
async fn delete_folder(account_id: String, name: String, state: State<'_, AppState>) -> Result<(), String> {
    if name.eq_ignore_ascii_case("INBOX") {
        return Err("The Inbox can't be deleted.".into());
    }
    if !account_id.starts_with("imap:") {
        return Err("Folder management is currently available for IMAP accounts.".into());
    }
    sync::imap::manage_folder_async(state.store.clone(), account_id, sync::imap::FolderAction::Delete(name))
        .await.map_err(|e| e.to_string())
}

/// Sync a specific folder for an IMAP account. Returns messages stored.
#[tauri::command]
async fn sync_folder(account_id: String, folder: String, group: Option<bool>, state: State<'_, AppState>) -> Result<usize, String> {
    if account_id.starts_with("imap:") {
        sync::imap::fetch_folder_async(state.store.clone(), account_id, folder, 75, group.unwrap_or(true), false)
            .await
            .map_err(|e| e.to_string())
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
async fn set_thread_read(thread_id: String, account_id: String, unread: bool, state: State<'_, AppState>) -> Result<(), String> {
    state.store.set_thread_read(&thread_id, unread).map_err(|e| e.to_string())?;
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
async fn archive_thread(thread_id: String, account_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.store.set_thread_views(&thread_id, &[]).map_err(|e| e.to_string())?;
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
    state.store.set_thread_views(&thread_id, &["snoozed".to_string()]).map_err(|e| e.to_string())
}

/// Delete a thread: soft-delete tombstone locally (survives re-sync), then
/// best-effort move to the provider's Trash.
#[tauri::command]
async fn delete_thread(thread_id: String, account_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.store.tombstone_thread(&thread_id).map_err(|e| e.to_string())?;
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
async fn move_thread(thread_id: String, account_id: String, to_folder: String, state: State<'_, AppState>) -> Result<(), String> {
    // Run the server move FIRST (it needs the thread's source folder + Message-IDs,
    // which it reads from the still-present row), then tombstone locally so the
    // thread leaves the current view without leaving a stale duplicate behind —
    // the destination folder shows it again on its next sync.
    let mut server_err: Option<String> = None;
    if account_id.starts_with("imap:") {
        if let Err(e) = sync::imap::move_thread_async(state.store.clone(), account_id, thread_id.clone(), to_folder).await {
            server_err = Some(e.to_string());
        }
    }
    state.store.tombstone_thread(&thread_id).map_err(|e| e.to_string())?;
    match server_err {
        Some(e) => Err(format!("Removed from this folder, but the server move failed: {e}")),
        None => Ok(()),
    }
}

/// Report a thread as spam/junk: tombstone locally, then best-effort move to the
/// provider's junk mailbox (Gmail SPAM label / Graph junkemail / IMAP Junk folder).
#[tauri::command]
async fn mark_spam(thread_id: String, account_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.store.tombstone_thread(&thread_id).map_err(|e| e.to_string())?;
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
        let _ = sync::imap::move_thread_async(state.store.clone(), account_id, thread_id, junk).await;
    }
    Ok(())
}

/// Flag / unflag a thread: update the local flag mirror and, for IMAP accounts,
/// push the `\Flagged` keyword to the server so the star round-trips with other
/// mail clients. The local flag is always set first, so it works offline.
#[tauri::command]
async fn flag_thread(thread_id: String, account_id: String, flagged: bool, state: State<'_, AppState>) -> Result<(), String> {
    if account_id.starts_with("imap:") {
        sync::imap::flag_thread_async(state.store.clone(), account_id, thread_id, flagged)
            .await
            .map_err(|e| e.to_string())?;
    } else {
        state.store.set_thread_flag(&thread_id, flagged).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// All flagged thread ids (local mirror, which the IMAP sync keeps in step with
/// the server's `\Flagged` keyword). The frontend merges these into its view.
#[tauri::command]
fn flagged_ids(state: State<'_, AppState>) -> Vec<String> {
    state.store.flagged_thread_ids()
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
    let bytes = sync::imap::fetch_attachment_async(state.store.clone(), account_id, message_id, name)
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
        sync::imap::fetch_attachment_async(state.store.clone(), account_id.clone(), message_id, name.clone())
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
            "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "txt", "md",
            "csv", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers",
            "key", "ics", "vcf",
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
            let _ = std::fs::rename(&from, dir.join(format!("bharga.corrupt-{stamp}.db{suffix}")));
        }
    }
    Store::open(db).expect("failed to create a fresh local database")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: Some("bharga".into()) }),
                ])
                .build(),
        )
        .setup(|app| {
            let dir = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir());
            std::fs::create_dir_all(&dir).ok();
            let store = Arc::new(open_store_resilient(&dir));
            // DB-backed secret fallback so credentials survive unsigned-app rebuilds.
            sync::tokens::init_db(store.clone());
            // Restore the saved AI profile (models/roles/endpoints) from the DB;
            // fall back to defaults on first run.
            let ai_profile = store
                .settings()
                .get("ai_profile")
                .and_then(|s| serde_json::from_str::<AiProfile>(s).ok())
                .unwrap_or_else(default_profile);
            app.manage(AppState { ai: Mutex::new(ai_profile), store: store.clone() });

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
            set_ai_profile,
            ai_draft_reply,
            ai_summarize,
            ai_phishing_check,
            ai_ask_inbox,
            ai_triage_inbox,
            reindex_embeddings,
            list_threads,
            search_mail,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Bharga Mail");
}
