// Central app configuration. No magic numbers or literals scattered across the
// codebase — change behaviour here, not in component bodies.

export const APP = {
  name: "Aether Mail",
  tagline: "Your mail. Your model. Your machine.",
} as const;

export const SEND = {
  /** Undo-Send window in seconds: the message stays in the outbox until this elapses. */
  undoWindowSeconds: 10,
} as const;

export const DEV = {
  /** Vite dev server port (must match vite.config.ts and tauri.conf.json devUrl). */
  port: 1420,
} as const;

/** Default endpoints / model ids per provider kind (overridable per-account in Settings). */
export const AI_DEFAULTS = {
  ollamaEndpoint: "http://localhost:11434",
  openAiEndpoint: "https://api.openai.com/v1",
  models: {
    anthropic: "claude-sonnet-4-6",
    "openai-compatible": "gpt-4o",
    google: "gemini-1.5-pro",
    local: "llama3",
  },
} as const;
