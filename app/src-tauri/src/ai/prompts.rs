//! Prompt construction for each AI task. Kept separate so prompts can evolve
//! (and later incorporate the user's learned writing style) without touching
//! transport or routing code.

use super::ChatMessage;

fn sys(content: &str) -> ChatMessage {
    ChatMessage { role: "system".into(), content: content.into() }
}
fn user(content: String) -> ChatMessage {
    ChatMessage { role: "user".into(), content }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn triage_parses_tags() {
        let t = parse_triage("PRIORITY URGENT MEETING");
        assert!(t.priority);
        assert!(t.labels.contains(&"urgent".to_string()));
        assert!(t.labels.contains(&"meeting".to_string()));

        let n = parse_triage("NORMAL NEWSLETTER");
        assert!(!n.priority);
        assert_eq!(n.labels, vec!["newsletter".to_string()]);
    }
}

/// Draft a reply to a thread. `style` is the user's learned tone profile (optional).
pub fn draft_reply(thread_text: &str, style: Option<&str>) -> Vec<ChatMessage> {
    let mut system = String::from(
        "You are an email assistant. Write a concise, friendly reply to the email below. \
         Match the sender's register. Return only the reply body, no subject or signature.",
    );
    if let Some(s) = style {
        system.push_str(&format!(" Write in this person's style: {s}"));
    }
    vec![sys(&system), user(format!("Email thread:\n\n{thread_text}"))]
}

/// Summarize a thread into 1–2 sentences plus any deadlines/asks.
pub fn summarize(thread_text: &str) -> Vec<ChatMessage> {
    vec![
        sys("Summarize the email thread in 1–2 sentences. Surface any deadline, decision needed, or explicit ask. Be terse."),
        user(format!("Thread:\n\n{thread_text}")),
    ]
}

/// Classify a thread for the priority inbox. The model is asked to answer with
/// keywords we can parse deterministically (see `parse_triage`).
pub fn triage(thread_text: &str) -> Vec<ChatMessage> {
    vec![
        sys("Classify this email. Reply with space-separated tags from exactly this set: \
             PRIORITY or NORMAL; optionally URGENT; optionally MEETING; optionally RECEIPT; optionally NEWSLETTER. \
             Reply with only the tags, nothing else."),
        user(format!("Email:\n\n{thread_text}")),
    ]
}

/// Deterministically parse the triage model's keyword output.
pub fn parse_triage(text: &str) -> Triage {
    let up = text.to_uppercase();
    let mut labels = Vec::new();
    if up.contains("URGENT") {
        labels.push("urgent".to_string());
    }
    if up.contains("MEETING") {
        labels.push("meeting".to_string());
    }
    if up.contains("RECEIPT") {
        labels.push("receipt".to_string());
    }
    if up.contains("NEWSLETTER") {
        labels.push("newsletter".to_string());
    }
    let priority = up.contains("PRIORITY") || up.contains("URGENT");
    Triage { priority, labels }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Triage {
    pub priority: bool,
    pub labels: Vec<String>,
}

/// "Ask my inbox" answer over retrieved context (RAG). `context` is the
/// concatenation of the top retrieved messages.
pub fn ask_inbox(query: &str, context: &str) -> Vec<ChatMessage> {
    vec![
        sys("Answer the user's question using only the provided email excerpts. \
             Cite which email each fact came from. If the answer isn't present, say so."),
        user(format!("Question: {query}\n\nRelevant emails:\n{context}")),
    ]
}
