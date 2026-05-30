//! Plug-and-play AI engine.
//!
//! The whole app talks to the [`AiProvider`] trait — never to a vendor SDK.
//! Each provider is an adapter behind this trait, so features (triage, summarize,
//! draft, ask) never know which model is running. Users bring their own models:
//! cloud APIs, any OpenAI-compatible endpoint, or a local runtime.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

pub mod adapters;
pub mod prompts;
pub mod router;
pub mod search;

/// What kind of backend a model speaks to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    Anthropic,
    /// OpenAI itself, plus OpenRouter, Groq, Together, vLLM, LM Studio server, most gateways.
    OpenAiCompatible,
    Google,
    /// Ollama / llama.cpp / LM Studio running locally.
    Local,
    /// Arbitrary base URL + auth (Azure OpenAI, Bedrock proxy, internal LLM).
    Custom,
}

/// Roles a model can be assigned to (per-task routing).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    Triage,
    Embeddings,
    Summarize,
    Draft,
    Agent,
}

/// What a given model can do — probed on add, used for graceful degradation.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Capabilities {
    pub context_tokens: u32,
    pub tool_calling: bool,
    pub vision: bool,
    pub embeddings: bool,
    pub streaming: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfig {
    pub id: String,
    pub label: String,
    pub kind: ProviderKind,
    pub roles: Vec<Role>,
    pub ready: bool,
    pub endpoint: Option<String>,
    /// Provider-specific model id (e.g. "gpt-4o", "llama3"). Optional; sensible default per kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Looked up via the OS keychain, never persisted in plaintext or sent to our servers.
    #[serde(skip)]
    pub api_key: Option<String>,
    pub caps: Capabilities,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Privacy {
    Cloud,
    Hybrid,
    Local,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiProfile {
    pub name: String,
    pub privacy: Privacy,
    pub models: Vec<ModelConfig>,
}

// ---- the provider contract every adapter implements ----

#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub role: String, // "system" | "user" | "assistant"
    pub content: String,
}

#[derive(Debug, thiserror::Error)]
pub enum AiError {
    #[error("provider not configured: {0}")]
    NotConfigured(String),
    #[error("capability unsupported: {0}")]
    Unsupported(String),
    #[error("request failed: {0}")]
    Request(String),
}

/// Uniform interface. Add a new backend = implement this once.
#[async_trait]
pub trait AiProvider: Send + Sync {
    fn id(&self) -> &str;
    fn capabilities(&self) -> &Capabilities;

    async fn chat(&self, messages: &[ChatMessage]) -> Result<String, AiError>;

    async fn embed(&self, _texts: &[String]) -> Result<Vec<Vec<f32>>, AiError> {
        Err(AiError::Unsupported("embeddings".into()))
    }
}

/// Build a live provider from a model's config. The single place that maps
/// a [`ModelConfig`] to a concrete [`AiProvider`] implementation.
pub fn build_provider(m: &ModelConfig) -> Box<dyn AiProvider> {
    use adapters::{AnthropicProvider, LocalProvider, OpenAiCompatibleProvider};
    let model_name = m.model_name();
    match m.kind {
        ProviderKind::Anthropic => Box::new(AnthropicProvider {
            id: m.id.clone(),
            api_key: m.api_key.clone(),
            model: model_name,
            caps: m.caps.clone(),
        }),
        ProviderKind::Local => Box::new(LocalProvider {
            id: m.id.clone(),
            base_url: m.endpoint.clone().unwrap_or_else(|| "http://localhost:11434".into()),
            model: model_name,
            caps: m.caps.clone(),
        }),
        // OpenAI itself, plus OpenRouter/Groq/Together/vLLM/LM Studio/custom gateways.
        ProviderKind::OpenAiCompatible | ProviderKind::Google | ProviderKind::Custom => {
            Box::new(OpenAiCompatibleProvider {
                id: m.id.clone(),
                base_url: m.endpoint.clone().unwrap_or_else(|| "https://api.openai.com/v1".into()),
                api_key: m.api_key.clone(),
                model: model_name,
                caps: m.caps.clone(),
            })
        }
    }
}

impl ModelConfig {
    /// The provider-specific model identifier to send on the wire.
    /// Falls back to a sensible default per kind when the user hasn't named one.
    fn model_name(&self) -> String {
        if let Some(name) = &self.model {
            return name.clone();
        }
        match self.kind {
            ProviderKind::Anthropic => "claude-sonnet-4-6",
            ProviderKind::OpenAiCompatible => "gpt-4o",
            ProviderKind::Google => "gemini-1.5-pro",
            ProviderKind::Local => "llama3",
            ProviderKind::Custom => "default",
        }
        .to_string()
    }
}

/// Default profile shipped on first run: one local + one cloud, hybrid routing.
pub fn default_profile() -> AiProfile {
    AiProfile {
        name: "Hybrid (private)".into(),
        privacy: Privacy::Hybrid,
        models: vec![
            ModelConfig {
                id: "claude".into(),
                label: "Claude (Anthropic)".into(),
                kind: ProviderKind::Anthropic,
                roles: vec![Role::Draft, Role::Agent, Role::Summarize],
                ready: false,
                endpoint: None,
                model: Some("claude-sonnet-4-6".into()),
                api_key: None,
                caps: Capabilities { context_tokens: 200_000, tool_calling: true, vision: true, embeddings: false, streaming: true },
            },
            ModelConfig {
                id: "llama".into(),
                label: "Llama 3 8B · local".into(),
                kind: ProviderKind::Local,
                roles: vec![Role::Triage, Role::Embeddings],
                ready: false,
                endpoint: Some("http://localhost:11434".into()),
                model: Some("llama3".into()),
                api_key: None,
                caps: Capabilities { context_tokens: 8192, tool_calling: false, vision: false, embeddings: true, streaming: true },
            },
        ],
    }
}
