// Central app configuration. No magic numbers or literals scattered across the
// codebase — change behaviour here, not in component bodies.

export const APP = {
  name: "Bharga Mail",
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
    // Current-generation defaults (each is overridable per-provider in Settings).
    anthropic: "claude-sonnet-5-5",
    "openai-compatible": "gpt-5.1",
    google: "gemini-3-pro-preview",
    local: "llama3.2",
  },
} as const;
