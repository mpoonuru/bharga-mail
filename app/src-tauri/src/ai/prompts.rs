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

    #[test]
    fn phishing_parses_verdict() {
        let v = parse_phishing("VERDICT=phishing CONFIDENCE=92 REASON=Urgent account-suspension lure.");
        assert_eq!(v.level, "phishing");
        assert_eq!(v.confidence, 92);
        assert_eq!(v.reason, "Urgent account-suspension lure");

        // Tolerant fallback when the model doesn't follow the format exactly.
        let s = parse_phishing("This looks safe to me.");
        assert_eq!(s.level, "safe");
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

/// Phase-2 phishing judgment. The deterministic scanner (frontend `linkRisk`)
/// catches link tells; this asks the model to judge the message *intent*
/// (social engineering, credential/payment harvesting) which rules can't see.
/// Runs on the local Triage model — private, no API cost.
pub fn phishing_check(message_text: &str, links: &str) -> Vec<ChatMessage> {
    vec![
        sys("You are an email security analyst. Decide whether the email is a phishing or social-engineering \
             attempt. Weigh: urgency or threats (account suspension, deadlines), requests to verify/log in/pay, \
             credential or payment harvesting, and deceptive or mismatched links. \
             Reply on ONE line in EXACTLY this format and nothing else: \
             VERDICT=<phishing|suspicious|safe> CONFIDENCE=<0-100> REASON=<one short sentence>"),
        user(format!("Flagged links:\n{links}\n\nEmail:\n{message_text}")),
    ]
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PhishingVerdict {
    /// "phishing" | "suspicious" | "safe"
    pub level: String,
    /// 0–100
    pub confidence: u8,
    pub reason: String,
}

/// Parse the model's single-line phishing verdict, tolerantly.
pub fn parse_phishing(text: &str) -> PhishingVerdict {
    let field = |key: &str| -> Option<String> {
        let i = text.to_uppercase().find(key)?;
        let rest = &text[i + key.len()..];
        Some(rest.trim_start().to_string())
    };
    let up = text.to_uppercase();
    let level = field("VERDICT=")
        .map(|v| v.split_whitespace().next().unwrap_or("").to_lowercase())
        .filter(|v| v == "phishing" || v == "suspicious" || v == "safe")
        .unwrap_or_else(|| {
            if up.contains("PHISHING") { "phishing".into() }
            else if up.contains("SUSPICIOUS") { "suspicious".into() }
            else { "safe".into() }
        });
    let confidence = field("CONFIDENCE=")
        .and_then(|v| v.split(|c: char| !c.is_ascii_digit()).next().map(str::to_string))
        .and_then(|n| n.parse::<u32>().ok())
        .map(|n| n.min(100) as u8)
        .unwrap_or(match level.as_str() { "phishing" => 85, "suspicious" => 60, _ => 10 });
    let reason = field("REASON=")
        .map(|s| s.trim().trim_matches(|c| c == '"' || c == '.').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "No specific reason given.".into());
    PhishingVerdict { level, confidence, reason }
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
