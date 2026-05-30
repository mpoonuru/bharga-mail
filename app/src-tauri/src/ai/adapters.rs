//! Provider adapters. Each implements [`AiProvider`] with real HTTP via `reqwest`.
//!
//! The single highest-leverage adapter is [`OpenAiCompatibleProvider`]: a base URL +
//! key unlocks OpenAI, OpenRouter, Groq, Together, vLLM, LM Studio, and most
//! enterprise gateways with one implementation. [`LocalProvider`] targets Ollama
//! (`/api/chat`) for free, offline, private inference.

use async_trait::async_trait;
use serde_json::{json, Value};

use super::{AiError, AiProvider, Capabilities, ChatMessage};

fn http() -> reqwest::Client {
    reqwest::Client::new()
}

fn to_openai_messages(messages: &[ChatMessage]) -> Vec<Value> {
    messages
        .iter()
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect()
}

// ---------- OpenAI-compatible (OpenAI, OpenRouter, Groq, vLLM, LM Studio, …) ----------

pub struct OpenAiCompatibleProvider {
    pub id: String,
    pub base_url: String, // e.g. https://api.openai.com/v1
    pub api_key: Option<String>,
    pub model: String,
    pub caps: Capabilities,
}

#[async_trait]
impl AiProvider for OpenAiCompatibleProvider {
    fn id(&self) -> &str {
        &self.id
    }
    fn capabilities(&self) -> &Capabilities {
        &self.caps
    }

    async fn chat(&self, messages: &[ChatMessage]) -> Result<String, AiError> {
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let body = json!({ "model": self.model, "messages": to_openai_messages(messages) });
        let mut req = http().post(&url).json(&body);
        if let Some(key) = &self.api_key {
            req = req.bearer_auth(key);
        }
        let resp = req.send().await.map_err(|e| AiError::Request(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(AiError::Request(format!("HTTP {}", resp.status())));
        }
        let v: Value = resp.json().await.map_err(|e| AiError::Request(e.to_string()))?;
        v["choices"][0]["message"]["content"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| AiError::Request("unexpected response shape".into()))
    }

    async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, AiError> {
        let url = format!("{}/embeddings", self.base_url.trim_end_matches('/'));
        let body = json!({ "model": self.model, "input": texts });
        let mut req = http().post(&url).json(&body);
        if let Some(key) = &self.api_key {
            req = req.bearer_auth(key);
        }
        let resp = req.send().await.map_err(|e| AiError::Request(e.to_string()))?;
        let v: Value = resp.json().await.map_err(|e| AiError::Request(e.to_string()))?;
        let data = v["data"].as_array().ok_or_else(|| AiError::Request("no data".into()))?;
        Ok(data
            .iter()
            .filter_map(|d| {
                d["embedding"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|x| x.as_f64().map(|f| f as f32)).collect())
            })
            .collect())
    }
}

// ---------- Anthropic (Claude) ----------

pub struct AnthropicProvider {
    pub id: String,
    pub api_key: Option<String>,
    pub model: String,
    pub caps: Capabilities,
}

#[async_trait]
impl AiProvider for AnthropicProvider {
    fn id(&self) -> &str {
        &self.id
    }
    fn capabilities(&self) -> &Capabilities {
        &self.caps
    }

    async fn chat(&self, messages: &[ChatMessage]) -> Result<String, AiError> {
        let key = self
            .api_key
            .as_ref()
            .ok_or_else(|| AiError::NotConfigured("anthropic api key".into()))?;
        // Anthropic takes `system` separately from the message array.
        let system: String = messages
            .iter()
            .filter(|m| m.role == "system")
            .map(|m| m.content.clone())
            .collect::<Vec<_>>()
            .join("\n");
        let msgs: Vec<Value> = messages
            .iter()
            .filter(|m| m.role != "system")
            .map(|m| json!({ "role": m.role, "content": m.content }))
            .collect();
        let body = json!({
            "model": self.model,
            "max_tokens": 1024,
            "system": system,
            "messages": msgs,
        });
        let resp = http()
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
            .map_err(|e| AiError::Request(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(AiError::Request(format!("HTTP {}", resp.status())));
        }
        let v: Value = resp.json().await.map_err(|e| AiError::Request(e.to_string()))?;
        v["content"][0]["text"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| AiError::Request("unexpected response shape".into()))
    }
}

// ---------- Local (Ollama / llama.cpp / LM Studio) ----------

pub struct LocalProvider {
    pub id: String,
    pub base_url: String, // e.g. http://localhost:11434
    pub model: String,
    pub caps: Capabilities,
}

#[async_trait]
impl AiProvider for LocalProvider {
    fn id(&self) -> &str {
        &self.id
    }
    fn capabilities(&self) -> &Capabilities {
        &self.caps
    }

    async fn chat(&self, messages: &[ChatMessage]) -> Result<String, AiError> {
        // Ollama chat API. (LM Studio exposes an OpenAI-compatible endpoint instead.)
        let url = format!("{}/api/chat", self.base_url.trim_end_matches('/'));
        let body = json!({ "model": self.model, "messages": to_openai_messages(messages), "stream": false });
        let resp = http().post(&url).json(&body).send().await.map_err(|e| AiError::Request(e.to_string()))?;
        let v: Value = resp.json().await.map_err(|e| AiError::Request(e.to_string()))?;
        v["message"]["content"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| AiError::Request("unexpected response shape".into()))
    }

    async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, AiError> {
        let url = format!("{}/api/embed", self.base_url.trim_end_matches('/'));
        let body = json!({ "model": self.model, "input": texts });
        let resp = http().post(&url).json(&body).send().await.map_err(|e| AiError::Request(e.to_string()))?;
        let v: Value = resp.json().await.map_err(|e| AiError::Request(e.to_string()))?;
        let arr = v["embeddings"].as_array().ok_or_else(|| AiError::Request("no embeddings".into()))?;
        Ok(arr
            .iter()
            .filter_map(|e| e.as_array().map(|a| a.iter().filter_map(|x| x.as_f64().map(|f| f as f32)).collect()))
            .collect())
    }
}
