/// <reference types="vite/client" />

// Unique per-build id, injected by vite (see vite.config.ts). Compared against
// the core's embedded id to detect and recover from a stale WebView-cached shell.
declare const __BUILD_ID__: string;
